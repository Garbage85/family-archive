/**
 * Collect placement/routing metrics for candidate scoring and reports.
 */

import {
  assertCrossingJumpParity,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  findLostVisiblePeople,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  findOverlappingCollinearUnrelatedSegments,
  findUnrelatedLinkIntersections,
  findZeroLengthSegments,
  findSelfIntersectingPolylines,
  boundingBox,
} from './layout-validators.js';
import {
  findChildrenBlockInterleavingViolations,
  findFamilyBusLocalityViolations,
  findUnrelatedFamiliesSharingBusSegment,
  measureFamilyBuses,
  summarizeBusMetrics,
} from './family-bus.js';
import {
  countAnchoredStemViolations,
  findExteriorParentChildDetours,
  findInvalidJunctions,
  routingMetrics,
} from './link-routing.js';
import {
  countParallelLaneFamilies,
  findParallelLaneOverlaps,
  findVerticalLaneConflicts,
  measureUnrelatedParallelGaps,
  MIN_PARALLEL_GAP,
} from './parallel-lanes.js';
import { scorePlacementCandidate } from './placement-cost.js';
import {
  compareGrowthStability,
  countBranchIntegrityViolations,
  countFamilySideViolations,
  countParentSiblingBranchSideViolations,
} from './placement-optimizer.js';
import {
  countLaneConflicts,
  findRoutingOutsideGenerationGap,
  ROUTING_LANE_GAP,
} from './routing-demand.js';

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function countMissingSiblingSpouses(people, layout) {
  const shown = new Set((layout.nodes || []).map((node) => String(node.id)));
  const byId = new Map((people || []).map((person) => [String(person.id), person]));
  let missing = 0;
  for (const id of shown) {
    const person = byId.get(id);
    if (!person) continue;
    for (const spouseId of person.rels?.spouses || []) {
      if (byId.has(String(spouseId)) && !shown.has(String(spouseId))) missing += 1;
    }
  }
  return missing;
}

function familyInterleaveFromHouseholds(households) {
  let flips = 0;
  let lastSide = null;
  for (const household of households || []) {
    if (household.side !== 'spouse' && household.side !== 'center') continue;
    if (lastSide && lastSide !== household.side) flips += 1;
    lastSide = household.side;
  }
  return Math.max(0, flips - 1);
}

function generationOrderKey(households) {
  const byGen = new Map();
  for (const household of households || []) {
    const g = household.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(household.id);
  }
  return [...byGen.keys()]
    .sort((a, b) => a - b)
    .map((g) => `${g}:${byGen.get(g).join(',')}`)
    .join('|');
}

/**
 * Full metric bundle for one laid-out candidate.
 */
