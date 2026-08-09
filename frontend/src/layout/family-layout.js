/**
 * Household-based layout prototype for Family Archive.
 * Preview-wired via ?layout=prototype (PrototypeFamilyTreeChart).
 * Does not use Family Chart private APIs. Never writes coords to trees.data.
 *
 * Four-phase pipeline:
 *   A) cross-axis household placement (family sides, ordering, spouse side)
 *   B) routing demand / lane conflict graph per generation gap
 *   C) dynamic generation spacing from required lane counts
 *   D) final routing (structured bus lanes → stem separation → jumps)
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
import {
  applyGenerationBaselines,
  computeGenerationBaselines,
  estimateRoutingDemand,
  finalizeRoutingPlan,
  ROUTING_EDGE_PADDING,
  ROUTING_LANE_GAP,
} from './routing-demand.js';

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
 * 4) Parent-sibling collateral (depth 1): for each displayed direct parent of
 *    the couple core, include that parent's direct siblings (aunts/uncles).
 *    Do NOT auto-include their children, cousins, or parents of their spouses.
 * 5) Close under marriage (spouses of newly added aunts/uncles).
 * 6) For each displayed sibling of the couple core, include direct parents
 *    of that sibling's displayed spouses (one parent level only).
 * 7) Close under marriage again for newly added parents.
 * 8) Deduplicate by id.
 *
 * Switching center between spouses keeps the same couple core, so the same
 * sibling / parent-sibling households are included.
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

  // Parent-sibling collateral (depth 1): siblings of direct parents of couple core.
  for (const coreId of coupleCore) {
    for (const parentId of parentIds(byId.get(coreId))) {
      if (!visible.has(parentId)) continue;
      for (const grandparentId of parentIds(byId.get(parentId))) {
        for (const auntUncleId of childIds(byId.get(grandparentId))) {
          if (auntUncleId === parentId) continue;
          if (byId.has(auntUncleId)) visible.add(auntUncleId);
        }
      }
    }
  }
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

/**
 * PHASE A→B→C→D for one placement candidate.
 * Cross-axis order comes from the candidate; generation-axis is recomputed
 * from routing demand so lanes never shrink into a fixed gap.
 */
function materializeCandidateLayout({
  visible,
  generation,
  candidate,
  cardWidth,
  cardHeight,
  orientation,
}) {
  const isHorizontal = orientation === 'horizontal';
  const cardAlong = isHorizontal ? cardWidth : cardHeight;
  const cardAlongHalf = cardAlong / 2;
  const householdByMember = new Map();
  for (const household of candidate.households) {
    for (const memberId of household.memberIds) householdByMember.set(memberId, household);
  }

  // Provisional nodes: cross-axis from Phase A, generation index attached.
  const provisionalNodes = visible
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

  const draftLinks = buildDraftLinks(
    visible,
    new Map(provisionalNodes.map((node) => [node.id, node])),
  );

  // PHASE B — lane demand from cross-axis spans (generation-axis not required).
  const demand = estimateRoutingDemand({
    nodes: provisionalNodes,
    links: draftLinks,
    orientation,
  });

  // PHASE C — whole generations move; card baselines from required lanes.
  const baselines = computeGenerationBaselines({
    generations: demand.generations,
    requiredLaneCountByGap: demand.requiredLaneCountByGap,
    cardAlongAxis: cardAlong,
    centerGeneration: 0,
  });
  const finalPositions = applyGenerationBaselines(
    candidate.nodePositions,
    generation,
    baselines,
    isHorizontal,
  );
  const routingPlan = finalizeRoutingPlan(demand, {
    baselines,
    cardAlongHalf,
    isHorizontal,
  });

  const nodes = provisionalNodes.map((node) => {
    const position = finalPositions.get(node.id) || { x: node.x, y: node.y };
    return { ...node, x: position.x, y: position.y };
  });

  // PHASE D — structured bus lanes, stem separation, jumps. Nodes stay fixed.
  const links = routeLayoutLinks(
    { nodes, links: draftLinks, households: candidate.households },
    { orientation, routingPlan },
  );

  // Keep household generation-axis metadata in sync with final baselines.
  const households = candidate.households.map((household) => ({
    ...household,
    generation:
      household.generation ?? Math.min(...household.memberIds.map((id) => generation.get(id) ?? 0)),
  }));

  return {
    nodes,
    links,
    households,
    spouseSide: candidate.spouseSide,
    candidateId: candidate.candidateId,
    generationOrders: candidate.generationOrders,
    routingPlan,
    baselines: Object.fromEntries(baselines),
  };
}

