/**
 * Routing demand estimation and dynamic generation corridors.
 *
 * Pipeline role:
 *   PHASE B — estimate required lanes per generation gap from cross-axis placement
 *   PHASE C — turn lane counts into generation baselines (whole generations move)
 *
 * Formula (explicit):
 *   routingCorridorHeight(K) =
 *     2 * ROUTING_EDGE_PADDING + max(0, K - 1) * ROUTING_LANE_GAP
 *
 *   K=0 or K=1 → 48
 *   K=2       → 68
 *   K=10      → 24 + 9*20 + 24 = 228
 *
 * Lane axis inside a corridor (generation-axis increasing toward children):
 *   corridorStart + ROUTING_EDGE_PADDING + laneIndex * ROUTING_LANE_GAP
 *
 * Conflict spans use the same join pad as parallel-lane validators so demand
 * lane counts match residual parallelGapViolations / laneConflicts checks.
 */

import { PARALLEL_SPAN_JOIN_PAD, spansInteract } from './parallel-lanes.js';

export const ROUTING_LANE_GAP = 20;
export const ROUTING_EDGE_PADDING = 24;

const EPS = 1e-6;

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function rangesOverlap(a0, a1, b0, b1, pad = PARALLEL_SPAN_JOIN_PAD) {
  return spansInteract(a0, a1, b0, b1, pad);
}

/**
 * Open routing corridor height for K independent lanes.
 * Lane spacing never shrinks as K grows.
 */
export function routingCorridorHeight(laneCount) {
  const k = Math.max(0, Math.floor(Number(laneCount) || 0));
  if (k <= 1) return 2 * ROUTING_EDGE_PADDING;
  return 2 * ROUTING_EDGE_PADDING + (k - 1) * ROUTING_LANE_GAP;
}

/**
 * Absolute axis coordinate of laneIndex inside a corridor that starts at corridorStart
 * (parent-card outer edge facing children).
 */
export function laneAxisInCorridor(corridorStart, laneIndex) {
  return corridorStart + ROUTING_EDGE_PADDING + laneIndex * ROUTING_LANE_GAP;
}

export function gapKey(fromGen, toGen) {
  return `${fromGen}->${toGen}`;
}

function parseGapKey(key) {
  const [from, to] = String(key).split('->').map(Number);
  return { fromGen: from, toGen: to };
}

/**
 * Cross-axis span of a parent→children bus (independent of generation-axis).
 */
function familyCrossSpan(parents, children, isHorizontal) {
  const parentCross = parents.map((node) => (isHorizontal ? node.y : node.x));
  const childCross = children.map((node) => (isHorizontal ? node.y : node.x));
  const parentMid =
    parentCross.reduce((sum, value) => sum + value, 0) / Math.max(1, parentCross.length);
  const all = [...parentCross, ...childCross, parentMid];
  return {
    span0: Math.min(...all),
    span1: Math.max(...all),
    parentMid,
  };
}

/**
 * Greedy deterministic graph coloring.
 * Nodes ordered by span0, then id. Lowest available color.
 */
export function colorConflictGraph(corridors, { spanPad = PARALLEL_SPAN_JOIN_PAD } = {}) {
  const sorted = [...corridors].sort(
    (left, right) => left.span0 - right.span0 || left.id.localeCompare(right.id),
  );
  const colorById = new Map();
  let maxColor = -1;

  for (const corridor of sorted) {
    const used = new Set();
    for (const other of sorted) {
      if (other.id === corridor.id) continue;
      if (!colorById.has(other.id)) continue;
      if (!rangesOverlap(corridor.span0, corridor.span1, other.span0, other.span1, spanPad)) {
        continue;
      }
      used.add(colorById.get(other.id));
    }
    let color = 0;
    while (used.has(color)) color += 1;
    colorById.set(corridor.id, color);
    if (color > maxColor) maxColor = color;
  }

  return {
    colorById,
    laneCount: maxColor < 0 ? 0 : maxColor + 1,
  };
}

/**
 * Build parent families from draft parent-child links + placed nodes.
 */
