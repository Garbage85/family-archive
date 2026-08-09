/**
 * Parallel corridor lane assignment for unrelated near-collinear routes.
 *
 * same familyKey → may share stem/junction
 * different familyKey + overlapping range at same/near axis → separate lanes
 *
 * Vertical orientation: separate by X (parallel vertical stems).
 * Horizontal orientation: separate by Y (parallel horizontal stems).
 *
 * Deterministic symmetric offsets: 0, -gap, +gap, -2gap, +2gap, ...
 */

export const VERTICAL_LANE_GAP = 14;
export const VERTICAL_LANE_THRESHOLD = 14;

function almostEq(a, b, eps = 0.51) {
  return Math.abs(a - b) < eps;
}

function rangesOverlap(a0, a1, b0, b1, pad = 0) {
  const minA = Math.min(a0, a1);
  const maxA = Math.max(a0, a1);
  const minB = Math.min(b0, b1);
  const maxB = Math.max(b0, b1);
  return minA <= maxB + pad && minB <= maxA + pad;
}

function familyKeyOf(link) {
  return link.familyKey || `${link.type}:${link.source}->${link.target}`;
}

/**
 * Corridor segments that run along the generation-crossing direction.
 * vertical orientation → vertical segments (const X)
 * horizontal orientation → horizontal segments (const Y)
 */
function corridorSegments(link, orientation = 'vertical') {
  const segs = [];
  const points = link.points || [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (orientation === 'horizontal') {
      if (almostEq(a[1], b[1]) && !almostEq(a[0], b[0])) {
        segs.push({
          link,
          familyKey: familyKeyOf(link),
          axis: a[1],
          span0: Math.min(a[0], b[0]),
          span1: Math.max(a[0], b[0]),
          index: i,
        });
      }
    } else if (almostEq(a[0], b[0]) && !almostEq(a[1], b[1])) {
      segs.push({
        link,
        familyKey: familyKeyOf(link),
        axis: a[0],
        span0: Math.min(a[1], b[1]),
        span1: Math.max(a[1], b[1]),
        index: i,
      });
    }
  }
  return segs;
}

/**
 * Cluster unrelated corridor segments that share axis (or are within threshold)
 * and have overlapping span ranges.
 */
export function findVerticalLaneConflicts(
  links,
  { threshold = VERTICAL_LANE_THRESHOLD, orientation = 'vertical' } = {},
) {
  const segs = (links || []).flatMap((link) => corridorSegments(link, orientation));
  const conflicts = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const a = segs[i];
      const b = segs[j];
      if (a.familyKey === b.familyKey) continue;
      if (Math.abs(a.axis - b.axis) > threshold) continue;
      if (!rangesOverlap(a.span0, a.span1, b.span0, b.span1, 1)) continue;
      conflicts.push({ a, b });
    }
  }
  return conflicts;
}

function symmetricLaneOffsets(count, gap) {
  const offsets = [0];
  let step = 1;
  while (offsets.length < count) {
    offsets.push(-step * gap);
    if (offsets.length >= count) break;
    offsets.push(step * gap);
    step += 1;
  }
  return offsets.slice(0, count);
}

/**
 * Assign axis offsets per familyKey for conflicting corridor clusters.
 * Returns Map<familyKey, offset>.
 */
export function assignParallelVerticalLanes(
  links,
  { gap = VERTICAL_LANE_GAP, threshold = VERTICAL_LANE_THRESHOLD, orientation = 'vertical' } = {},
) {
  const conflicts = findVerticalLaneConflicts(links, { threshold, orientation });
  if (!conflicts.length) return new Map();

  const parent = new Map();
  function find(id) {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const root = ra < rb ? ra : rb;
    const child = ra < rb ? rb : ra;
    parent.set(child, root);
  }

  for (const { a, b } of conflicts) union(a.familyKey, b.familyKey);

  const clusters = new Map();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(key);
  }

  // Also include every key seen in conflicts (union-find only indexes via union).
  for (const { a, b } of conflicts) {
    const rootA = find(a.familyKey);
    const rootB = find(b.familyKey);
    if (!clusters.has(rootA)) clusters.set(rootA, new Set());
    if (!clusters.has(rootB)) clusters.set(rootB, new Set());
    clusters.get(rootA).add(a.familyKey);
    clusters.get(rootB).add(b.familyKey);
  }

  const offsets = new Map();
  for (const members of clusters.values()) {
    if (members.size < 2) continue;
    const sorted = [...members].sort((a, b) => a.localeCompare(b));
    const laneOffsets = symmetricLaneOffsets(sorted.length, gap);
    sorted.forEach((familyKey, index) => {
      offsets.set(familyKey, laneOffsets[index]);
    });
  }
  return offsets;
}

/**
 * Apply familyKey offsets to link polylines (legacy helper; prefer re-route).
 */
export function applyVerticalLaneOffsets(links, offsetByFamily, orientation = 'vertical') {
  if (!offsetByFamily?.size) {
    return (links || []).map((link) => ({ ...link }));
  }

  return (links || []).map((link) => {
    const d = offsetByFamily.get(familyKeyOf(link)) || 0;
    if (!d) return { ...link, jumps: [] };
    const points = (link.points || []).map((point, index, arr) => {
      if (index === 0 || index === arr.length - 1) return [point[0], point[1]];
      return orientation === 'horizontal' ? [point[0], point[1] + d] : [point[0] + d, point[1]];
    });
    return {
      ...link,
      laneOffsetX: d,
      points,
      jumps: [],
    };
  });
}

export function countParallelLaneFamilies(offsetByFamily) {
  let count = 0;
  for (const dx of offsetByFamily.values()) {
    if (dx !== 0) count += 1;
  }
  return count;
}
