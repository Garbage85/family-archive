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
  findExteriorParentChildDetours,
  findInvalidJunctions,
  routingMetrics,
} from './link-routing.js';
import { countParallelLaneFamilies, findVerticalLaneConflicts } from './parallel-lanes.js';
import { scorePlacementCandidate } from './placement-cost.js';

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
  { expectedVisibleIds = null, households = null, canonicalOrderKey = '' } = {},
) {
  const expected = expectedVisibleIds || (layout.nodes || []).map((node) => String(node.id));
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
  const exterior = findExteriorParentChildDetours(layout);
  const zeroLen = findZeroLengthSegments(layout);
  const selfHits = findSelfIntersectingPolylines(layout);
  const crossings = findUnrelatedLinkIntersections(layout);
  const parity = assertCrossingJumpParity(layout);
  const route = routingMetrics(layout.links);
  const laneConflicts = findVerticalLaneConflicts(layout.links);
  const bounds = boundingBox(layout.nodes);
  const orderKey = generationOrderKey(households || layout.households);
  const orderingInstability =
    canonicalOrderKey && orderKey && orderKey !== canonicalOrderKey ? 1 : 0;

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
    unrelatedCollinearOverlaps: collinear.length,
    zeroLengthSegments: zeroLen.length,
    selfIntersections: selfHits.length,
    missingRequiredJumps: parity.missedJumps,
    falseJumps: parity.falseJumps,
    exteriorDetours: exterior.length,
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
    familyInterleave: familyInterleaveFromHouseholds(households || layout.households),
    bends: route.maxBendsPerParentChild,
    routeLength: route.totalParentChildLength,
    width: bounds.width,
    height: bounds.height,
    orderingInstability,
    displayedCount: layout.nodes?.length || 0,
    householdCount: (households || layout.households || []).length,
    spouseSide: layout.meta?.spouseSide || null,
    boundingBox: bounds,
    routingBounds: route.routingBounds,
    orderKey,
    parity,
  };

  const score = scorePlacementCandidate(metrics);
  return { ...metrics, ...score };
}

export function householdOrderingByGeneration(households) {
  const byGen = new Map();
  for (const household of households || []) {
    const g = household.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push({
      id: household.id,
      memberIds: household.memberIds,
      side: household.side || null,
    });
  }
  return [...byGen.keys()]
    .sort((a, b) => a - b)
    .map((g) => ({
      generation: g,
      households: byGen.get(g),
      memberOrder: byGen.get(g).flatMap((household) => household.memberIds),
    }));
}

export function summarizeCandidateRow(candidateId, metrics) {
  return {
    candidate: candidateId,
    spouseSide: metrics.spouseSide,
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
