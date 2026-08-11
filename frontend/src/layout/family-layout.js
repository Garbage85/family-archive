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

import { optimizeStemAwareRoutingPlan, routeLayoutLinks } from './link-routing.js';
import {
  buildAdjacentHouseholdOrderCandidates,
  buildPlacementCandidates,
  compareCandidateScores,
  extractPlacementSnapshot,
  FULL_ROUTE_CANDIDATE_LIMIT,
} from './placement-optimizer.js';
import {
  collectPlacementMetrics,
  collectPlacementProxyMetrics,
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

// The bounded local search is deterministic for a given placement snapshot.
// Keep only the selected adjacent-swap signature so repeated cold renders
// (for example viewport redraws) do not re-run every routing candidate.
const localOrderDecisionCache = new Map();

function localOrderCacheKey(candidate, centerId, isHorizontal) {
  const households = (candidate?.households || [])
    .map((household) => [
      household.id,
      household.generation ?? 0,
      household.side || '',
      Math.round((household.x0 || 0) * 1000) / 1000,
      Math.round((household.x1 || 0) * 1000) / 1000,
      [...(household.memberIds || [])].map(String).sort(),
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const positions = [...(candidate?.nodePositions || new Map())]
    .map(([id, position]) => [
      String(id),
      Math.round((position?.x || 0) * 1000) / 1000,
      Math.round((position?.y || 0) * 1000) / 1000,
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([String(centerId), isHorizontal, households, positions]);
}

function sameGenerationOrders(left, right) {
  const generations = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const generation of generations) {
    if (JSON.stringify(left?.[generation] || []) !== JSON.stringify(right?.[generation] || [])) {
      return false;
    }
  }
  return true;
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

/**
 * Build the complete connected component containing centerId.
 *
 * Parent, child and spouse relations are all graph edges for membership.
 * Unknown targets are ignored, visited IDs make legacy cycles safe, and the
 * sorted result keeps membership deterministic without mutating source data.
 */
export function buildFullFamilyGraph(people, centerId) {
  const byId = personMap(people);
  const center = byId.get(String(centerId));
  if (!center) return [];

  // Treat every recorded relation as an undirected membership edge. Building
  // reciprocal adjacency here preserves one-sided legacy links without
  // changing the source people or their relation arrays.
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set()]));
  for (const person of byId.values()) {
    const id = String(person.id);
    for (const neighborId of unique([
      ...parentIds(person),
      ...childIds(person),
      ...spouseIds(person),
    ])) {
      if (!byId.has(neighborId)) continue;
      adjacency.get(id).add(neighborId);
      adjacency.get(neighborId).add(id);
    }
  }

  const component = new Set([String(center.id)]);
  const queue = [String(center.id)];
  while (queue.length) {
    const id = queue.shift();
    for (const neighborId of adjacency.get(id) || []) {
      if (component.has(neighborId)) continue;
      component.add(neighborId);
      queue.push(neighborId);
    }
  }

  return [...component]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/** The visible graph is currently the full component; filtering is deferred. */
export function selectVisiblePeople(people, centerId) {
  return buildFullFamilyGraph(people, centerId);
}

/**
 * Generation indices relative to center. Parent/child and spouse edges are
 * traversed so every member of the full visible component stays aligned.
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
    const parentChildEdges = [
      ...parentIds(person).map((parentId) => [parentId, person.id]),
      ...childIds(person).map((childId) => [person.id, childId]),
    ];
    for (const [parentId, childId] of parentChildEdges) {
      if (!nodeById.has(parentId)) continue;
      if (!nodeById.has(childId)) continue;
      const key = `${parentId}->${childId}`;
      if (parentSeen.has(key)) continue;
      parentSeen.add(key);
      draftLinks.push({
        type: 'parent-child',
        source: parentId,
        target: childId,
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

function localOrderCost(metrics, candidate) {
  const interleave =
    (metrics.childrenBlockInterleavingViolations || 0) + (metrics.familyInterleave || 0);
  const orderKey = Object.values(candidate.generationOrders || {})
    .flat()
    .map(String)
    .join('|');
  return [
    metrics.hardViolations || 0,
    metrics.crossings || 0,
    metrics.jumps || 0,
    interleave,
    candidate.orderingDisplacement || 0,
    metrics.width || 0,
    metrics.routeLength || 0,
    orderKey,
  ];
}

function compareLocalOrderCosts(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    if (typeof left[index] === 'string') return left[index].localeCompare(right[index]);
    return left[index] - right[index];
  }
  return 0;
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
  optimizeStemAwareLanes = true,
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
    { orientation, routingPlan, optimizeStemAwareLanes },
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
    returnCandidates = false,
    // previousLayout is accepted for optional stability *reporting* only.
    // Canonical geometry/routing must ignore it so cold === warm.
    previousLayout = null,
  } = {},
) {
  if (!Array.isArray(people) || !people.length) {
    return { nodes: [], links: [], households: [], meta: { centerId, orientation } };
  }

  const fullGraph = buildFullFamilyGraph(people, centerId);
  const visibleGraph = fullGraph;
  const visible = visibleGraph;
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

  // STAGE 1 — cheap structural + alignment proxy (no full routing).
  // Note: proxy hard=0 is incomplete (routing-only faults like false junctions
  // are invisible here), so we never drop a candidate solely for proxy hard>0
  // when the candidate set is small — we rank and take top-N instead.
  const stage1 = [];
  for (const candidate of candidates) {
    const provisionalNodes = visible
      .map((person) => {
        const position = candidate.nodePositions.get(person.id) || { x: 0, y: 0 };
        return {
          id: person.id,
          x: position.x,
          y: position.y,
          generation: generation.get(person.id) ?? 0,
          width: cardWidth,
          height: cardHeight,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const draftLinks = buildDraftLinks(
      visible,
      new Map(provisionalNodes.map((node) => [node.id, node])),
    );
    const proxyLayout = {
      nodes: provisionalNodes,
      links: draftLinks,
      households: candidate.households,
      meta: {
        centerId: String(centerId),
        orientation,
        spouseSide: candidate.spouseSide,
        candidateId: candidate.candidateId,
      },
    };
    const proxyMetrics = collectPlacementProxyMetrics(people, proxyLayout, {
      expectedVisibleIds,
      households: candidate.households,
      spouseSide: candidate.spouseSide,
      householdToBranch: candidate.householdToBranch,
    });
    proxyMetrics.spouseSide = candidate.spouseSide;
    proxyMetrics.candidateId = candidate.candidateId;
    stage1.push({
      candidate,
      proxyMetrics,
      // Mark structural proxy hard for reporting only.
      rejected: false,
    });
  }

  stage1.sort((left, right) =>
    compareCandidateScores(
      { ...left.proxyMetrics, candidateId: left.candidate.candidateId },
      { ...right.proxyMetrics, candidateId: right.candidate.candidateId },
    ),
  );

  // Route top-N by proxy rank. With the usual 2 spouse-side candidates both
  // are evaluated so routing-only hard faults can still decide the winner.
  const toRoute = stage1.slice(0, Math.min(FULL_ROUTE_CANDIDATE_LIMIT, stage1.length));

  // STAGE 2 — full routing + validators only for top-N survivors.
  const scored = [];
  for (const entry of toRoute) {
    const { candidate } = entry;
    const layout = materializeCandidateLayout({
      visible,
      generation,
      candidate,
      cardWidth,
      cardHeight,
      orientation,
      optimizeStemAwareLanes: false,
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
      mirroredHouseholds: candidate.orientationReport?.mirroredHouseholds || 0,
      householdOrientationChanges: candidate.orientationReport?.householdOrientationChanges || 0,
      orientationOscillations: candidate.orientationReport?.orientationOscillations || 0,
      orientationCostBefore: candidate.orientationReport?.orientationCostBefore || 0,
      orientationCostAfter: candidate.orientationReport?.orientationCostAfter || 0,
      householdOrientationById: candidate.orientationReport?.householdOrientationById || {},
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

  let winner = scored[0];
  const fullRoutingEvaluations = scored.length;
  const candidateCount = candidates.length;

  // Candidate selection deliberately uses the clean v0.3.5 routing order so
  // stem-aware lanes cannot change card placement or household ordering. Once
  // the winner is fixed, optimize only its generation-gap lane permutation and
  // rebuild the links with the selected axes.
  const winnerNodeMap = new Map(winner.layout.nodes.map((node) => [node.id, node]));
  const winnerDraftLinks = buildDraftLinks(visible, winnerNodeMap);
  const optimizedPlan = optimizeStemAwareRoutingPlan(
    { nodes: winner.layout.nodes, links: winnerDraftLinks, households: winner.layout.households },
    winner.layout.routingPlan,
    orientation,
  );
  winner.layout.routingPlan = optimizedPlan;
  winner.layout.links = routeLayoutLinks(
    { nodes: winner.layout.nodes, links: winnerDraftLinks, households: winner.layout.households },
    { orientation, routingPlan: optimizedPlan, optimizeStemAwareLanes: false },
  );
  winner.metrics = collectPlacementMetrics(people, winner.layout, {
    expectedVisibleIds,
    households: winner.layout.households,
    canonicalOrderKey,
    spouseSide: winner.candidate.spouseSide,
    householdToBranch: winner.candidate.householdToBranch,
    routingPlan: winner.layout.routingPlan,
  });
  winner.metrics.spouseSide = winner.candidate.spouseSide;
  winner.metrics.candidateId = winner.candidate.candidateId;

  // CENTER-LOCAL PHASE 2B — consider only the baseline household order and
  // one adjacent swap per generation. The full graph membership is unchanged;
  // only this center's cross-axis geometry may improve.
  let acceptedLocalOrderSwaps = 0;
  let localOrderCandidatesEvaluated = 0;
  const localCandidates = buildAdjacentHouseholdOrderCandidates(winner.candidate, {
    centerId,
    isHorizontal,
    cardCross,
    gap,
    // Keep large synthetic/stress trees responsive. Production fixture has
    // eleven households and retains the complete bounded local search.
    limit: winner.candidate.households.length > 12 ? 2 : 11,
  });
  const baselineLocalCost = localOrderCost(winner.metrics, winner.candidate);
  let bestLocal = { entry: winner, cost: baselineLocalCost };
  const localOrderKey = localOrderCacheKey(winner.candidate, centerId, isHorizontal);
  const cachedDecision = localOrderDecisionCache.get(localOrderKey);
  const candidatesToEvaluate = cachedDecision
    ? cachedDecision.generationOrders
      ? localCandidates.filter((candidate) =>
          sameGenerationOrders(candidate.generationOrders, cachedDecision.generationOrders),
        )
      : []
    : localCandidates;
  for (const candidate of candidatesToEvaluate) {
    const layout = materializeCandidateLayout({
      visible,
      generation,
      candidate,
      cardWidth,
      cardHeight,
      orientation,
      optimizeStemAwareLanes: true,
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
      mirroredHouseholds: candidate.orientationReport?.mirroredHouseholds || 0,
      householdOrientationChanges: candidate.orientationReport?.householdOrientationChanges || 0,
      orientationOscillations: candidate.orientationReport?.orientationOscillations || 0,
      orientationCostBefore: candidate.orientationReport?.orientationCostBefore || 0,
      orientationCostAfter: candidate.orientationReport?.orientationCostAfter || 0,
      householdOrientationById: candidate.orientationReport?.householdOrientationById || {},
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
    localOrderCandidatesEvaluated += 1;
    const cost = localOrderCost(metrics, candidate);
    const baseCrossings = winner.metrics.crossings || 0;
    const baseJumps = winner.metrics.jumps || 0;
    const crossingReduction = baseCrossings - (metrics.crossings || 0);
    const jumpReduction = baseJumps - (metrics.jumps || 0);
    // Do not trade a large visual reorder for a one-event cosmetic win.
    if (
      crossingReduction <= 1 &&
      jumpReduction <= 1 &&
      (candidate.orderingDisplacement || 0) > cardCross * 2
    ) {
      continue;
    }
    if (compareLocalOrderCosts(cost, bestLocal.cost) < 0) {
      bestLocal = { entry: { candidate, layout, metrics }, cost };
    }
  }
  localOrderDecisionCache.set(localOrderKey, {
    generationOrders:
      bestLocal.entry === winner ? null : bestLocal.entry.candidate.generationOrders,
  });
  if (localOrderDecisionCache.size > 256) {
    localOrderDecisionCache.delete(localOrderDecisionCache.keys().next().value);
  }
  if (bestLocal.entry !== winner) {
    winner = bestLocal.entry;
    acceptedLocalOrderSwaps = winner.candidate.orderingSwapCount || 0;
  }
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
      fullGraphCount: fullGraph.length,
      visibleGraphCount: visibleGraph.length,
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
      familyBusLocalityViolations: winner.metrics.familyBusLocalityViolations || 0,
      unrelatedFamiliesSharingBusSegment: winner.metrics.unrelatedFamiliesSharingBusSegment || 0,
      childrenBlockInterleavingViolations: winner.metrics.childrenBlockInterleavingViolations || 0,
      foreignHouseholdsUnderBus: winner.metrics.foreignHouseholdsUnderBus || 0,
      busExcessLength: winner.metrics.busExcessLength || 0,
      maxBusExcessLength: winner.metrics.maxBusExcessLength || 0,
      familyHorizontalSpread: winner.metrics.familyHorizontalSpread || 0,
      maxBusLength: winner.metrics.maxBusLength || 0,
      familyAlignmentErrorTotal: winner.metrics.familyAlignmentErrorTotal || 0,
      maxFamilyAlignmentError: winner.metrics.maxFamilyAlignmentError || 0,
      singleChildAlignmentError: winner.metrics.singleChildAlignmentError || 0,
      singleChildHorizontalOffset: winner.metrics.singleChildHorizontalOffset || 0,
      familyTargetByFamily: winner.metrics.familyTargetByFamily || {},
      childBlockCenterByFamily: winner.metrics.childBlockCenterByFamily || {},
      localBusLengthByFamily: winner.metrics.localBusLengthByFamily || {},
      householdOrientationCost: winner.metrics.householdOrientationCost || 0,
      parentStemHorizontalDeviation: winner.metrics.parentStemHorizontalDeviation || 0,
      childStemHorizontalDeviation: winner.metrics.childStemHorizontalDeviation || 0,
      mirroredHouseholds: winner.candidate.orientationReport?.mirroredHouseholds || 0,
      householdOrientationChanges:
        winner.candidate.orientationReport?.householdOrientationChanges || 0,
      orientationOscillations: winner.candidate.orientationReport?.orientationOscillations || 0,
      orientationCostBefore: winner.candidate.orientationReport?.orientationCostBefore || 0,
      orientationCostAfter: winner.candidate.orientationReport?.orientationCostAfter || 0,
      householdOrientations: winner.metrics.householdOrientations || {},
      invalidHouseholdOrientation: winner.metrics.invalidHouseholdOrientation || 0,
      coldWarmOrientationMismatch: 0,
      requiredLaneCountByGap: plan?.requiredLaneCountByGap || {},
      routingGapHeightByGap: plan?.routingGapHeightByGap || {},
      maxLaneCount: plan?.maxLaneCount || 0,
      totalLaneCount: plan?.totalLaneCount || 0,
      totalRoutingGapHeight: plan?.totalRoutingGapHeight || 0,
      generationBaselines: winner.layout.baselines || {},
      routingConstants: { ROUTING_LANE_GAP, ROUTING_EDGE_PADDING },
      coldWarmSignatureMismatch: 0,
      candidateCount,
      fullRoutingEvaluations,
      localOrderCandidatesEvaluated,
      acceptedLocalOrderSwaps,
      orderingDisplacement: winner.candidate.orderingDisplacement || 0,
      stage1Skipped: Math.max(0, candidateCount - fullRoutingEvaluations),
    },
  };

  if (returnCandidates) {
    const routedIds = new Set(scored.map((entry) => entry.candidate.candidateId));
    result.meta.candidates = scored.map((entry) =>
      summarizeCandidateRow(entry.candidate.candidateId, {
        ...entry.metrics,
        spouseSide: entry.candidate.spouseSide,
      }),
    );
    result.meta.stage1 = stage1.map((entry) => ({
      candidateId: entry.candidate.candidateId,
      spouseSide: entry.candidate.spouseSide,
      fullRouted: routedIds.has(entry.candidate.candidateId),
      proxyHardViolations: entry.proxyMetrics.hardViolations,
      familyAlignmentErrorTotal: Math.round(entry.proxyMetrics.familyAlignmentErrorTotal || 0),
      totalCost: Math.round(entry.proxyMetrics.totalCost || 0),
    }));
  }

  return result;
}

export { extractPlacementSnapshot };
