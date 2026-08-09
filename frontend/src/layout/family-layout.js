/**
 * Household-based layout prototype for Family Archive.
 * Preview-wired via ?layout=prototype (PrototypeFamilyTreeChart).
 * Does not use Family Chart private APIs. Never writes coords to trees.data.
 *
 * Placement pipeline:
 *   household blocks → multi-candidate ordering (spouse-side + family affinity)
 *   → routing → parallel lanes → line-jumps for unavoidable crossings
 */

import { routeLayoutLinks } from './link-routing.js';
import {
  buildPlacementCandidates,
  compareCandidateScores,
  extractPlacementSnapshot,
} from './placement-optimizer.js';
import {
  collectPlacementMetrics,
  householdOrderingByGeneration,
  summarizeCandidateRow,
} from './placement-metrics.js';

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function personMap(people) {
  return new Map(people.map((person) => [String(person.id), person]));
}

function spouseIds(person) {
  return unique(person?.rels?.spouses);
}

function parentIds(person) {
  return unique(person?.rels?.parents);
}

function childIds(person) {
  return unique(person?.rels?.children);
}

function closeUnderMarriage(visible, byId) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...visible]) {
      for (const spouseId of spouseIds(byId.get(id))) {
        if (byId.has(spouseId) && !visible.has(spouseId)) {
          visible.add(spouseId);
          changed = true;
        }
      }
    }
  }
}

/**
 * Visible set around center: spouse-symmetric family area.
 *
 * 1) Couple core = center ∪ direct spouses(center).
 * 2) For each core person: ancestry + progeny + siblings.
 * 3) Close under marriage (spouses of everyone already visible).
 * 4) For each displayed sibling of the couple core, include direct parents
 *    of that sibling's displayed spouses (one parent level only — not
 *    grandparents, not that spouse's siblings).
 * 5) Close under marriage again for newly added parents.
 * 6) Deduplicate by id.
 *
 * Switching center between spouses keeps the same couple core, so the same
 * sibling households and the same one-level in-law parents are included.
 */
