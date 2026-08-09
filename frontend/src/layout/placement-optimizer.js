/**
 * Hierarchical household placement optimizer.
 *
 * LEVEL 1: spouse-left / spouse-right (whole-side mirror)
 * LEVEL 2: family-side branch-block order (hard: no cross-side interleave)
 * LEVEL 3: household order inside each branch block
 * LEVEL 4: routing / lanes / jumps (elsewhere)
 *
 * Family-side integrity and branch-block integrity are HARD constraints.
 * Routing cost must not tear a spouse branch across the couple core.
 */

import { scorePlacementCandidate, compareCandidateScores } from './placement-cost.js';

const EXHAUSTIVE_BLOCK_LIMIT = 6;
const MAX_SWAP_PASSES = 8;
const MAX_BARYCENTER_ITERS = 4;

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
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

function householdWidth(household, cardCross, gap) {
  return household.size * cardCross + (household.size - 1) * gap;
}

function sortedById(items, keyFn = (item) => item.id) {
  return [...items].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

/**
 * Classify people into hard family sides around the couple core.
 */
export function classifyFamilyMembership(peopleById, centerId) {
  const center = String(centerId);
  const centerPerson = peopleById.get(center);
  const spouses = spouseIds(centerPerson);
  const coreIds = new Set(unique([center, ...spouses]));
  const spouseOnly = new Set(spouses);

  const centerAncestors = new Set();
  const spouseAncestors = new Set();
  const centerSiblings = new Set();
  const spouseSiblings = new Set();
  const centerSiblingSpouseParents = new Set();
  const spouseSiblingSpouseParents = new Set();
  const centerParentSiblings = new Set();
  const spouseParentSiblings = new Set();

  function walkAncestors(seedIds, into, depth = 8) {
    let frontier = [...seedIds];
    for (let d = 0; d < depth && frontier.length; d += 1) {
      const next = [];
      for (const id of frontier) {
        for (const parentId of parentIds(peopleById.get(id))) {
          if (!peopleById.has(parentId) || into.has(parentId) || coreIds.has(parentId)) continue;
          into.add(parentId);
          next.push(parentId);
        }
      }
      frontier = next;
    }
  }

  walkAncestors([center], centerAncestors);
  for (const spouseId of spouseOnly) walkAncestors([spouseId], spouseAncestors);

  function addSiblings(seedId, into) {
    for (const parentId of parentIds(peopleById.get(seedId))) {
      for (const siblingId of childIds(peopleById.get(parentId))) {
        if (coreIds.has(siblingId)) continue;
        if (peopleById.has(siblingId)) into.add(siblingId);
      }
    }
  }

  addSiblings(center, centerSiblings);
  for (const spouseId of spouseOnly) addSiblings(spouseId, spouseSiblings);

  function addSiblingSpouseParents(siblings, into) {
    for (const siblingId of siblings) {
      for (const sid of spouseIds(peopleById.get(siblingId))) {
        for (const parentId of parentIds(peopleById.get(sid))) {
          if (peopleById.has(parentId) && !coreIds.has(parentId)) into.add(parentId);
        }
      }
    }
  }

  addSiblingSpouseParents(centerSiblings, centerSiblingSpouseParents);
  addSiblingSpouseParents(spouseSiblings, spouseSiblingSpouseParents);

  // Direct siblings of direct parents (aunts/uncles), depth 1.
  function addParentSiblings(seedIds, into) {
    for (const seedId of seedIds) {
      for (const parentId of parentIds(peopleById.get(seedId))) {
        for (const grandparentId of parentIds(peopleById.get(parentId))) {
          for (const auntUncleId of childIds(peopleById.get(grandparentId))) {
            if (auntUncleId === parentId || coreIds.has(auntUncleId)) continue;
            if (peopleById.has(auntUncleId)) into.add(auntUncleId);
          }
        }
      }
    }
  }

  addParentSiblings([center], centerParentSiblings);
  for (const spouseId of spouseOnly) addParentSiblings([spouseId], spouseParentSiblings);

  const sideOfPerson = new Map();
  for (const id of coreIds) sideOfPerson.set(id, 'core');
  for (const id of spouseAncestors) sideOfPerson.set(id, 'spouse');
  for (const id of spouseSiblings) sideOfPerson.set(id, 'spouse');
  for (const id of spouseSiblingSpouseParents) sideOfPerson.set(id, 'spouse');
  for (const id of spouseParentSiblings) sideOfPerson.set(id, 'spouse');
  // Spouses of spouse-siblings / spouse-parent-siblings are spouse-side.
  for (const siblingId of [...spouseSiblings, ...spouseParentSiblings]) {
    for (const sid of spouseIds(peopleById.get(siblingId))) {
      if (!sideOfPerson.has(sid)) sideOfPerson.set(sid, 'spouse');
    }
  }
  for (const id of centerAncestors) {
    if (!sideOfPerson.has(id)) sideOfPerson.set(id, 'center');
  }
  for (const id of centerSiblings) sideOfPerson.set(id, 'center');
  for (const id of centerSiblingSpouseParents) {
    if (!sideOfPerson.has(id)) sideOfPerson.set(id, 'center');
  }
  for (const id of centerParentSiblings) sideOfPerson.set(id, 'center');
  for (const siblingId of [...centerSiblings, ...centerParentSiblings]) {
    for (const sid of spouseIds(peopleById.get(siblingId))) {
      if (!sideOfPerson.has(sid)) sideOfPerson.set(sid, 'center');
    }
  }

  // Remaining visible people: inherit from any spouse already classified, else neutral.
  for (const id of peopleById.keys()) {
    if (sideOfPerson.has(id)) continue;
    const mates = spouseIds(peopleById.get(id));
    const mateSide = mates.map((mate) => sideOfPerson.get(mate)).find(Boolean);
    sideOfPerson.set(id, mateSide || 'neutral');
  }

  return {
    coreIds,
    spouseOnly,
    centerAncestors,
    spouseAncestors,
    centerSiblings,
    spouseSiblings,
    centerSiblingSpouseParents,
    spouseSiblingSpouseParents,
    centerParentSiblings,
    spouseParentSiblings,
    sideOfPerson,
  };
}

/**
 * Classify households with hard side labels and branch membership.
 */
export function classifyHouseholdSides(households, peopleById, centerId) {
  const membership = classifyFamilyMembership(peopleById, centerId);
  const {
    sideOfPerson,
    coreIds,
    centerSiblings,
    spouseSiblings,
    centerParentSiblings,
    spouseParentSiblings,
  } = membership;

  return households.map((household) => {
    const members = household.memberIds;
    const sides = members.map((id) => sideOfPerson.get(id) || 'neutral');
    let side = 'neutral';
    if (sides.includes('core') || members.some((id) => coreIds.has(id))) side = 'core';
    else if (sides.includes('spouse') && !sides.includes('center')) side = 'spouse';
    else if (sides.includes('center') && !sides.includes('spouse')) side = 'center';
    else if (sides.includes('spouse')) side = 'spouse';
    else if (sides.includes('center')) side = 'center';

    let anchorId = members.includes(String(centerId))
      ? String(centerId)
      : members.find(
          (id) =>
            centerSiblings.has(id) ||
            spouseSiblings.has(id) ||
            centerParentSiblings.has(id) ||
            spouseParentSiblings.has(id),
        ) || members.slice().sort((a, b) => a.localeCompare(b))[0];

    return {
      ...household,
      side,
      anchorId,
      affinity: side === 'center' ? 1 : side === 'spouse' ? -1 : 0,
    };
  });
}

/**
 * Build nested family branch blocks (hard structural units).
 */
export function buildFamilyBranchBlocks(households, peopleById, centerId, generationMap) {
  const membership = classifyFamilyMembership(peopleById, centerId);
  const classified = classifyHouseholdSides(households, peopleById, centerId);
  const hhByMember = new Map();
  for (const household of classified) {
    for (const id of household.memberIds) hhByMember.set(id, household);
  }

  const branches = [];
  const assigned = new Set();

  function generationOf(household) {
    return Math.min(...household.memberIds.map((id) => generationMap.get(id) ?? 0));
  }

  function pushBranch({ id, side, kind, anchorId, householdList, canonicalKey }) {
    const uniqueHouseholds = [];
    const seen = new Set();
    for (const household of householdList) {
      if (!household || seen.has(household.id) || assigned.has(household.id)) continue;
      seen.add(household.id);
      assigned.add(household.id);
      uniqueHouseholds.push(household);
    }
    if (!uniqueHouseholds.length) return;
    branches.push({
      id,
      side,
      kind,
      anchorId,
      canonicalKey,
      households: uniqueHouseholds,
      generations: [...new Set(uniqueHouseholds.map(generationOf))].sort((a, b) => a - b),
    });
  }

  const coreHouseholds = classified.filter((household) => household.side === 'core');
  pushBranch({
    id: 'branch:core',
    side: 'core',
    kind: 'core',
    anchorId: String(centerId),
    householdList: coreHouseholds,
    canonicalKey: `0:core:${String(centerId)}`,
  });

  // Spouse / center parent households (direct ancestors of couple core).
  for (const [side, seeds, kind] of [
    ['spouse', membership.spouseOnly, 'parents'],
    ['center', [String(centerId)], 'parents'],
  ]) {
    const parentHouseholds = [];
    for (const seed of seeds) {
      for (const parentId of parentIds(peopleById.get(seed))) {
        const household = hhByMember.get(parentId);
        if (household && household.side === side) parentHouseholds.push(household);
      }
    }
    pushBranch({
      id: `branch:${side}-parents`,
      side,
      kind,
      anchorId: [...seeds].sort()[0] || side,
      householdList: sortedById(parentHouseholds),
      canonicalKey: `1:${side}:parents:${[...seeds].sort().join('+')}`,
    });
  }

  function siblingBranches(side, siblings, kind, keyRank) {
    for (const siblingId of [...siblings].sort((a, b) => a.localeCompare(b))) {
      const list = [];
      const siblingHh = hhByMember.get(siblingId);
      if (siblingHh) list.push(siblingHh);
      for (const sid of spouseIds(peopleById.get(siblingId))) {
        const spouseHh = hhByMember.get(sid);
        if (spouseHh && spouseHh.id !== siblingHh?.id) list.push(spouseHh);
        // Only for couple-core siblings: include in-law parents. Not for aunts/uncles.
        if (kind === 'sibling') {
          for (const parentId of parentIds(peopleById.get(sid))) {
            const parentHh = hhByMember.get(parentId);
            if (parentHh && parentHh.side === side) list.push(parentHh);
          }
        }
      }
      pushBranch({
        id: `branch:${side}-${kind}:${siblingId}`,
        side,
        kind,
        anchorId: siblingId,
        householdList: list,
        canonicalKey: `${keyRank}:${side}:${kind}:${siblingId}`,
      });
    }
  }

  // Parent-sibling (aunt/uncle) blocks stay with the parent's family side.
  siblingBranches('spouse', membership.spouseParentSiblings, 'parent-sibling', '1.5');
  siblingBranches('center', membership.centerParentSiblings, 'parent-sibling', '1.5');
  siblingBranches('spouse', membership.spouseSiblings, 'sibling', '2');
  siblingBranches('center', membership.centerSiblings, 'sibling', '2');

  // Any leftover households become singleton branches on their side.
  for (const household of sortedById(classified)) {
    if (assigned.has(household.id)) continue;
    pushBranch({
      id: `branch:singleton:${household.id}`,
      side: household.side,
      kind: 'singleton',
      anchorId: household.anchorId,
      householdList: [household],
      canonicalKey: `9:${household.side}:singleton:${household.id}`,
    });
  }

  const householdToBranch = new Map();
  for (const branch of branches) {
    for (const household of branch.households) {
      householdToBranch.set(household.id, branch);
    }
  }

  return { branches, classified, householdToBranch, membership };
}

/**
 * Hard: spouse-side and center-side households must form contiguous blocks
 * on opposite sides of the core; no interleaving across the couple.
 */
export function countFamilySideViolations(orderedHouseholds, spouseSide) {
  if (!orderedHouseholds?.length) return 0;
  const sides = orderedHouseholds.map((household) => household.side);
  const coreIndex = sides.findIndex((side) => side === 'core');
  if (coreIndex < 0) {
    // No core in this generation — still forbid spouse/center interleave.
    let flips = 0;
    let last = null;
    for (const side of sides) {
      if (side !== 'spouse' && side !== 'center') continue;
      if (last && last !== side) flips += 1;
      last = side;
    }
    return Math.max(0, flips - 1);
  }

  let violations = 0;
  for (let i = 0; i < orderedHouseholds.length; i += 1) {
    const side = sides[i];
    if (side === 'spouse') {
      if (spouseSide === 'left' && i > coreIndex) violations += 1;
      if (spouseSide === 'right' && i < coreIndex) violations += 1;
    }
    if (side === 'center') {
      if (spouseSide === 'left' && i < coreIndex) violations += 1;
      if (spouseSide === 'right' && i > coreIndex) violations += 1;
    }
  }

  // Contiguity: within left-of-core and right-of-core, side labels of spouse/center
  // must not alternate.
  const left = sides.slice(0, coreIndex).filter((side) => side === 'spouse' || side === 'center');
  const right = sides.slice(coreIndex + 1).filter((side) => side === 'spouse' || side === 'center');
  for (const block of [left, right]) {
    if (new Set(block).size > 1) violations += new Set(block).size - 1;
  }
  return violations;
}

/**
 * Hard: households that belong to the same branch must stay contiguous
 * inside their family side for each generation row.
 * Branches may span multiple generations; contiguity is checked per generation.
 */
export function countBranchIntegrityViolations(orderedHouseholds, householdToBranch) {
  if (!orderedHouseholds?.length || !householdToBranch) return 0;
  const byGen = new Map();
  for (const household of orderedHouseholds) {
    const g = household.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(household);
  }
  let violations = 0;
  for (const row of byGen.values()) {
    const seen = new Map();
    for (let i = 0; i < row.length; i += 1) {
      const household = row[i];
      const branch = householdToBranch.get(household.id);
      if (!branch) continue;
      const prev = seen.get(branch.id);
      if (prev == null) {
        seen.set(branch.id, { start: i, end: i });
        continue;
      }
      for (let j = prev.end + 1; j < i; j += 1) {
        const other = householdToBranch.get(row[j].id);
        if (other && other.id !== branch.id) {
          violations += 1;
          break;
        }
      }
      prev.end = i;
    }
  }
  return violations;
}

export function orderCoreHouseholdMembers(household, centerId, spouseSide, _peopleById) {
  const center = String(centerId);
  const spouses = household.memberIds
    .filter((id) => id !== center)
    .sort((a, b) => a.localeCompare(b));
  if (!spouses.length) return [center];
  if (spouses.length === 1) {
    if (spouseSide === 'right') return [center, spouses[0]];
    return [spouses[0], center];
  }
  const mid = Math.ceil(spouses.length / 2);
  const leftSpouses = spouseSide === 'right' ? spouses.slice(mid).reverse() : spouses.slice(0, mid);
  const rightSpouses = spouseSide === 'right' ? spouses.slice(0, mid) : spouses.slice(mid);
  const left = [...leftSpouses].sort((a, b) => a.localeCompare(b));
  const right = [...rightSpouses].sort((a, b) => a.localeCompare(b));
  if (spouseSide === 'right') return [...left.reverse(), center, ...right];
  return [...left, center, ...right];
}

export function orderNonCoreMembers(household, { outerIsLeft = false, peopleById = null } = {}) {
  const members = household.memberIds;
  if (members.length <= 1) return [...members];

  let hubId = null;
  if (peopleById) {
    for (const id of members) {
      const spouses = new Set(spouseIds(peopleById.get(id)));
      if (members.every((other) => other === id || spouses.has(other))) {
        hubId = id;
        break;
      }
    }
  }

  if (hubId && members.length > 2) {
    const others = members.filter((id) => id !== hubId).sort((a, b) => a.localeCompare(b));
    const mid = Math.ceil(others.length / 2);
    const left = outerIsLeft ? others.slice(0, mid) : others.slice(mid).reverse();
    const right = outerIsLeft ? others.slice(mid) : others.slice(0, mid);
    return [
      ...[...left].sort((a, b) => a.localeCompare(b)),
      hubId,
      ...[...right].sort((a, b) => a.localeCompare(b)),
    ];
  }

  const anchor = household.anchorId || members[0];
  const others = members.filter((id) => id !== anchor).sort((a, b) => a.localeCompare(b));
  if (!others.length) return [anchor];
  return outerIsLeft ? [...others, anchor] : [anchor, ...others];
}

/**
 * Canonical family-side row: spouse block | core | center block (or mirror).
 */
export function orderHouseholdsFamilySide(households, spouseSide) {
  const spouseBlock = households
    .filter((h) => h.side === 'spouse')
    .sort((a, b) => a.id.localeCompare(b.id));
  const coreBlock = households
    .filter((h) => h.side === 'core')
    .sort((a, b) => a.id.localeCompare(b.id));
  const centerBlock = households
    .filter((h) => h.side === 'center')
    .sort((a, b) => a.id.localeCompare(b.id));
  const neutral = households
    .filter((h) => h.side === 'neutral')
    .sort((a, b) => a.id.localeCompare(b.id));

  if (spouseSide === 'left') return [...spouseBlock, ...neutral, ...coreBlock, ...centerBlock];
  if (spouseSide === 'right') return [...centerBlock, ...neutral, ...coreBlock, ...spouseBlock];
  return [...households].sort((a, b) => a.id.localeCompare(b.id));
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([items[i], ...perm]);
  }
  return out;
}

