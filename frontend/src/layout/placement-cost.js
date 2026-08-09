/**
 * Cost function for prototype household placement candidates.
 * Family structure is HARD; routing quality is SOFT.
 */

export const HARD = 1_000_000;

export const SOFT_WEIGHTS = {
  // Growth stability report-only softs (never feed geometry selection).
  existingHouseholdsSideChanges: 50000,
  existingBranchOrderInversions: 12000,
  unexpectedCoupleFlip: 80000,
  // Priority among softs:
  //   local family geometry → compact children → lanes/height → short routes → crossings/jumps.
  foreignHouseholdsUnderBus: 9000,
  busExcessLength: 25,
  familyHorizontalSpread: 1.8,
  maxLaneCountPerGap: 700,
  requiredLaneCountTotal: 100,
  totalRoutingGapHeight: 1.0,
  routeLength: 0.2,
  crossings: 1800,
  jumps: 1400,
  nearCollinear: 2500,
  familyInterleave: 800,
  bends: 40,
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
    (metrics.twoParentStemAnchoredToSpouseMidpoint || 0) +
    (metrics.singleParentStemAnchoredToCardCenter || 0) +
    (metrics.familyStemLaneShiftViolations || 0) +
    (metrics.multipleStemsPerParentPair || 0) +
    (metrics.familyJunctionMismatch || 0) +
    (metrics.familyBusLocalityViolations || 0) +
    (metrics.unrelatedFamiliesSharingBusSegment || 0) +
    (metrics.childrenBlockInterleavingViolations || 0) +
    (metrics.unrelatedCollinearOverlaps || 0) +
    (metrics.zeroLengthSegments || 0) +
    (metrics.selfIntersections || 0) +
    (metrics.missingRequiredJumps || 0) +
    (metrics.falseJumps || 0) +
    (metrics.exteriorDetours || 0) +
    (metrics.familySideViolations || 0) +
    (metrics.branchIntegrityViolations || 0) +
    (metrics.parentSiblingBranchSideViolations || 0) +
    (metrics.parallelLaneOverlap || 0) +
    (metrics.parallelGapViolations || 0) +
    (metrics.laneConflicts || 0) +
    (metrics.routingOutsideGenerationGap || 0) +
    (metrics.coldWarmSignatureMismatch || 0);

  const soft = {
    // Stability is soft but very expensive vs routing — never tear family sides.
    existingHouseholdsSideChanges:
      (metrics.existingHouseholdsSideChanges || 0) * SOFT_WEIGHTS.existingHouseholdsSideChanges,
    existingBranchOrderInversions:
      (metrics.existingBranchOrderInversions || 0) * SOFT_WEIGHTS.existingBranchOrderInversions,
    unexpectedCoupleFlip: (metrics.unexpectedCoupleFlip || 0) * SOFT_WEIGHTS.unexpectedCoupleFlip,
    foreignHouseholdsUnderBus:
      (metrics.foreignHouseholdsUnderBus || 0) * SOFT_WEIGHTS.foreignHouseholdsUnderBus,
    busExcessLength: (metrics.busExcessLength || 0) * SOFT_WEIGHTS.busExcessLength,
    familyHorizontalSpread:
      (metrics.familyHorizontalSpread || 0) * SOFT_WEIGHTS.familyHorizontalSpread,
    crossings: (metrics.crossings || 0) * SOFT_WEIGHTS.crossings,
    jumps: (metrics.jumps || 0) * SOFT_WEIGHTS.jumps,
    maxLaneCountPerGap: (metrics.maxLaneCount || 0) * SOFT_WEIGHTS.maxLaneCountPerGap,
    requiredLaneCountTotal:
      (metrics.requiredLaneCountTotal || metrics.totalLaneCount || 0) *
      SOFT_WEIGHTS.requiredLaneCountTotal,
    totalRoutingGapHeight:
      (metrics.totalRoutingGapHeight || 0) * SOFT_WEIGHTS.totalRoutingGapHeight,
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
  // Canonical tie-break only — previous layout must not influence ranking.
  return String(left.candidateId || '').localeCompare(String(right.candidateId || ''));
}
