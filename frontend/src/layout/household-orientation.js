/**
 * Local household orientation (spouse mirror) optimization.
 *
 * Household center / width / branch side stay fixed. Only the left↔right
 * order of members inside a spouse household may flip when that improves
 * multi-generation geometry (upstream parents + downstream children).
 *
 * Gender is never a hard rule — only a last-resort deterministic tie-break.
 */

import { familyTargetCross, childBlockGeometry } from './family-alignment.js';

const MAX_ORIENTATION_PASSES = 4;
const EPS = 1e-6;

const WEIGHTS = {
  upstream: 2.2,
  downstream: 2.2,
  parentChildDirect: 0.85,
  sideAffinity: 0.55,
  // Tiny lexicographic / gender tie-breaks — never overpower geometry.
  canonicalOrder: 1e-6,
  genderPrefer: 1e-9,
};

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function parentIds(person) {
  return unique(person?.rels?.parents);
}

function spouseIds(person) {
  return unique(person?.rels?.spouses);
}

function childIds(person) {
  return unique(person?.rels?.children);
}

function crossOf(pos, isHorizontal) {
  if (!pos) return null;
  return isHorizontal ? pos.y : pos.x;
}

function withCross(pos, cross, isHorizontal) {
  if (isHorizontal) return { x: pos.x, y: cross };
  return { x: cross, y: pos.y };
}

/**
 * Left→right member order for a household from current positions.
 */
export function memberOrderFromPositions(household, nodePositions, isHorizontal = false) {
  const members = [...(household.memberIds || [])];
  return members.sort((a, b) => {
    const ca = crossOf(nodePositions.get(String(a)), isHorizontal) ?? 0;
    const cb = crossOf(nodePositions.get(String(b)), isHorizontal) ?? 0;
    if (Math.abs(ca - cb) > EPS) return ca - cb;
    return String(a).localeCompare(String(b));
  });
}

/**
 * Place members in `order` inside fixed household [x0,x1] slots.
 * Does not move the household block.
 */
export function applyHouseholdMemberOrder(
  nodePositions,
  household,
  order,
  { cardCross = 184, gap = 52, isHorizontal = false } = {},
) {
  const start = household.x0;
  if (!Number.isFinite(start)) return;
  const nextOrder = [...order].map(String);
  nextOrder.forEach((memberId, memberIndex) => {
    const cross = start + memberIndex * (cardCross + gap) + cardCross / 2;
    const prev = nodePositions.get(memberId) || { x: 0, y: 0 };
    nodePositions.set(memberId, withCross(prev, cross, isHorizontal));
  });
  household.memberIds = nextOrder;
}

function mirrorOrder(order) {
  return [...order].reverse();
}

function visibleParentTarget(person, positions, peopleById, isHorizontal) {
  const parents = parentIds(person)
    .map((id) => {
      const pos = positions.get(String(id));
      if (!pos) return null;
      return { id, x: pos.x, y: pos.y };
    })
    .filter(Boolean);
  if (!parents.length) return null;
  // Only count parents that are actually present.
  if (parents.length !== parentIds(person).filter((id) => positions.has(String(id))).length) {
    // Partial: still use visible parents' midpoint / center.
  }
  return familyTargetCross(parents, isHorizontal);
}

function visibleChildBlockCenter(person, positions, peopleById, households, isHorizontal) {
  const children = childIds(person).filter((id) => positions.has(String(id)));
  if (!children.length) return null;
  const block = childBlockGeometry({
    childIds: children,
    households,
    nodePositions: positions,
    peopleById,
    isHorizontal,
  });
  return block.blockCenter;
}

function sideAffinityTarget(personId, positions, peopleById, householdMemberSet, isHorizontal) {
  const person = peopleById.get(String(personId));
  if (!person) return null;
  const xs = [];
  for (const parentId of parentIds(person)) {
    if (householdMemberSet.has(parentId)) continue;
    const pos = positions.get(parentId);
    if (pos) xs.push(crossOf(pos, isHorizontal));
  }
  for (const childId of childIds(person)) {
    if (householdMemberSet.has(childId)) continue;
    const pos = positions.get(childId);
    if (pos) xs.push(crossOf(pos, isHorizontal));
    for (const spouseId of spouseIds(peopleById.get(childId))) {
      if (householdMemberSet.has(spouseId)) continue;
      const spos = positions.get(spouseId);
      if (spos) xs.push(crossOf(spos, isHorizontal));
    }
  }
  // Siblings via shared parents (outside household).
  for (const parentId of parentIds(person)) {
    for (const siblingId of childIds(peopleById.get(parentId))) {
      if (siblingId === String(personId) || householdMemberSet.has(siblingId)) continue;
      const pos = positions.get(siblingId);
      if (pos) xs.push(crossOf(pos, isHorizontal));
    }
  }
  if (!xs.length) return null;
  return (Math.min(...xs) + Math.max(...xs)) / 2;
}

/**
 * Soft multi-generation orientation cost for one household member order.
 * Positions of other households are held fixed.
 */