function adjacentSwapOptimize(items, scoreFn) {
  let best = items.slice();
  let bestScore = scoreFn(best);
  let improved = true;
  let guard = 0;
  while (improved && guard < MAX_SWAP_PASSES) {
    improved = false;
    guard += 1;
    for (let i = 0; i < best.length - 1; i += 1) {
      const trial = best.slice();
      const tmp = trial[i];
      trial[i] = trial[i + 1];
      trial[i + 1] = tmp;
      const score = scoreFn(trial);
      if (
        score < bestScore ||
        (score === bestScore &&
          trial.map((item) => item.id).join('|') < best.map((item) => item.id).join('|'))
      ) {
        best = trial;
        bestScore = score;
        improved = true;
      }
    }
  }
  return best;
}

function householdsForBranchInGeneration(branch, generation, generationMap) {
  return branch.households.filter((household) => {
    const g = Math.min(...household.memberIds.map((id) => generationMap.get(id) ?? 0));
    return g === generation;
  });
}

function rowCrossingProxy(orderedHouseholds, generationMap, peopleById, neighborRows = []) {
  const pos = new Map(orderedHouseholds.map((household, index) => [household.id, index]));
  const memberToHh = new Map();
  for (const household of orderedHouseholds) {
    for (const id of household.memberIds) memberToHh.set(id, household.id);
  }
  let cost = 0;
  for (const household of orderedHouseholds) {
    for (const memberId of household.memberIds) {
      const person = peopleById.get(memberId);
      for (const childId of childIds(person)) {
        const childHh = memberToHh.get(childId);
        if (!childHh) continue;
        cost += Math.abs((pos.get(household.id) ?? 0) - (pos.get(childHh) ?? 0));
      }
    }
  }
  for (const neighbor of neighborRows || []) {
    const neighborPos = new Map(
      (neighbor.households || []).map((household, index) => [household.id, index]),
    );
    for (const household of orderedHouseholds) {
      for (const memberId of household.memberIds) {
        const person = peopleById.get(memberId);
        const g = generationMap.get(memberId) ?? 0;
        const relatedIds =
          neighbor.generation < g
            ? parentIds(person)
            : neighbor.generation > g
              ? childIds(person)
              : [];
        for (const otherId of relatedIds) {
          const otherHh = (neighbor.households || []).find((item) =>
            item.memberIds.includes(otherId),
          );
          if (!otherHh) continue;
          cost += Math.abs((pos.get(household.id) ?? 0) - (neighborPos.get(otherHh.id) ?? 0)) * 3;
        }
      }
    }
  }
  return cost;
}