export function collectPlacementMetrics(
  people,
  layout,
  {
    expectedVisibleIds = null,
    households = null,
    canonicalOrderKey = '',
    spouseSide = null,
    householdToBranch = null,
    previousSnapshot = null,
    routingPlan = null,
  } = {},
) {
  const expected = expectedVisibleIds || (layout.nodes || []).map((node) => String(node.id));
  const usedHouseholds = households || layout.households;
  const lostNodes = findLostVisiblePeople(expected, layout);
  const overlaps = findCardOverlaps(layout.nodes);
  const missingPC = findMissingVisibleParentChildLinks(people, layout);
  const missingSpouse = findMissingVisibleSpouseLinks(people, layout);
  const missingSiblingSpouses = countMissingSiblingSpouses(people, layout);
  const through = findLinksThroughForeignCards(layout);
  const ambiguous = findAmbiguousSharedSegments(layout);
  const collinear = findOverlappingCollinearUnrelatedSegments(layout);
  const falseJunctions = findFalseJunctionsBetweenUnrelatedFamilies(layout);
  const invalidJunctions = findInvalidJunctions(layout);
  const anchored = countAnchoredStemViolations(layout);
  const exterior = findExteriorParentChildDetours(layout);
  const zeroLen = findZeroLengthSegments(layout);
  const selfHits = findSelfIntersectingPolylines(layout);
  const crossings = findUnrelatedLinkIntersections(layout);
  const parity = assertCrossingJumpParity(layout);
  const route = routingMetrics(layout.links);
  const laneConflicts = findVerticalLaneConflicts(layout.links);
  const bounds = boundingBox(layout.nodes);
  const orderKey = generationOrderKey(usedHouseholds);
  const orderingInstability =
    canonicalOrderKey && orderKey && orderKey !== canonicalOrderKey ? 1 : 0;

  const side = spouseSide || layout.meta?.spouseSide || null;
  let familySideViolations = 0;
  if (side) {
    const byGen = new Map();
    for (const household of usedHouseholds || []) {
      const g = household.generation ?? 0;
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g).push(household);
    }
    for (const row of byGen.values()) {
      familySideViolations += countFamilySideViolations(row, side);
    }
  }
  const branchIntegrityViolations = countBranchIntegrityViolations(
    usedHouseholds,
    householdToBranch,
  );
  const parentSiblingBranchSideViolations = countParentSiblingBranchSideViolations(
    usedHouseholds,
    householdToBranch,
    side,
  );
  const nodesById = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const orientation = layout.meta?.orientation || 'vertical';
  const parallelGaps = measureUnrelatedParallelGaps(layout.links, { nodesById });
  const parallelGapViolations = parallelGaps.parallelGapViolations;
  const minUnrelatedParallelGap = parallelGaps.minUnrelatedParallelGap;
  // Residual hard overlaps after lane assignment.
  const parallelLaneOverlap = findParallelLaneOverlaps(layout.links, { nodesById }).length;
  const structuredLaneConflicts = countLaneConflicts(layout.links, {
    orientation,
    minGap: ROUTING_LANE_GAP,
  });
  const outsideGap = findRoutingOutsideGenerationGap(layout, { orientation });
  const busRows = measureFamilyBuses(layout, { orientation, people });
  const busSummary = summarizeBusMetrics(busRows);
  const busLocality = findFamilyBusLocalityViolations(layout, { orientation, people });
  const sharedBus = findUnrelatedFamiliesSharingBusSegment(layout, { orientation });
  const childrenInterleave = findChildrenBlockInterleavingViolations(layout, {
    orientation,
    people,
  });
  const plan = routingPlan || {
    requiredLaneCountByGap: layout.meta?.requiredLaneCountByGap,
    routingGapHeightByGap: layout.meta?.routingGapHeightByGap,
    maxLaneCount: layout.meta?.maxLaneCount,
    totalLaneCount: layout.meta?.totalLaneCount,
    totalRoutingGapHeight: layout.meta?.totalRoutingGapHeight,
  };

  const growth = compareGrowthStability(
    previousSnapshot,
    { ...layout, households: usedHouseholds, meta: { ...(layout.meta || {}), spouseSide: side } },
    householdToBranch,
    {
      centerId: layout.meta?.centerId || previousSnapshot?.centerId || null,
      spouseSide: side,
    },
  );

  const metrics = {
    overlaps: overlaps.length,
    lostNodes: lostNodes.length,
    missingPC: missingPC.length,
    missingSpouse: missingSpouse.length,
    missingSiblingSpouses,
    linksThroughCards: through.length,
    falseJunctions: falseJunctions.length,
    ambiguousSharedSegments: ambiguous.length,
    invalidFamilyJunctions: invalidJunctions.length,
    twoParentStemAnchoredToSpouseMidpoint: anchored.twoParentStemAnchoredToSpouseMidpoint,
    singleParentStemAnchoredToCardCenter: anchored.singleParentStemAnchoredToCardCenter,
    familyStemLaneShiftViolations: anchored.familyStemLaneShiftViolations,
    multipleStemsPerParentPair: anchored.multipleStemsPerParentPair,
    familyJunctionMismatch: anchored.familyJunctionMismatch,
    familyBusLocalityViolations: busLocality.length,
    unrelatedFamiliesSharingBusSegment: sharedBus.length,
    childrenBlockInterleavingViolations: childrenInterleave.length,
    foreignHouseholdsUnderBus: busSummary.foreignHouseholdsUnderBus,
    busExcessLength: busSummary.busExcessLength,
    maxBusExcessLength: busSummary.maxBusExcessLength,
    familyHorizontalSpread: busSummary.familyHorizontalSpread,
    maxBusLength: busSummary.maxBusLength,
    familyBusReport: busRows,
    unrelatedCollinearOverlaps: collinear.length,
    zeroLengthSegments: zeroLen.length,
    selfIntersections: selfHits.length,
    missingRequiredJumps: parity.missedJumps,
    falseJumps: parity.falseJumps,
    exteriorDetours: exterior.length,
    familySideViolations,
    branchIntegrityViolations,
    parentSiblingBranchSideViolations,
    parallelLaneOverlap,
    parallelGapViolations,
    minUnrelatedParallelGap,
    minParallelGapRequired: MIN_PARALLEL_GAP,
    laneConflicts: structuredLaneConflicts,
    routingOutsideGenerationGap: outsideGap.length,
    requiredLaneCountByGap: plan?.requiredLaneCountByGap || {},
    routingGapHeightByGap: plan?.routingGapHeightByGap || {},
    maxLaneCount: plan?.maxLaneCount || 0,
    totalLaneCount: plan?.totalLaneCount || 0,
    requiredLaneCountTotal: plan?.totalLaneCount || plan?.requiredLaneCountTotal || 0,
    totalRoutingGapHeight: plan?.totalRoutingGapHeight || 0,
    coldWarmSignatureMismatch: 0,
    existingHouseholdsSideChanges: growth.existingHouseholdsSideChanges,
    existingBranchOrderInversions: growth.existingBranchOrderInversions,
    unexpectedCoupleFlip: growth.unexpectedCoupleFlip,
    crossings: crossings.length,
    jumps: route.uniqueRenderedJumps,
    nearCollinear: laneConflicts.length,
    parallelLanes: countParallelLaneFamilies(
      new Map(
        (layout.links || [])
          .filter((link) => link.laneOffsetX)
          .map((link) => [link.familyKey, link.laneOffsetX]),
      ),
    ),
    parallelLaneConflicts: laneConflicts.length,
    familyInterleave: familyInterleaveFromHouseholds(usedHouseholds),
    bends: route.maxBendsPerParentChild,
    routeLength: route.totalParentChildLength,
    width: bounds.width,
    height: bounds.height,
    orderingInstability,
    displayedCount: layout.nodes?.length || 0,
    householdCount: (usedHouseholds || []).length,
    spouseSide: side,
    boundingBox: bounds,
    routingBounds: route.routingBounds,
    orderKey,
    parity,
  };

  const score = scorePlacementCandidate(metrics);
  return { ...metrics, ...score };
}