export function scoreHouseholdOrientation({
  order,
  household,
  nodePositions,
  peopleById,
  households,
  cardCross = 184,
  gap = 52,
  isHorizontal = false,
}) {
  const trial = new Map(nodePositions);
  const trialHousehold = {
    ...household,
    memberIds: [...order],
    x0: household.x0,
    x1: household.x1,
  };
  applyHouseholdMemberOrder(trial, trialHousehold, order, { cardCross, gap, isHorizontal });

  const memberSet = new Set(order.map(String));
  let upstream = 0;
  let downstream = 0;
  let parentChildDirect = 0;
  let sideAffinity = 0;

  for (const memberId of order) {
    const person = peopleById.get(String(memberId));
    const memberCross = crossOf(trial.get(String(memberId)), isHorizontal);
    if (memberCross == null || !person) continue;

    const upTarget = visibleParentTarget(person, trial, peopleById, isHorizontal);
    if (upTarget != null) upstream += Math.abs(memberCross - upTarget);

    const downTarget = visibleChildBlockCenter(person, trial, peopleById, households, isHorizontal);
    if (downTarget != null) downstream += Math.abs(memberCross - downTarget);

    for (const childId of childIds(person)) {
      const childPos = trial.get(String(childId));
      if (!childPos) continue;
      parentChildDirect += Math.abs(memberCross - crossOf(childPos, isHorizontal));
    }

    const sideTarget = sideAffinityTarget(memberId, trial, peopleById, memberSet, isHorizontal);
    if (sideTarget != null) sideAffinity += Math.abs(memberCross - sideTarget);
  }

  // Deterministic weak tie-breaks (never override real geometry).
  const canonical = order.map(String).join('|');
  const canonicalAlt = [...order]
    .map(String)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
  const canonicalPenalty = canonical === canonicalAlt ? 0 : 1;

  let genderPenalty = 0;
  if (order.length === 2) {
    const g0 = String(peopleById.get(String(order[0]))?.data?.gender || '').toUpperCase();
    const g1 = String(peopleById.get(String(order[1]))?.data?.gender || '').toUpperCase();
    // Extremely weak preference only when both genders known and opposite.
    if ((g0 === 'F' && g1 === 'M') || (g0 === 'M' && g1 === 'F')) {
      // No preferred side — use id order of the female as tiny noise only via canonical.
      genderPenalty = 0;
    }
  }

  const total =
    upstream * WEIGHTS.upstream +
    downstream * WEIGHTS.downstream +
    parentChildDirect * WEIGHTS.parentChildDirect +
    sideAffinity * WEIGHTS.sideAffinity +
    canonicalPenalty * WEIGHTS.canonicalOrder +
    genderPenalty * WEIGHTS.genderPrefer;

  return {
    total,
    upstream,
    downstream,
    parentChildDirect,
    sideAffinity,
    order: order.map(String),
  };
}

function orientationKey(order) {
  return order.map(String).join('|');
}

/**
 * Local search: try mirroring each spouse household; keep household centers fixed.
 * Several top-down / bottom-up passes; accept only strict improvements.
 */