function canonicalBranchOrder(branches, side, spouseSide) {
  // Outer → inner toward core for the side that sits outside.
  const list = branches
    .filter((branch) => branch.side === side)
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  // Prefer: extended / parent-sibling branches outer, parents closer to core.
  // parent-sibling must not sit between core and parents — that stretches child buses
  // under unrelated households.
  const rank = { singleton: 0, 'parent-sibling': 0.5, sibling: 1, parents: 2, core: 3 };
  list.sort((a, b) => {
    const ra = rank[a.kind] ?? 9;
    const rb = rank[b.kind] ?? 9;
    if (ra !== rb) {
      // For left spouse side, outer is left = lower index = sibling/extended first.
      return ra - rb;
    }
    return a.canonicalKey.localeCompare(b.canonicalKey);
  });

  // When side sits on the right, keep the same outer→inner semantic by reversing.
  if (
    (side === 'spouse' && spouseSide === 'right') ||
    (side === 'center' && spouseSide === 'left')
  ) {
    // center on left of core when spouse-right?
    // spouse-left: [spouse outer→inner][core][center inner→outer]
    // For center side on the right, inner (parents) should be left / closer to core.
    if (side === 'center' && spouseSide === 'left') {
      return list.slice().reverse(); // parents (inner) first toward core, siblings outer right
    }
    if (side === 'spouse' && spouseSide === 'right') {
      return list.slice().reverse();
    }
  }
  if (side === 'center' && spouseSide === 'right') {
    // center on left: outer left = siblings first, parents near core
    return list;
  }
  if (side === 'spouse' && spouseSide === 'left') {
    return list; // siblings/extended outer left, parents near core
  }
  return list;
}