export function selectVisiblePeople(
  people,
  centerId,
  { ancestryDepth = 8, progenyDepth = 8 } = {},
) {
  const byId = personMap(people);
  const center = byId.get(String(centerId));
  if (!center) return [];

  const visible = new Set();

  function walkParents(id, depth) {
    if (depth <= 0) return;
    for (const parentId of parentIds(byId.get(id))) {
      if (!byId.has(parentId) || visible.has(parentId)) continue;
      visible.add(parentId);
      walkParents(parentId, depth - 1);
    }
  }

  function walkChildren(id, depth) {
    if (depth <= 0) return;
    for (const childId of childIds(byId.get(id))) {
      if (!byId.has(childId) || visible.has(childId)) continue;
      visible.add(childId);
      walkChildren(childId, depth - 1);
    }
  }

  function addPersonalFamilyArea(seedId) {
    const seed = String(seedId);
    if (!byId.has(seed)) return;
    visible.add(seed);
    walkParents(seed, ancestryDepth);
    walkChildren(seed, progenyDepth);
    for (const parentId of parentIds(byId.get(seed))) {
      for (const siblingId of childIds(byId.get(parentId))) {
        if (byId.has(siblingId)) visible.add(siblingId);
      }
    }
  }

  const coupleCore = unique([String(centerId), ...spouseIds(center)]);
  for (const id of coupleCore) addPersonalFamilyArea(id);
  closeUnderMarriage(visible, byId);

  // Sibling-spouse direct parents (one level): e.g. p010 → sibling p007 → spouse p008 → father p009.
  const coupleCoreSet = new Set(coupleCore);
  const siblingsOfCore = new Set();
  for (const coreId of coupleCore) {
    for (const parentId of parentIds(byId.get(coreId))) {
      for (const siblingId of childIds(byId.get(parentId))) {
        if (!coupleCoreSet.has(siblingId) && visible.has(siblingId)) {
          siblingsOfCore.add(siblingId);
        }
      }
    }
  }
  for (const siblingId of siblingsOfCore) {
    for (const spouseId of spouseIds(byId.get(siblingId))) {
      if (!visible.has(spouseId)) continue;
      for (const parentId of parentIds(byId.get(spouseId))) {
        if (byId.has(parentId)) visible.add(parentId);
      }
    }
  }
  closeUnderMarriage(visible, byId);

  return [...visible]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/**
 * Generation indices relative to center. Parent/child and spouse edges are
 * traversed so in-laws from the couple-symmetric visible set stay aligned.
 */
function assignGenerations(people, centerId) {
  const byId = personMap(people);
  const generation = new Map([[String(centerId), 0]]);
  const queue = [String(centerId)];

  while (queue.length) {
    const id = queue.shift();
    const g = generation.get(id);
    const person = byId.get(id);
    for (const parentId of parentIds(person)) {
      if (!byId.has(parentId) || generation.has(parentId)) continue;
      generation.set(parentId, g - 1);
      queue.push(parentId);
    }
    for (const childId of childIds(person)) {
      if (!byId.has(childId) || generation.has(childId)) continue;
      generation.set(childId, g + 1);
      queue.push(childId);
    }
    for (const spouseId of spouseIds(person)) {
      if (!byId.has(spouseId) || generation.has(spouseId)) continue;
      generation.set(spouseId, g);
      queue.push(spouseId);
    }
  }

  for (const person of people) {
    if (!generation.has(person.id)) generation.set(person.id, 0);
  }

  return generation;
}

/**
 * Build households: each person appears in exactly one household together with
 * their visible spouses. Household width is known before placement.
 */
export function buildHouseholds(people) {
  const byId = personMap(people);
  const assigned = new Set();
  const households = [];

  const ordered = [...people].sort((left, right) => left.id.localeCompare(right.id));
  for (const person of ordered) {
    if (assigned.has(person.id)) continue;
    const members = [person.id];
    assigned.add(person.id);
    for (const spouseId of spouseIds(person).sort()) {
      if (!byId.has(spouseId) || assigned.has(spouseId)) continue;
      members.push(spouseId);
      assigned.add(spouseId);
    }
    members.sort((left, right) => {
      const gLeft = String(byId.get(left)?.data?.gender || '');
      const gRight = String(byId.get(right)?.data?.gender || '');
      const rank = { M: 0, F: 1, '': 2 };
      return (rank[gLeft] ?? 2) - (rank[gRight] ?? 2) || left.localeCompare(right);
    });
    households.push({
      id: `hh:${members.slice().sort().join('+')}`,
      memberIds: members,
      size: members.length,
    });
  }

  return households.sort((left, right) => left.id.localeCompare(right.id));
}

function buildDraftLinks(visible, nodeById) {
  const draftLinks = [];
  const spouseSeen = new Set();
  const parentSeen = new Set();

  for (const person of visible) {
    for (const spouseId of spouseIds(person)) {
      if (!nodeById.has(spouseId)) continue;
      const key = [person.id, spouseId].sort().join('|');
      if (spouseSeen.has(key)) continue;
      spouseSeen.add(key);
      draftLinks.push({
        type: 'spouse',
        source: person.id,
        target: spouseId,
        points: [],
      });
    }
    for (const parentId of parentIds(person)) {
      if (!nodeById.has(parentId)) continue;
      const key = `${parentId}->${person.id}`;
      if (parentSeen.has(key)) continue;
      parentSeen.add(key);
      draftLinks.push({
        type: 'parent-child',
        source: parentId,
        target: person.id,
        points: [],
      });
    }
  }

  draftLinks.sort((left, right) => {
    const leftKey = `${left.type}:${left.source}:${left.target}`;
    const rightKey = `${right.type}:${right.source}:${right.target}`;
    return leftKey.localeCompare(rightKey);
  });
  return draftLinks;
}

function materializeCandidateLayout({
  visible,
  generation,
  candidate,
  cardWidth,
  cardHeight,
  orientation,
}) {
  const householdByMember = new Map();
  for (const household of candidate.households) {
    for (const memberId of household.memberIds) householdByMember.set(memberId, household);
  }

  const nodes = visible
    .map((person) => {
      const position = candidate.nodePositions.get(person.id) || { x: 0, y: 0 };
      const household = householdByMember.get(person.id);
      return {
        id: person.id,
        x: position.x,
        y: position.y,
        generation: generation.get(person.id) ?? 0,
        householdId: household?.id,
        gender: person.data?.gender || '',
        width: cardWidth,
        height: cardHeight,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const draftLinks = buildDraftLinks(visible, nodeById);
  const links = routeLayoutLinks(
    { nodes, links: draftLinks, households: candidate.households },
    { orientation },
  );

  return {
    nodes,
    links,
    households: candidate.households,
    spouseSide: candidate.spouseSide,
    candidateId: candidate.candidateId,
    generationOrders: candidate.generationOrders,
  };
}

/**
 * Household-first layout with multi-candidate placement optimization.
 * Coordinates are final before links are built; routing never moves nodes.
 */
export function layoutFamilyTree(
  people,
  {
    centerId,
    cardWidth = 184,
    cardHeight = 170,
    orientation = 'vertical',
    nodeSeparation = 236,
    levelSeparation = 224,
    ancestryDepth = 8,
    progenyDepth = 8,
    returnCandidates = false,
    previousLayout = null,
  } = {},
) {
  if (!Array.isArray(people) || !people.length) {
    return { nodes: [], links: [], households: [], meta: { centerId, orientation } };
  }

  const visible = selectVisiblePeople(people, centerId, { ancestryDepth, progenyDepth });
  const generation = assignGenerations(visible, centerId);
  const households = buildHouseholds(visible);
  const peopleById = personMap(visible);
  const previousSnapshot = previousLayout ? extractPlacementSnapshot(previousLayout) : null;

  const isHorizontal = orientation === 'horizontal';
  const crossStep = isHorizontal ? levelSeparation : nodeSeparation;
  const generationStep = isHorizontal ? nodeSeparation : levelSeparation;
  const cardCross = isHorizontal ? cardHeight : cardWidth;
  const gap = Math.max(0, crossStep - cardCross);

  const candidates = buildPlacementCandidates({
    households,
    generationMap: generation,
    peopleById,
    centerId,
    cardCross,
    gap,
    generationStep,
    isHorizontal,
    previousSnapshot,
  });

  const expectedVisibleIds = visible.map((person) => person.id);
  const canonicalOrderKey = [...households]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((household) => household.id)
    .join('|');

  const scored = [];
  for (const candidate of candidates) {
    const layout = materializeCandidateLayout({
      visible,
      generation,
      candidate,
      cardWidth,
      cardHeight,
      orientation,
    });
    layout.meta = {
      centerId: String(centerId),
      spouseSide: candidate.spouseSide,
      branchOrderByGeneration: candidate.branchOrderByGeneration,
    };
    const metrics = collectPlacementMetrics(people, layout, {
      expectedVisibleIds,
      households: layout.households,
      canonicalOrderKey,
      spouseSide: candidate.spouseSide,
      householdToBranch: candidate.householdToBranch,
      previousSnapshot,
    });
    metrics.spouseSide = candidate.spouseSide;
    metrics.candidateId = candidate.candidateId;
    metrics.preferredSideMatch = candidate.preferredSideMatch;
    scored.push({ candidate, layout, metrics });
  }

  scored.sort((left, right) =>
    compareCandidateScores(
      {
        ...left.metrics,
        candidateId: left.candidate.candidateId,
        preferredSideMatch: left.candidate.preferredSideMatch,
      },
      {
        ...right.metrics,
        candidateId: right.candidate.candidateId,
        preferredSideMatch: right.candidate.preferredSideMatch,
      },
    ),
  );

  const winner = scored[0];
  const nodes = winner.layout.nodes;
  const links = winner.layout.links;
  const placedHouseholds = winner.layout.households.map((household) => ({
    ...household,
    branchId: winner.candidate.householdToBranch?.get(household.id)?.id || null,
  }));

  const result = {
    nodes,
    links,
    households: placedHouseholds.map((household) => ({
      id: household.id,
      memberIds: household.memberIds,
      size: household.size,
      generation: household.generation,
      side: household.side,
      branchId: household.branchId,
      x0: household.x0,
      x1: household.x1,
    })),
    meta: {
      centerId: String(centerId),
      orientation,
      cardWidth,
      cardHeight,
      nodeSeparation,
      levelSeparation,
      visibleCount: nodes.length,
      inputCount: people.length,
      spouseSide: winner.candidate.spouseSide,
      candidateId: winner.candidate.candidateId,
      generationOrders: winner.candidate.generationOrders,
      branchOrderByGeneration: winner.candidate.branchOrderByGeneration,
      branches: winner.candidate.branches,
      householdOrdering: householdOrderingByGeneration(
        placedHouseholds,
        winner.candidate.branchOrderByGeneration,
      ),
      placementCost: winner.metrics.totalCost,
      hardViolations: winner.metrics.hardViolations,
      familySideViolations: winner.metrics.familySideViolations,
      branchIntegrityViolations: winner.metrics.branchIntegrityViolations,
      existingHouseholdsSideChanges: winner.metrics.existingHouseholdsSideChanges,
      existingBranchOrderInversions: winner.metrics.existingBranchOrderInversions,
      unexpectedCoupleFlip: winner.metrics.unexpectedCoupleFlip,
      crossings: winner.metrics.crossings,
      jumps: winner.metrics.jumps,
    },
  };

  if (returnCandidates) {
    result.meta.candidates = scored.map((entry) =>
      summarizeCandidateRow(entry.candidate.candidateId, {
        ...entry.metrics,
        spouseSide: entry.candidate.spouseSide,
      }),
    );
  }

  return result;
}

export { extractPlacementSnapshot };