/**
 * Household-first layout with multi-candidate placement optimization.
 * After Phase C, node coordinates are final; routing never moves nodes.
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
    // previousLayout is accepted for optional stability *reporting* only.
    // Canonical geometry/routing must ignore it so cold === warm.
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
  // Snapshot kept only for post-hoc stability metrics — never feeds placement.
  const previousSnapshot = previousLayout ? extractPlacementSnapshot(previousLayout) : null;

  const isHorizontal = orientation === 'horizontal';
  const crossStep = isHorizontal ? levelSeparation : nodeSeparation;
  // Provisional generation step for Phase A only (cross-axis is independent).
  const generationStep = isHorizontal ? nodeSeparation : levelSeparation;
  const cardCross = isHorizontal ? cardHeight : cardWidth;
  const gap = Math.max(0, crossStep - cardCross);

  // PHASE A — cross-axis household candidates.
  const candidates = buildPlacementCandidates({
    households,
    generationMap: generation,
    peopleById,
    centerId,
    cardCross,
    gap,
    generationStep,
    isHorizontal,
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
      orientation,
      spouseSide: candidate.spouseSide,
      branchOrderByGeneration: candidate.branchOrderByGeneration,
      requiredLaneCountByGap: layout.routingPlan?.requiredLaneCountByGap || {},
      routingGapHeightByGap: layout.routingPlan?.routingGapHeightByGap || {},
      maxLaneCount: layout.routingPlan?.maxLaneCount || 0,
      totalLaneCount: layout.routingPlan?.totalLaneCount || 0,
      totalRoutingGapHeight: layout.routingPlan?.totalRoutingGapHeight || 0,
      generationBaselines: layout.baselines || {},
      routingConstants: { ROUTING_LANE_GAP, ROUTING_EDGE_PADDING },
    };
    const metrics = collectPlacementMetrics(people, layout, {
      expectedVisibleIds,
      households: layout.households,
      canonicalOrderKey,
      spouseSide: candidate.spouseSide,
      householdToBranch: candidate.householdToBranch,
      routingPlan: layout.routingPlan,
    });
    metrics.spouseSide = candidate.spouseSide;
    metrics.candidateId = candidate.candidateId;
    scored.push({ candidate, layout, metrics });
  }

  scored.sort((left, right) =>
    compareCandidateScores(
      { ...left.metrics, candidateId: left.candidate.candidateId },
      { ...right.metrics, candidateId: right.candidate.candidateId },
    ),
  );

  const winner = scored[0];
  const nodes = winner.layout.nodes;
  const links = winner.layout.links;
  const placedHouseholds = winner.layout.households.map((household) => ({
    ...household,
    branchId: winner.candidate.householdToBranch?.get(household.id)?.id || null,
  }));

  // Optional stability report vs previousLayout — never used for selection.
  const stabilityReport = previousSnapshot
    ? collectPlacementMetrics(
        people,
        {
          nodes,
          links,
          households: placedHouseholds,
          meta: {
            centerId: String(centerId),
            spouseSide: winner.candidate.spouseSide,
            branchOrderByGeneration: winner.candidate.branchOrderByGeneration,
          },
        },
        {
          expectedVisibleIds,
          households: placedHouseholds,
          spouseSide: winner.candidate.spouseSide,
          householdToBranch: winner.candidate.householdToBranch,
          previousSnapshot,
          routingPlan: winner.layout.routingPlan,
        },
      )
    : null;

  const plan = winner.layout.routingPlan;
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
      parentSiblingBranchSideViolations: winner.metrics.parentSiblingBranchSideViolations || 0,
      existingHouseholdsSideChanges: stabilityReport?.existingHouseholdsSideChanges || 0,
      existingBranchOrderInversions: stabilityReport?.existingBranchOrderInversions || 0,
      unexpectedCoupleFlip: stabilityReport?.unexpectedCoupleFlip || 0,
      crossings: winner.metrics.crossings,
      jumps: winner.metrics.jumps,
      parallelLaneOverlap: winner.metrics.parallelLaneOverlap || 0,
      parallelGapViolations: winner.metrics.parallelGapViolations || 0,
      minUnrelatedParallelGap: winner.metrics.minUnrelatedParallelGap ?? null,
      laneConflicts: winner.metrics.laneConflicts || 0,
      routingOutsideGenerationGap: winner.metrics.routingOutsideGenerationGap || 0,
      twoParentStemAnchoredToSpouseMidpoint:
        winner.metrics.twoParentStemAnchoredToSpouseMidpoint || 0,
      singleParentStemAnchoredToCardCenter:
        winner.metrics.singleParentStemAnchoredToCardCenter || 0,
      familyStemLaneShiftViolations: winner.metrics.familyStemLaneShiftViolations || 0,
      multipleStemsPerParentPair: winner.metrics.multipleStemsPerParentPair || 0,
      familyJunctionMismatch: winner.metrics.familyJunctionMismatch || 0,
      requiredLaneCountByGap: plan?.requiredLaneCountByGap || {},
      routingGapHeightByGap: plan?.routingGapHeightByGap || {},
      maxLaneCount: plan?.maxLaneCount || 0,
      totalLaneCount: plan?.totalLaneCount || 0,
      totalRoutingGapHeight: plan?.totalRoutingGapHeight || 0,
      generationBaselines: winner.layout.baselines || {},
      routingConstants: { ROUTING_LANE_GAP, ROUTING_EDGE_PADDING },
      coldWarmSignatureMismatch: 0,
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