/**
 * Keep parent / core branches toward the couple core and extended
 * (sibling, parent-sibling, singleton) on the outer edge of the side.
 * Prevents child buses from running under aunt/uncle households.
 */
export function enforceExtendedBranchesOuter(branches, side, spouseSide) {
  const list = branches.slice();
  if (list.length <= 1) return list;
  const isParentLike = (branch) => branch.kind === 'parents' || branch.kind === 'core';
  const parents = list.filter(isParentLike);
  const extended = list.filter((branch) => !isParentLike(branch));
  if (!parents.length || !extended.length) return list;

  const sideOnRight =
    (side === 'center' && spouseSide === 'left') || (side === 'spouse' && spouseSide === 'right');
  // Right of core: [parents … extended]. Left of core: [extended … parents].
  return sideOnRight ? [...parents, ...extended] : [...extended, ...parents];
}

function optimizeBranchList(
  branches,
  { generation, generationMap, peopleById, neighborRows, side = null, spouseSide = null },
) {
  if (branches.length <= 1) return branches.slice();

  // Canonical: topology crossing proxy only. Previous layout must not bias order.
  const scoreBranches = (order) => {
    const households = order.flatMap((branch) =>
      householdsForBranchInGeneration(branch, generation, generationMap),
    );
    return rowCrossingProxy(households, generationMap, peopleById, neighborRows);
  };

  let best = branches.slice().sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  let bestScore = scoreBranches(best);

  if (branches.length <= EXHAUSTIVE_BLOCK_LIMIT) {
    for (const perm of permutations(branches)) {
      const score = scoreBranches(perm);
      const key = perm.map((branch) => branch.id).join('|');
      const bestKey = best.map((branch) => branch.id).join('|');
      if (score < bestScore || (score === bestScore && key < bestKey)) {
        best = perm;
        bestScore = score;
      }
    }
  } else {
    best = adjacentSwapOptimize(best, scoreBranches);
    bestScore = scoreBranches(best);
  }

  best = adjacentSwapOptimize(best, scoreBranches);
  if (side && spouseSide) {
    best = enforceExtendedBranchesOuter(best, side, spouseSide);
  }
  return best;
}

