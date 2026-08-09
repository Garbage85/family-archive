/**
 * Multi-candidate household placement optimizer.
 *
 * Pipeline: family-side ordering → spouse-side mirror candidates →
 * multi-generation barycenter/swap search → score via routing metrics.
 *
 * Deterministic. No production person-id hardcoding.
 */

import { scorePlacementCandidate, compareCandidateScores } from './placement-cost.js';

const EXHAUSTIVE_HOUSEHOLD_LIMIT = 6;
const MAX_SWAP_PASSES = 8;
const MAX_BARYCENTER_ITERS = 6;

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

/**
 * Classify households relative to the couple core (center ∪ spouses).
 * side: 'spouse' | 'center' | 'core' | 'neutral'
 */
export function classifyHouseholdSides(households, peopleById, centerId) {
  const center = peopleById.get(String(centerId));
  const coreIds = new Set(unique([String(centerId), ...spouseIds(center)]));
  const spouseOnly = new Set(spouseIds(center));

  const centerAncestor = new Set();
  const spouseAncestor = new Set();
  const centerSibling = new Set();
  const spouseSibling = new Set();

  function collectAncestors(seedIds, into, depth = 6) {
    let frontier = [...seedIds];
    for (let d = 0; d < depth && frontier.length; d += 1) {
      const next = [];
      for (const id of frontier) {
        for (const parentId of parentIds(peopleById.get(id))) {
          if (!peopleById.has(parentId) || into.has(parentId)) continue;
          into.add(parentId);
          next.push(parentId);
        }
      }
      frontier = next;
    }
  }

  collectAncestors([String(centerId)], centerAncestor);
  for (const spouseId of spouseOnly) collectAncestors([spouseId], spouseAncestor);

  for (const coreId of coreIds) {
    for (const parentId of parentIds(peopleById.get(coreId))) {
      for (const siblingId of childIds(peopleById.get(parentId))) {
        if (coreIds.has(siblingId)) continue;
        if (coreId === String(centerId)) centerSibling.add(siblingId);
        else spouseSibling.add(siblingId);
      }
    }
  }

  // Parents of sibling-spouses lean toward the sibling's side.
  for (const siblingId of centerSibling) {
    for (const sid of spouseIds(peopleById.get(siblingId))) {
      for (const parentId of parentIds(peopleById.get(sid))) {
        centerAncestor.add(parentId);
      }
    }
  }
  for (const siblingId of spouseSibling) {
    for (const sid of spouseIds(peopleById.get(siblingId))) {
      for (const parentId of parentIds(peopleById.get(sid))) {
        spouseAncestor.add(parentId);
      }
    }
  }

  return households.map((household) => {
    const members = household.memberIds;
    const inCore = members.some((id) => coreIds.has(id));
    if (inCore) {
      return {
        ...household,
        side: 'core',
        affinity: 0,
        anchorId: members.includes(String(centerId))
          ? String(centerId)
          : members.slice().sort((a, b) => a.localeCompare(b))[0],
      };
    }
    let spouseScore = 0;
    let centerScore = 0;
    for (const id of members) {
      if (spouseAncestor.has(id) || spouseSibling.has(id)) spouseScore += 2;
      if (centerAncestor.has(id) || centerSibling.has(id)) centerScore += 2;
      // Spouses of siblings inherit sibling side.
      for (const other of members) {
        if (spouseIds(peopleById.get(id)).includes(other)) {
          if (spouseSibling.has(other)) spouseScore += 1;
          if (centerSibling.has(other)) centerScore += 1;
        }
      }
    }
    let side = 'neutral';
    if (spouseScore > centerScore) side = 'spouse';
    else if (centerScore > spouseScore) side = 'center';

    // Anchor = blood-side relative when present; else stable id.
    let anchorId = null;
    for (const id of members.slice().sort((a, b) => a.localeCompare(b))) {
      if (
        centerSibling.has(id) ||
        spouseSibling.has(id) ||
        centerAncestor.has(id) ||
        spouseAncestor.has(id)
      ) {
        anchorId = id;
        break;
      }
    }
    if (!anchorId) anchorId = members.slice().sort((a, b) => a.localeCompare(b))[0];

    return {
      ...household,
      side,
      affinity: centerScore - spouseScore,
      anchorId,
    };
  });
}

/**
 * Order members inside the center household for a spouse-side candidate.
 * One spouse: spouseLeft => [spouse, center]; spouseRight => [center, spouse].
 * Multiple spouses: keep center in the middle so each spouse link stays adjacent
 * (avoids routing a spouse segment through another spouse card).
 * Left/right still controls which spouse sits on which outer side.
 */
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
  // Deterministic: left block ascending toward center, right block ascending away.
  const left = [...leftSpouses].sort((a, b) => a.localeCompare(b));
  const right = [...rightSpouses].sort((a, b) => a.localeCompare(b));
  if (spouseSide === 'right') {
    // Prefer first sorted spouse on the right outer side when mirroring.
    return [...left.reverse(), center, ...right];
  }
  return [...left, center, ...right];
}