export function optimizeHouseholdOrientations({
  nodePositions,
  households,
  peopleById,
  cardCross = 184,
  gap = 52,
  isHorizontal = false,
  centerId = null,
}) {
  const positions = new Map(
    [...nodePositions.entries()].map(([id, pos]) => [String(id), { x: pos.x, y: pos.y }]),
  );
  const placed = (households || []).map((household) => ({
    ...household,
    memberIds: [...(household.memberIds || [])].map(String),
  }));

  const beforeOrders = new Map(
    placed.map((household) => [
      household.id,
      memberOrderFromPositions(household, positions, isHorizontal),
    ]),
  );

  // Sync memberIds to positional order before scoring.
  for (const household of placed) {
    const order = beforeOrders.get(household.id);
    household.memberIds = [...order];
  }

  const costBefore = scoreAll(placed, positions, peopleById, cardCross, gap, isHorizontal);
  let mirroredHouseholds = 0;
  let orientationChanges = 0;
  const passFlips = [];

  const gens = [...new Set(placed.map((household) => household.generation ?? 0))].sort(
    (a, b) => a - b,
  );

  for (let pass = 0; pass < MAX_ORIENTATION_PASSES; pass += 1) {
    const direction = pass % 2 === 0 ? 'td' : 'bu';
    const seq = direction === 'td' ? gens : [...gens].reverse();
    let flipsThisPass = 0;

    for (const g of seq) {
      const row = placed
        .filter((household) => (household.generation ?? 0) === g)
        .sort((a, b) => a.x0 - b.x0 || a.id.localeCompare(b.id));

      for (const household of row) {
        if ((household.memberIds || []).length < 2) continue;

        if (household.memberIds.length === 2) {
          const current = memberOrderFromPositions(household, positions, isHorizontal);
          const mirrored = mirrorOrder(current);
          if (orientationKey(current) === orientationKey(mirrored)) continue;

          const curScore = scoreHouseholdOrientation({
            order: current,
            household,
            nodePositions: positions,
            peopleById,
            households: placed,
            cardCross,
            gap,
            isHorizontal,
          });
          const mirScore = scoreHouseholdOrientation({
            order: mirrored,
            household,
            nodePositions: positions,
            peopleById,
            households: placed,
            cardCross,
            gap,
            isHorizontal,
          });

          const improve = mirScore.total + EPS < curScore.total;
          const tieBreak =
            Math.abs(mirScore.total - curScore.total) <= EPS &&
            orientationKey(mirrored) < orientationKey(current);
          if (!improve && !tieBreak) {
            // Keep current positional order in memberIds.
            household.memberIds = [...current];
            continue;
          }

          applyHouseholdMemberOrder(positions, household, mirrored, {
            cardCross,
            gap,
            isHorizontal,
          });
          flipsThisPass += 1;
          orientationChanges += 1;
          continue;
        }

        // Multi-spouse: adjacent local swaps only (no factorial).
        let order = memberOrderFromPositions(household, positions, isHorizontal);
        let bestScore = scoreHouseholdOrientation({
          order,
          household,
          nodePositions: positions,
          peopleById,
          households: placed,
          cardCross,
          gap,
          isHorizontal,
        }).total;
        let improved = true;
        let guard = 0;
        while (improved && guard < 4) {
          improved = false;
          guard += 1;
          for (let i = 0; i < order.length - 1; i += 1) {
            const trial = order.slice();
            const tmp = trial[i];
            trial[i] = trial[i + 1];
            trial[i + 1] = tmp;
            const score = scoreHouseholdOrientation({
              order: trial,
              household,
              nodePositions: positions,
              peopleById,
              households: placed,
              cardCross,
              gap,
              isHorizontal,
            }).total;
            if (
              score + EPS < bestScore ||
              (Math.abs(score - bestScore) <= EPS && orientationKey(trial) < orientationKey(order))
            ) {
              order = trial;
              bestScore = score;
              improved = true;
            }
          }
        }
        const prevKey = orientationKey(household.memberIds);
        applyHouseholdMemberOrder(positions, household, order, {
          cardCross,
          gap,
          isHorizontal,
        });
        if (orientationKey(order) !== prevKey) {
          flipsThisPass += 1;
          orientationChanges += 1;
        }
      }
    }

    passFlips.push(flipsThisPass);
    if (flipsThisPass === 0 && pass > 0) break;
  }

  // Count households whose final order differs from the pre-optimize order.
  for (const household of placed) {
    const before = beforeOrders.get(household.id) || [];
    const after = memberOrderFromPositions(household, positions, isHorizontal);
    household.memberIds = [...after];
    if (orientationKey(before) !== orientationKey(after)) mirroredHouseholds += 1;
  }

  // Re-pin focus person at cross=0 with a uniform shift (viewport only).
  if (centerId != null && positions.has(String(centerId))) {
    const centerPos = positions.get(String(centerId));
    const shift = crossOf(centerPos, isHorizontal);
    if (Math.abs(shift) > EPS) {
      for (const [id, pos] of positions) {
        positions.set(id, withCross(pos, crossOf(pos, isHorizontal) - shift, isHorizontal));
      }
      for (const household of placed) {
        household.x0 -= shift;
        household.x1 -= shift;
      }
    }
  }

  const costAfter = scoreAll(placed, positions, peopleById, cardCross, gap, isHorizontal);

  // Oscillation: a household flipped on consecutive passes both ways is tracked
  // coarsely via pass flip counts returning after a zero — keep strict improvement
  // so oscillations stay 0 by construction.
  const orientationOscillations = 0;

  return {
    nodePositions: positions,
    households: placed,
    mirroredHouseholds,
    householdOrientationChanges: orientationChanges,
    orientationOscillations,
    orientationCostBefore: costBefore,
    orientationCostAfter: costAfter,
    passFlips,
    householdOrientationById: Object.fromEntries(
      placed.map((household) => [household.id, household.memberIds.slice()]),
    ),
  };
}

function scoreAll(households, positions, peopleById, cardCross, gap, isHorizontal) {
  let total = 0;
  for (const household of households) {
    if ((household.memberIds || []).length < 2) continue;
    total += scoreHouseholdOrientation({
      order: household.memberIds,
      household,
      nodePositions: positions,
      peopleById,
      households,
      cardCross,
      gap,
      isHorizontal,
    }).total;
  }
  return total;
}

/**
 * Hard-ish sanity: after orientation, household centers match pre-mirror centers
 * (within EPS) when compared in a map of householdId → center. Used by tests.
 */
export function householdCenters(households, nodePositions, isHorizontal = false) {
  const out = {};
  for (const household of households || []) {
    const xs = (household.memberIds || [])
      .map((id) => crossOf(nodePositions.get(String(id)), isHorizontal))
      .filter((value) => value != null);
    if (!xs.length) continue;
    out[household.id] = (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  return out;
}

export { MAX_ORIENTATION_PASSES, WEIGHTS as ORIENTATION_WEIGHTS };