function optimizeHouseholdsInsideBranch(households, { generationMap, peopleById, neighborRows }) {
  if (households.length <= 1) return households.slice();
  const score = (order) => rowCrossingProxy(order, generationMap, peopleById, neighborRows);
  let best = households.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (households.length <= EXHAUSTIVE_BLOCK_LIMIT) {
    let bestScore = score(best);
    for (const perm of permutations(households)) {
      const value = score(perm);
      const key = perm.map((h) => h.id).join('|');
      const bestKey = best.map((h) => h.id).join('|');
      if (value < bestScore || (value === bestScore && key < bestKey)) {
        best = perm;
        bestScore = value;
      }
    }
  }
  return adjacentSwapOptimize(best, score);
}

/**
 * LEVEL 2–3: order one generation without ever crossing family sides.
 */
export function optimizeGenerationOrder(
  households,
  { generation, generationMap, peopleById, neighborRows, spouseSide, householdToBranch },
) {
  if (!households.length) return [];

  const bySide = {
    spouse: households.filter((h) => h.side === 'spouse'),
    core: households.filter((h) => h.side === 'core'),
    center: households.filter((h) => h.side === 'center'),
    neutral: households.filter((h) => h.side === 'neutral'),
  };

  function orderSide(side) {
    const sideHouseholds = bySide[side];
    if (!sideHouseholds.length) return [];
    const sideBranches = [];
    const seen = new Set();
    for (const household of sideHouseholds) {
      const branch = householdToBranch.get(household.id);
      if (!branch || seen.has(branch.id)) continue;
      seen.add(branch.id);
      sideBranches.push({
        ...branch,
        households: householdsForBranchInGeneration(branch, generation, generationMap).filter(
          (item) => item.side === side,
        ),
      });
    }
    // Include only branches that still have households in this generation.
    const active = sideBranches.filter((branch) => branch.households.length);
    const orderedBranches = optimizeBranchList(canonicalBranchOrder(active, side, spouseSide), {
      generation,
      generationMap,
      peopleById,
      neighborRows,
      side,
      spouseSide,
    });

    const out = [];
    for (const branch of orderedBranches) {
      out.push(
        ...optimizeHouseholdsInsideBranch(branch.households, {
          generationMap,
          peopleById,
          neighborRows,
        }),
      );
    }
    return out;
  }

  const spouseOrdered = orderSide('spouse');
  const centerOrdered = orderSide('center');
  const coreOrdered = bySide.core.slice().sort((a, b) => a.id.localeCompare(b.id));
  const neutralOrdered = bySide.neutral.slice().sort((a, b) => a.id.localeCompare(b.id));

  const ordered =
    spouseSide === 'left'
      ? [...spouseOrdered, ...neutralOrdered, ...coreOrdered, ...centerOrdered]
      : [...centerOrdered, ...neutralOrdered, ...coreOrdered, ...spouseOrdered];

  // Guard: never return a side-violating order.
  if (countFamilySideViolations(ordered, spouseSide) > 0) {
    return orderHouseholdsFamilySide(households, spouseSide);
  }
  return ordered;
}