export function buildDemandFamilies(nodes, links, isHorizontal = false) {
  const byId = new Map((nodes || []).map((node) => [String(node.id), node]));
  const childToParents = new Map();

  for (const link of links || []) {
    if (link.type !== 'parent-child') continue;
    const childId = String(link.target);
    const parentId = String(link.source);
    if (!byId.has(childId) || !byId.has(parentId)) continue;
    if (!childToParents.has(childId)) childToParents.set(childId, new Set());
    childToParents.get(childId).add(parentId);
  }

  const families = new Map();
  for (const [childId, parentSet] of childToParents) {
    const parentIds = [...parentSet].sort();
    const key = parentIds.join('+');
    if (!families.has(key)) {
      families.set(key, {
        key,
        familyKey: `fam:${key}`,
        parentIds,
        childIds: [],
      });
    }
    families.get(key).childIds.push(childId);
  }

  return [...families.values()]
    .map((family) => {
      const parents = family.parentIds.map((id) => byId.get(id)).filter(Boolean);
      const children = unique(family.childIds)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .sort((left, right) => {
          const a = isHorizontal ? left.y : left.x;
          const b = isHorizontal ? right.y : right.x;
          return a - b || left.id.localeCompare(right.id);
        });
      if (!parents.length || !children.length) return null;
      const parentGens = parents.map((node) => node.generation ?? 0);
      const childGens = children.map((node) => node.generation ?? 0);
      const fromGen = Math.max(...parentGens);
      const toGen = Math.min(...childGens);
      const span = familyCrossSpan(parents, children, isHorizontal);
      return {
        ...family,
        parents,
        children,
        fromGen,
        toGen,
        gap: gapKey(fromGen, toGen),
        span0: span.span0,
        span1: span.span1,
        parentMid: span.parentMid,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.familyKey.localeCompare(right.familyKey));
}

/**
 * PHASE B: estimate required lanes per generation gap from cross-axis placement.
 * Does not require final generation-axis coordinates.
 */
export function estimateRoutingDemand({
  nodes,
  links,
  orientation = 'vertical',
  generations = null,
} = {}) {
  const isHorizontal = orientation === 'horizontal';
  const families = buildDemandFamilies(nodes, links, isHorizontal);
  const gens =
    generations ||
    [...new Set((nodes || []).map((node) => node.generation ?? 0))].sort((a, b) => a - b);

  // Ensure adjacent logical gaps exist even if empty.
  const gapKeys = [];
  for (let i = 0; i < gens.length - 1; i += 1) {
    gapKeys.push(gapKey(gens[i], gens[i + 1]));
  }

  const familiesByGap = new Map(gapKeys.map((key) => [key, []]));
  for (const family of families) {
    // Map non-adjacent spans onto the parent→next corridor when possible.
    let key = family.gap;
    if (!familiesByGap.has(key)) {
      const next = family.fromGen + 1;
      key = gapKey(family.fromGen, next);
    }
    if (!familiesByGap.has(key)) {
      familiesByGap.set(key, []);
      gapKeys.push(key);
    }
    familiesByGap.get(key).push(family);
  }

  const requiredLaneCountByGap = {};
  const corridorsByGap = {};
  const laneByFamilyKey = new Map();
  let maxLaneCount = 0;
  let totalLaneCount = 0;

  for (const key of gapKeys.sort((a, b) => a.localeCompare(b))) {
    const list = familiesByGap.get(key) || [];
    const corridors = list.map((family) => ({
      id: family.familyKey,
      familyKey: family.familyKey,
      span0: family.span0,
      span1: family.span1,
      fromGen: family.fromGen,
      toGen: family.toGen,
    }));
    const { colorById, laneCount } = colorConflictGraph(corridors);
    requiredLaneCountByGap[key] = laneCount;
    corridorsByGap[key] = corridors.map((corridor) => ({
      ...corridor,
      laneIndex: colorById.get(corridor.id) ?? 0,
    }));
    for (const corridor of corridorsByGap[key]) {
      laneByFamilyKey.set(corridor.familyKey, {
        gap: key,
        laneIndex: corridor.laneIndex,
        span0: corridor.span0,
        span1: corridor.span1,
      });
    }
    maxLaneCount = Math.max(maxLaneCount, laneCount);
    totalLaneCount += laneCount;
  }

  const routingGapHeightByGap = {};
  let totalRoutingGapHeight = 0;
  for (const key of Object.keys(requiredLaneCountByGap)) {
    const height = routingCorridorHeight(requiredLaneCountByGap[key]);
    routingGapHeightByGap[key] = height;
    totalRoutingGapHeight += height;
  }

  return {
    orientation,
    generations: gens,
    families,
    requiredLaneCountByGap,
    routingGapHeightByGap,
    corridorsByGap,
    laneByFamilyKey,
    maxLaneCount,
    totalLaneCount,
    totalRoutingGapHeight,
    requiredLaneCountTotal: totalLaneCount,
    constants: {
      ROUTING_LANE_GAP,
      ROUTING_EDGE_PADDING,
    },
  };
}

/**
 * PHASE C: generation baselines from required lane counts.
 * Whole generations share one baseline — never per-card generation shifts.
 *
 * distance(baseline[g], baseline[g+1]) = cardAlongAxis + routingCorridorHeight(K)
 */
export function computeGenerationBaselines({
  generations,
  requiredLaneCountByGap,
  cardAlongAxis,
  centerGeneration = 0,
} = {}) {
  const gens = [...(generations || [])].sort((a, b) => a - b);
  const baselines = new Map();
  if (!gens.length) return baselines;

  const center = gens.includes(centerGeneration) ? centerGeneration : gens[0];
  baselines.set(center, 0);

  const centerIndex = gens.indexOf(center);
  for (let i = centerIndex; i < gens.length - 1; i += 1) {
    const g = gens[i];
    const next = gens[i + 1];
    const k = requiredLaneCountByGap[gapKey(g, next)] || 0;
    const step = cardAlongAxis + routingCorridorHeight(k);
    baselines.set(next, baselines.get(g) + step);
  }
  for (let i = centerIndex; i > 0; i -= 1) {
    const g = gens[i];
    const prev = gens[i - 1];
    const k = requiredLaneCountByGap[gapKey(prev, g)] || 0;
    const step = cardAlongAxis + routingCorridorHeight(k);
    baselines.set(prev, baselines.get(g) - step);
  }
  return baselines;
}

/**
 * Apply generation baselines to Phase-A positions (cross-axis preserved).
 */
export function applyGenerationBaselines(nodePositions, generationMap, baselines, isHorizontal) {
  const out = new Map();
  for (const [id, pos] of nodePositions) {
    const g = generationMap.get(String(id)) ?? generationMap.get(id) ?? 0;
    const axis = baselines.has(g) ? baselines.get(g) : isHorizontal ? pos.x : pos.y;
    if (isHorizontal) out.set(id, { x: axis, y: pos.y });
    else out.set(id, { x: pos.x, y: axis });
  }
  return out;
}

/**
 * Attach absolute lane axes after baselines are known.
 */
export function finalizeRoutingPlan(demand, { baselines, cardAlongHalf, isHorizontal = false }) {
  const laneByFamilyKey = new Map();
  for (const [familyKey, entry] of demand.laneByFamilyKey) {
    const { fromGen } = parseGapKey(entry.gap);
    const parentBaseline = baselines.get(fromGen);
    if (!Number.isFinite(parentBaseline)) {
      laneByFamilyKey.set(familyKey, { ...entry, axis: null });
      continue;
    }
    // Corridor starts at the child-facing outer edge of the parent generation.
    const corridorStart = isHorizontal
      ? parentBaseline + cardAlongHalf
      : parentBaseline + cardAlongHalf;
    const axis = laneAxisInCorridor(corridorStart, entry.laneIndex);
    laneByFamilyKey.set(familyKey, { ...entry, axis, corridorStart });
  }
  return {
    ...demand,
    laneByFamilyKey,
    baselines: Object.fromEntries(baselines),
  };
}

/**
 * Count residual lane conflicts after routing (same lane axis, overlapping spans).
 */
export function countLaneConflicts(
  links,
  { orientation = 'vertical', minGap = ROUTING_LANE_GAP } = {},
) {
  const isHorizontal = orientation === 'horizontal';
  const buses = [];
  for (const link of links || []) {
    if (link.type !== 'parent-child') continue;
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (isHorizontal) {
        if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) <= EPS) continue; // skip true H?
        // generation-crossing buses are vertical (const X) in horizontal orientation
        if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) > EPS) {
          buses.push({
            familyKey: link.familyKey,
            axis: a[0],
            span0: Math.min(a[1], b[1]),
            span1: Math.max(a[1], b[1]),
          });
        }
      } else if (Math.abs(a[1] - b[1]) <= EPS && Math.abs(a[0] - b[0]) > 20) {
        buses.push({
          familyKey: link.familyKey,
          axis: a[1],
          span0: Math.min(a[0], b[0]),
          span1: Math.max(a[0], b[0]),
        });
      }
    }
  }

  let conflicts = 0;
  for (let i = 0; i < buses.length; i += 1) {
    for (let j = i + 1; j < buses.length; j += 1) {
      const a = buses[i];
      const b = buses[j];
      if (!a.familyKey || a.familyKey === b.familyKey) continue;
      if (Math.abs(a.axis - b.axis) + EPS >= minGap) continue;
      if (!rangesOverlap(a.span0, a.span1, b.span0, b.span1)) continue;
      conflicts += 1;
    }
  }
  return conflicts;
}