/**
 * Non-core household: spouses prefer the outer side of the branch.
 * outerIsLeft => [...spouses, anchor]; else [anchor, ...spouses].
 * If one member is married to all others (multi-spouse hub), keep that hub
 * in the middle so spouse segments stay card-adjacent.
 */
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
 * Family-side preferred row order for one generation.
 * spouseLeft: [spouse-side..., core..., center-side...]
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

  if (spouseSide === 'left') {
    return [...spouseBlock, ...neutral, ...coreBlock, ...centerBlock];
  }
  if (spouseSide === 'right') {
    return [...centerBlock, ...neutral, ...coreBlock, ...spouseBlock];
  }
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

function barycenterOrder(households, neighborIndex, leftToRight = true) {
  const scored = households.map((household) => {
    const neighbors = neighborIndex.get(household.id) || [];
    const bary =
      neighbors.length === 0
        ? Number.POSITIVE_INFINITY
        : neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
    return { household, bary };
  });
  scored.sort((a, b) => {
    if (a.bary !== b.bary) return leftToRight ? a.bary - b.bary : b.bary - a.bary;
    return a.household.id.localeCompare(b.household.id);
  });
  return scored.map((entry) => entry.household);
}

function medianOrder(households, neighborIndex) {
  const scored = households.map((household) => {
    const neighbors = [...(neighborIndex.get(household.id) || [])].sort((a, b) => a - b);
    const median =
      neighbors.length === 0
        ? Number.POSITIVE_INFINITY
        : neighbors.length % 2 === 1
          ? neighbors[(neighbors.length - 1) / 2]
          : (neighbors[neighbors.length / 2 - 1] + neighbors[neighbors.length / 2]) / 2;
    return { household, median };
  });
  scored.sort((a, b) => a.median - b.median || a.household.id.localeCompare(b.household.id));
  return scored.map((entry) => entry.household);
}

function adjacentSwapOptimize(households, scoreFn) {
  let best = households.slice();
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
        (score === bestScore && trial.map((h) => h.id).join('|') < best.map((h) => h.id).join('|'))
      ) {
        best = trial;
        bestScore = score;
        improved = true;
      }
    }
  }
  return best;
}

function familyInterleavePenalty(orderedHouseholds) {
  // Penalize spouse/center/spouse/center alternation.
  let penalty = 0;
  let lastSide = null;
  let flips = 0;
  for (const household of orderedHouseholds) {
    if (household.side !== 'spouse' && household.side !== 'center') continue;
    if (lastSide && lastSide !== household.side) flips += 1;
    lastSide = household.side;
  }
  // Contiguous two-block pattern has at most 1 flip.
  penalty += Math.max(0, flips - 1) * 3;
  return penalty;
}

/**
 * Place an ordered list of households on one generation row (centered).
 */
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

function rowCrossingProxy(orderedHouseholds, generationMap, peopleById, neighborRows = []) {
  // Lightweight proxy used inside local search before full routing.
  // Includes same-row edges and cross-generation alignment to neighbor rows.
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

  cost += familyInterleavePenalty(orderedHouseholds) * 10;
  return cost;
}

/**
 * Optimize household order for one generation given neighbor row positions.
 */