export function optimizeAllGenerations(
  householdsByGeneration,
  { generationMap, peopleById, spouseSide, householdToBranch },
) {
  const gens = [...householdsByGeneration.keys()].sort((a, b) => a - b);
  const orders = new Map();
  for (const g of gens) {
    orders.set(
      g,
      optimizeGenerationOrder(householdsByGeneration.get(g), {
        generation: g,
        generationMap,
        peopleById,
        neighborRows: [],
        spouseSide,
        householdToBranch,
      }),
    );
  }

  for (let iter = 0; iter < MAX_BARYCENTER_ITERS; iter += 1) {
    for (const direction of ['td', 'bu']) {
      const seq = direction === 'td' ? gens : [...gens].reverse();
      for (let i = 0; i < seq.length; i += 1) {
        const g = seq[i];
        const neighbors = [];
        const idx = gens.indexOf(g);
        if (idx > 0) {
          neighbors.push({ generation: gens[idx - 1], households: orders.get(gens[idx - 1]) });
        }
        if (idx < gens.length - 1) {
          neighbors.push({ generation: gens[idx + 1], households: orders.get(gens[idx + 1]) });
        }
        orders.set(
          g,
          optimizeGenerationOrder(householdsByGeneration.get(g), {
            generation: g,
            generationMap,
            peopleById,
            neighborRows: neighbors,
            spouseSide,
            householdToBranch,
          }),
        );
      }
    }
  }
  return orders;
}