/**
 * Buses whose axis sits outside the open corridor between parent and child cards.
 */
export function findRoutingOutsideGenerationGap(layout, { orientation = 'vertical' } = {}) {
  const isHorizontal = orientation === 'horizontal';
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const hits = [];

  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    const parent = byId.get(String(link.source));
    const child = byId.get(String(link.target));
    if (!parent || !child) continue;
    const halfParent = isHorizontal ? (parent.width ?? 184) / 2 : (parent.height ?? 170) / 2;
    const halfChild = isHorizontal ? (child.width ?? 184) / 2 : (child.height ?? 170) / 2;
    const corridorStart = isHorizontal ? parent.x + halfParent : parent.y + halfParent;
    const corridorEnd = isHorizontal ? child.x - halfChild : child.y - halfChild;
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const isBus = isHorizontal
        ? Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) > 20
        : Math.abs(a[1] - b[1]) <= EPS && Math.abs(a[0] - b[0]) > 20;
      if (!isBus) continue;
      const axis = isHorizontal ? a[0] : a[1];
      if (axis < corridorStart - EPS || axis > corridorEnd + EPS) {
        hits.push({
          link: `${link.source}->${link.target}`,
          familyKey: link.familyKey,
          axis,
          corridorStart,
          corridorEnd,
        });
      }
    }
  }
  return hits;
}