export function optimizeGenerationOrder(
  households,
  { generationMap, peopleById, neighborRows, spouseSide, preferFamilySide = true },
) {
  if (!households.length) return [];
  let base = preferFamilySide
    ? orderHouseholdsFamilySide(households, spouseSide)
    : [...households].sort((a, b) => a.id.localeCompare(b.id));

  const neighborIndex = new Map();
  for (const household of households) neighborIndex.set(household.id, []);
  for (const neighbor of neighborRows || []) {
    const neighborPos = new Map(
      (neighbor.households || []).map((household, index) => [household.id, index]),
    );
    for (const household of households) {
      const targets = [];
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
          // find household of other in neighbor row
          const otherHh = (neighbor.households || []).find((item) =>
            item.memberIds.includes(otherId),
          );
          if (!otherHh) continue;
          targets.push(neighborPos.get(otherHh.id) ?? 0);
        }
      }
      neighborIndex.set(household.id, [...(neighborIndex.get(household.id) || []), ...targets]);
    }
  }

  const scoreOrder = (order) =>
    rowCrossingProxy(order, generationMap, peopleById, neighborRows || []);

  const candidates = [];
  candidates.push({ id: 'family-side', order: base });
  candidates.push({ id: 'barycenter', order: barycenterOrder(households, neighborIndex, true) });
  candidates.push({ id: 'median', order: medianOrder(households, neighborIndex) });
  candidates.push({
    id: 'id-sort',
    order: [...households].sort((a, b) => a.id.localeCompare(b.id)),
  });

  if (households.length <= EXHAUSTIVE_HOUSEHOLD_LIMIT) {
    let bestPerm = base;
    let bestScore = scoreOrder(bestPerm);
    for (const perm of permutations(households)) {
      const score = scoreOrder(perm);
      const idKey = perm.map((h) => h.id).join('|');
      const bestKey = bestPerm.map((h) => h.id).join('|');
      if (score < bestScore || (score === bestScore && idKey < bestKey)) {
        bestScore = score;
        bestPerm = perm;
      }
    }
    candidates.push({ id: 'exhaustive', order: bestPerm });
  }

  let best = candidates[0].order;
  let bestScore = scoreOrder(best);
  let bestId = candidates[0].id;
  for (const candidate of candidates) {
    const swapped = adjacentSwapOptimize(candidate.order, scoreOrder);
    const score = scoreOrder(swapped);
    const idKey = swapped.map((h) => h.id).join('|');
    const bestKey = best.map((h) => h.id).join('|');
    if (
      score < bestScore ||
      (score === bestScore && (idKey < bestKey || (idKey === bestKey && candidate.id < bestId)))
    ) {
      best = swapped;
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return best;
}

/**
 * Multi-generation ordering: top-down then bottom-up barycenter-style passes.
 */
export function optimizeAllGenerations(
  householdsByGeneration,
  { generationMap, peopleById, spouseSide },
) {
  const gens = [...householdsByGeneration.keys()].sort((a, b) => a - b);
  const orders = new Map();
  for (const g of gens) {
    orders.set(g, orderHouseholdsFamilySide(householdsByGeneration.get(g), spouseSide));
  }

  for (let iter = 0; iter < MAX_BARYCENTER_ITERS; iter += 1) {
    // top-down
    for (let i = 0; i < gens.length; i += 1) {
      const g = gens[i];
      const neighbors = [];
      if (i > 0) {
        neighbors.push({ generation: gens[i - 1], households: orders.get(gens[i - 1]) });
      }
      if (i < gens.length - 1) {
        neighbors.push({ generation: gens[i + 1], households: orders.get(gens[i + 1]) });
      }
      orders.set(
        g,
        optimizeGenerationOrder(householdsByGeneration.get(g), {
          generationMap,
          peopleById,
          neighborRows: neighbors,
          spouseSide,
          preferFamilySide: iter === 0,
        }),
      );
    }
    // bottom-up
    for (let i = gens.length - 1; i >= 0; i -= 1) {
      const g = gens[i];
      const neighbors = [];
      if (i > 0) {
        neighbors.push({ generation: gens[i - 1], households: orders.get(gens[i - 1]) });
      }
      if (i < gens.length - 1) {
        neighbors.push({ generation: gens[i + 1], households: orders.get(gens[i + 1]) });
      }
      orders.set(
        g,
        optimizeGenerationOrder(householdsByGeneration.get(g), {
          generationMap,
          peopleById,
          neighborRows: neighbors,
          spouseSide,
          preferFamilySide: false,
        }),
      );
    }
  }

  return orders;
}

/**
 * Build concrete node positions for a candidate (spouseSide + generation orders).
 */
export function materializePlacement({
  ordersByGeneration,
  spouseSide,
  centerId,
  peopleById,
  cardCross,
  gap,
  generationStep,
  isHorizontal,
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
  return { nodePositions, households: placedHouseholds, spouseSide };
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
  const classified = classifyHouseholdSides(households, peopleById, centerId);
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
    });
    candidates.push({
      candidateId: `spouse-${spouseSide}`,
      spouseSide,
      ...material,
      generationOrders: Object.fromEntries(
        [...orders.entries()].map(([g, list]) => [g, list.map((h) => h.id)]),
      ),
    });
  }

  // Base id-sorted candidate (legacy-like) for comparison.
  const baseOrders = new Map();
  for (const g of byGen.keys()) {
    baseOrders.set(
      g,
      [...byGen.get(g)].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
  for (const spouseSide of ['left', 'right']) {
    const material = materializePlacement({
      ordersByGeneration: baseOrders,
      spouseSide,
      centerId,
      peopleById,
      cardCross,
      gap,
      generationStep,
      isHorizontal,
    });
    candidates.push({
      candidateId: `base-${spouseSide}`,
      spouseSide,
      ...material,
      generationOrders: Object.fromEntries(
        [...baseOrders.entries()].map(([g, list]) => [g, list.map((h) => h.id)]),
      ),
    });
  }

  // Deterministic unique by candidateId
  candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return candidates;
}

export { scorePlacementCandidate, compareCandidateScores };