export function placeHouseholdRow(
  orderedHouseholds,
  { generation, cardCross, gap, generationStep, isHorizontal, centerId, spouseSide, peopleById },
) {
  const widths = orderedHouseholds.map((household) => householdWidth(household, cardCross, gap));
  const total =
    widths.reduce((sum, width) => sum + width, 0) + Math.max(0, orderedHouseholds.length - 1) * gap;
  let cursor = -total / 2;
  const nodePositions = new Map();
  const placed = [];
  const coreIndex = orderedHouseholds.findIndex((household) => household.side === 'core');

  for (let index = 0; index < orderedHouseholds.length; index += 1) {
    const household = orderedHouseholds[index];
    const width = widths[index];
    const start = cursor;
    let members;
    if (household.side === 'core') {
      members = orderCoreHouseholdMembers(household, centerId, spouseSide, peopleById);
    } else {
      const outerIsLeft = coreIndex >= 0 ? index < coreIndex : spouseSide === 'left';
      members = orderNonCoreMembers(household, { outerIsLeft, peopleById });
    }

    members.forEach((memberId, memberIndex) => {
      const cross = start + memberIndex * (cardCross + gap) + cardCross / 2;
      const genAxis = generation * generationStep;
      if (isHorizontal) nodePositions.set(memberId, { x: genAxis, y: cross });
      else nodePositions.set(memberId, { x: cross, y: genAxis });
    });

    placed.push({
      ...household,
      memberIds: members,
      generation,
      x0: start,
      x1: start + width,
    });
    cursor += width + gap;
  }

  return { nodePositions, households: placed };
}

export function materializePlacement({
  ordersByGeneration,
  spouseSide,
  centerId,
  peopleById,
  cardCross,
  gap,
  generationStep,
  isHorizontal,
  branches = [],
  householdToBranch = new Map(),
}) {
  const nodePositions = new Map();
  const placedHouseholds = [];
  const gens = [...ordersByGeneration.keys()].sort((a, b) => a - b);
  for (const g of gens) {
    const { nodePositions: rowPositions, households } = placeHouseholdRow(
      ordersByGeneration.get(g),
      {
        generation: g,
        cardCross,
        gap,
        generationStep,
        isHorizontal,
        centerId,
        spouseSide,
        peopleById,
      },
    );
    for (const [id, pos] of rowPositions) nodePositions.set(id, pos);
    placedHouseholds.push(...households);
  }
  return {
    nodePositions,
    households: placedHouseholds,
    spouseSide,
    branches,
    householdToBranch,
  };
}

/**
 * Extract a lightweight in-memory snapshot for growth stability.
 * Never persisted to trees.data.
 */
export function extractPlacementSnapshot(layout) {
  if (!layout) return null;
  const householdOrderByGeneration = {};
  const branchOrderByGeneration = {};
  const householdSides = {};
  for (const row of layout.meta?.householdOrdering || []) {
    const g = row.generation;
    householdOrderByGeneration[g] = (row.households || []).map((household) => household.id);
    householdSides[g] = Object.fromEntries(
      (row.households || []).map((household) => [household.id, household.side]),
    );
    branchOrderByGeneration[g] = (row.branchOrder || []).slice();
  }
  // Fallback from households list
  if (!Object.keys(householdOrderByGeneration).length) {
    const byGen = new Map();
    for (const household of layout.households || []) {
      const g = household.generation ?? 0;
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g).push(household);
      if (!householdSides[g]) householdSides[g] = {};
      householdSides[g][household.id] = household.side;
    }
    for (const [g, list] of byGen) {
      householdOrderByGeneration[g] = list.map((household) => household.id);
    }
  }
  return {
    centerId: layout.meta?.centerId || null,
    spouseSide: layout.meta?.spouseSide || null,
    householdOrderByGeneration,
    branchOrderByGeneration,
    householdSides,
    householdIds: new Set(Object.values(householdOrderByGeneration).flat().map(String)),
  };
}

