/**
 * Cost function for prototype household placement candidates.
 * Hard violations dominate; soft terms prefer fewer crossings/jumps
 * over slightly wider trees.
 */

export const HARD = 1_000_000;

export const SOFT_WEIGHTS = {
  crossings: 5000,
  jumps: 4000,
  nearCollinear: 2500,
  familyInterleave: 800,
  bends: 40,
  routeLength: 0.15,
  width: 0.8,
  height: 0.5,
  orderingInstability: 120,
};

/**
 * @param {object} metrics
 * @returns {{ hardViolations: number, totalCost: number, soft: object }}
 */
export function scorePlacementCandidate(metrics) {
  const hard =
    (metrics.overlaps || 0) +
    (metrics.lostNodes || 0) +
    (metrics.missingPC || 0) +
    (metrics.missingSpouse || 0) +
    (metrics.missingSiblingSpouses || 0) +
    (metrics.linksThroughCards || 0) +
    (metrics.falseJunctions || 0) +
    (metrics.ambiguousSharedSegments || 0) +
    (metrics.invalidFamilyJunctions || 0) +
    (metrics.unrelatedCollinearOverlaps || 0) +
    (metrics.zeroLengthSegments || 0) +
    (metrics.selfIntersections || 0) +
    (metrics.missingRequiredJumps || 0) +
    (metrics.falseJumps || 0) +
    (metrics.exteriorDetours || 0);

  const soft = {
    crossings: (metrics.crossings || 0) * SOFT_WEIGHTS.crossings,
    jumps: (metrics.jumps || 0) * SOFT_WEIGHTS.jumps,
    nearCollinear: (metrics.nearCollinear || 0) * SOFT_WEIGHTS.nearCollinear,
    familyInterleave: (metrics.familyInterleave || 0) * SOFT_WEIGHTS.familyInterleave,
    bends: (metrics.bends || 0) * SOFT_WEIGHTS.bends,
    routeLength: (metrics.routeLength || 0) * SOFT_WEIGHTS.routeLength,
    width: (metrics.width || 0) * SOFT_WEIGHTS.width,
    height: (metrics.height || 0) * SOFT_WEIGHTS.height,
    orderingInstability: (metrics.orderingInstability || 0) * SOFT_WEIGHTS.orderingInstability,
  };

  const softTotal = Object.values(soft).reduce((sum, value) => sum + value, 0);
  return {
    hardViolations: hard,
    totalCost: hard * HARD + softTotal,
    soft,
  };
}

export function compareCandidateScores(left, right) {
  if (left.hardViolations !== right.hardViolations) {
    return left.hardViolations - right.hardViolations;
  }
  if (left.totalCost !== right.totalCost) return left.totalCost - right.totalCost;
  return String(left.candidateId || '').localeCompare(String(right.candidateId || ''));
}