export function householdOrderingByGeneration(households, branchOrderByGeneration = null) {
  const byGen = new Map();
  for (const household of households || []) {
    const g = household.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push({
      id: household.id,
      memberIds: household.memberIds,
      side: household.side || null,
      branchId: household.branchId || null,
    });
  }
  return [...byGen.keys()]
    .sort((a, b) => a - b)
    .map((g) => ({
      generation: g,
      households: byGen.get(g),
      memberOrder: byGen.get(g).flatMap((household) => household.memberIds),
      branchOrder: branchOrderByGeneration?.[g] || [],
    }));
}

export function summarizeCandidateRow(candidateId, metrics) {
  return {
    candidate: candidateId,
    spouseSide: metrics.spouseSide,
    familySideViolations: metrics.familySideViolations,
    branchIntegrityViolations: metrics.branchIntegrityViolations,
    parentSiblingBranchSideViolations: metrics.parentSiblingBranchSideViolations,
    parallelLaneOverlap: metrics.parallelLaneOverlap,
    laneConflicts: metrics.laneConflicts,
    maxLaneCount: metrics.maxLaneCount,
    totalLaneCount: metrics.totalLaneCount,
    totalRoutingGapHeight: metrics.totalRoutingGapHeight,
    foreignHouseholdsUnderBus: metrics.foreignHouseholdsUnderBus,
    busExcessLength: metrics.busExcessLength,
    maxBusLength: metrics.maxBusLength,
    familyBusLocalityViolations: metrics.familyBusLocalityViolations,
    childrenBlockInterleavingViolations: metrics.childrenBlockInterleavingViolations,
    existingHouseholdsSideChanges: metrics.existingHouseholdsSideChanges,
    existingBranchOrderInversions: metrics.existingBranchOrderInversions,
    unexpectedCoupleFlip: metrics.unexpectedCoupleFlip,
    crossings: metrics.crossings,
    jumps: metrics.jumps,
    parallelConflicts: metrics.parallelLaneConflicts,
    bends: metrics.bends,
    routeLength: metrics.routeLength,
    width: metrics.width,
    height: metrics.height,
    hardViolations: metrics.hardViolations,
    totalCost: Math.round(metrics.totalCost),
  };
}

export { unique };