export function compareGrowthStability(
  previousSnapshot,
  layout,
  householdToBranch,
  { centerId = null, spouseSide = null } = {},
) {
  const empty = {
    existingHouseholdsSideChanges: 0,
    existingBranchOrderInversions: 0,
    unexpectedCoupleFlip: 0,
  };
  if (!previousSnapshot || !layout) return empty;

  // Household ids can change when a singleton gains a spouse (hh:p011 → hh:p011+p012).
  // Track side stability by person membership for people present in both layouts.
  let existingHouseholdsSideChanges = 0;
  const prevPersonSide = new Map();
  for (const sides of Object.values(previousSnapshot.householdSides || {})) {
    for (const [hhId, side] of Object.entries(sides || {})) {
      for (const personId of String(hhId).replace(/^hh:/, '').split('+')) {
        if (personId) prevPersonSide.set(personId, side);
      }
    }
  }
  const countedPeople = new Set();
  for (const household of layout.households || []) {
    for (const personId of household.memberIds || []) {
      if (countedPeople.has(personId)) continue;
      countedPeople.add(personId);
      const prevSide = prevPersonSide.get(personId);
      if (prevSide && household.side && prevSide !== household.side) {
        existingHouseholdsSideChanges += 1;
      }
    }
  }

  let existingBranchOrderInversions = 0;
  const currentBranchByGen = layout.meta?.branchOrderByGeneration || {};
  // Derive current branch order from households when meta is absent.
  if (!Object.keys(currentBranchByGen).length && householdToBranch) {
    const byGen = new Map();
    for (const household of layout.households || []) {
      const g = household.generation ?? 0;
      if (!byGen.has(g)) byGen.set(g, []);
      const branch = householdToBranch.get(household.id);
      if (!branch) continue;
      if (!byGen.get(g).includes(branch.id)) byGen.get(g).push(branch.id);
    }
    for (const [g, ids] of byGen) currentBranchByGen[g] = ids;
  }
  for (const [g, currentOrder] of Object.entries(currentBranchByGen)) {
    const prevOrder = previousSnapshot.branchOrderByGeneration?.[g] || [];
    const prevIndex = new Map(prevOrder.map((id, index) => [id, index]));
    const common = (currentOrder || []).filter((id) => prevIndex.has(id));
    for (let i = 0; i < common.length; i += 1) {
      for (let j = i + 1; j < common.length; j += 1) {
        if (prevIndex.get(common[i]) > prevIndex.get(common[j])) {
          existingBranchOrderInversions += 1;
        }
      }
    }
  }

  const currentCenter = centerId || layout.meta?.centerId || null;
  const currentSpouseSide = spouseSide || layout.meta?.spouseSide || null;
  const unexpectedCoupleFlip =
    previousSnapshot.centerId &&
    currentCenter &&
    previousSnapshot.centerId === String(currentCenter) &&
    previousSnapshot.spouseSide &&
    currentSpouseSide &&
    previousSnapshot.spouseSide !== currentSpouseSide
      ? 1
      : 0;

  return {
    existingHouseholdsSideChanges,
    existingBranchOrderInversions,
    unexpectedCoupleFlip,
  };
}

/**
 * Hard: parent-sibling (aunt/uncle) branches must stay on their parent's family
 * side of the couple core — never jump across the core.
 */
export function countParentSiblingBranchSideViolations(
  orderedHouseholds,
  householdToBranch,
  spouseSide,
) {
  if (!orderedHouseholds?.length || !householdToBranch || !spouseSide) return 0;
  const byGen = new Map();
  for (const household of orderedHouseholds) {
    const g = household.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(household);
  }
  let violations = 0;
  for (const row of byGen.values()) {
    const coreIndex = row.findIndex((household) => household.side === 'core');
    for (let i = 0; i < row.length; i += 1) {
      const household = row[i];
      const branch = householdToBranch.get(household.id);
      if (!branch || branch.kind !== 'parent-sibling') continue;
      if (household.side !== branch.side) violations += 1;
      if (coreIndex < 0) continue;
      if (branch.side === 'spouse') {
        if (spouseSide === 'left' && i > coreIndex) violations += 1;
        if (spouseSide === 'right' && i < coreIndex) violations += 1;
      }
      if (branch.side === 'center') {
        if (spouseSide === 'left' && i < coreIndex) violations += 1;
        if (spouseSide === 'right' && i > coreIndex) violations += 1;
      }
    }
  }
  return violations;
}

export function buildPlacementCandidates({
  households,
  generationMap,
  peopleById,
  centerId,
  cardCross,
  gap,
  generationStep,
  isHorizontal,
}) {
  const { branches, classified, householdToBranch } = buildFamilyBranchBlocks(
    households,
    peopleById,
    centerId,
    generationMap,
  );
  const byGen = new Map();
  for (const household of classified) {
    const g = Math.min(...household.memberIds.map((id) => generationMap.get(id) ?? 0));
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(household);
  }

  const candidates = [];
  for (const spouseSide of ['left', 'right']) {
    const orders = optimizeAllGenerations(byGen, {
      generationMap,
      peopleById,
      spouseSide,
      householdToBranch,
    });
    const material = materializePlacement({
      ordersByGeneration: orders,
      spouseSide,
      centerId,
      peopleById,
      cardCross,
      gap,
      generationStep,
      isHorizontal,
      branches,
      householdToBranch,
    });

    // Attach branch order meta per generation for snapshots / reports.
    const branchOrderByGeneration = {};
    for (const [g, list] of orders) {
      const ids = [];
      const seen = new Set();
      for (const household of list) {
        const branch = householdToBranch.get(household.id);
        if (!branch || seen.has(branch.id)) continue;
        seen.add(branch.id);
        ids.push(branch.id);
      }
      branchOrderByGeneration[g] = ids;
    }

    candidates.push({
      candidateId: `spouse-${spouseSide}`,
      spouseSide,
      ...material,
      generationOrders: Object.fromEntries(
        [...orders.entries()].map(([g, list]) => [g, list.map((h) => h.id)]),
      ),
      branchOrderByGeneration,
      branches: branches.map((branch) => ({
        id: branch.id,
        side: branch.side,
        kind: branch.kind,
        anchorId: branch.anchorId,
        householdIds: branch.households.map((household) => household.id),
        canonicalKey: branch.canonicalKey,
      })),
    });
  }

  candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return candidates;
}

export { scorePlacementCandidate, compareCandidateScores };