/**
 * PHASE B→C on provisional nodes: demand + baselines + absolute lane axes.
 * Does not route polylines (PHASE D is routeLayoutLinks).
 */
export function planDynamicGenerationGaps({
  nodes,
  links,
  orientation = 'vertical',
  cardWidth = 184,
  cardHeight = 170,
  centerGeneration = 0,
} = {}) {
  const isHorizontal = orientation === 'horizontal';
  const cardAlong = isHorizontal ? cardWidth : cardHeight;
  const cardAlongHalf = cardAlong / 2;
  const demand = estimateRoutingDemand({ nodes, links, orientation });
  const baselines = computeGenerationBaselines({
    generations: demand.generations,
    requiredLaneCountByGap: demand.requiredLaneCountByGap,
    cardAlongAxis: cardAlong,
    centerGeneration,
  });
  const generationMap = new Map(
    (nodes || []).map((node) => [String(node.id), node.generation ?? 0]),
  );
  const provisionalPositions = new Map(
    (nodes || []).map((node) => [String(node.id), { x: node.x, y: node.y }]),
  );
  const finalPositions = applyGenerationBaselines(
    provisionalPositions,
    generationMap,
    baselines,
    isHorizontal,
  );
  const placedNodes = (nodes || []).map((node) => {
    const pos = finalPositions.get(String(node.id)) || { x: node.x, y: node.y };
    return { ...node, x: pos.x, y: pos.y };
  });
  const routingPlan = finalizeRoutingPlan(demand, {
    baselines,
    cardAlongHalf,
    isHorizontal,
  });
  return {
    nodes: placedNodes,
    links: (links || []).map((link) => ({ ...link, points: [] })),
    demand,
    routingPlan,
    baselines,
  };
}

/**
 * Adjacent lane axes inside one gap must differ by exactly ROUTING_LANE_GAP.
 */
export function adjacentLaneAxisGap(axisValues) {
  const unique = [...new Set(axisValues.map(Number))]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < unique.length; i += 1) gaps.push(unique[i] - unique[i - 1]);
  return { axes: unique, gaps };
}

export { parseGapKey, rangesOverlap };
