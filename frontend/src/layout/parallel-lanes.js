/**
 * Parallel corridor lane assignment for unrelated near-parallel routes.
 *
 * same familyKey → may share stem/bus/junction
 * different familyKey + interacting spans + cross-axis gap < MIN_PARALLEL_GAP
 *   → must receive separated lanes
 *
 * Segment roles / priority (high → low):
 *   1. anchored-stem (two-parent spouse midpoint) — IMMUTABLE
 *   2. anchored-stem (single-parent card edge)    — IMMUTABLE
 *   3. drop (child card approach)                 — IMMUTABLE
 *   4. bus / other routing verticals              — movable
 *
 * Anchored family stems are never lane-shifted. Conflicting lower-priority
 * routes move away. Vertical conflicts use strict Y/X overlap; horizontal
 * buses still use PARALLEL_SPAN_JOIN_PAD for visual rail grouping.
 *
 * Offsets for N movable lanes are centered:
 *   N=2: -g/2, +g/2
 *   N=3: -g, 0, +g
 * and then pushed away from immovable obstacles so every interacting
 * unrelated pair ends up >= MIN_PARALLEL_GAP apart.
 */

export const MIN_PARALLEL_GAP = 16;
/** @deprecated use MIN_PARALLEL_GAP */
export const VERTICAL_LANE_GAP = MIN_PARALLEL_GAP;
/** @deprecated use MIN_PARALLEL_GAP */
export const VERTICAL_LANE_THRESHOLD = MIN_PARALLEL_GAP;

/**
 * Collinear peers whose spans abut within this distance still form one visual
 * rail (generation buses separated by about one household step).
 */
export const PARALLEL_SPAN_JOIN_PAD = 240;

const AXIS_EPS = 0.51;
const SHORT_STUB_MAX = 20;
const FLOAT_EPS = 1e-6;

function almostEq(a, b, eps = AXIS_EPS) {
  return Math.abs(a - b) < eps;
}

function familyKeyOf(link) {
  return link.familyKey || `${link.type}:${link.source}->${link.target}`;
}

/**
 * Positive gap between 1D ranges, or <= 0 when they overlap.
 */
function rangeGap(a0, a1, b0, b1) {
  const minA = Math.min(a0, a1);
  const maxA = Math.max(a0, a1);
  const minB = Math.min(b0, b1);
  const maxB = Math.max(b0, b1);
  return Math.max(minA, minB) - Math.min(maxA, maxB);
}

/**
 * Spans interact when they overlap or abut within joinPad.
 */
export function spansInteract(a0, a1, b0, b1, joinPad = PARALLEL_SPAN_JOIN_PAD) {
  return rangeGap(a0, a1, b0, b1) <= joinPad + FLOAT_EPS;
}

/**
 * Collect classified axis-aligned segments.
 * @param {object[]} links
 * @param {'vertical'|'horizontal'} direction
 * @param {Map<string,{x:number,y:number}>|null} nodesById
 */
function anchoredStemPriority(junction) {
  if (!junction) return 0;
  if (junction.kind === 'spouse-junction') return 1;
  if (junction.kind === 'single-parent-junction') return 2;
  return 0;
}

function classifyParallelSegment({ direction, axis, link, target }) {
  const junction = link.junction;
  const anchorPriority = anchoredStemPriority(junction);
  const isAnchoredAxis =
    Boolean(junction) &&
    (direction === 'vertical' ? almostEq(axis, junction.x) : almostEq(axis, junction.y));

  if (direction === 'horizontal') {
    const isChildRail = Boolean(target && almostEq(axis, target.y));
    if (isChildRail) {
      return { role: 'drop', movable: false, priority: 3 };
    }
    if (anchorPriority && isAnchoredAxis) {
      return { role: 'anchored-stem', movable: false, priority: anchorPriority };
    }
    return { role: 'bus', movable: true, priority: 4 };
  }

  // vertical segments
  const isChildDrop = Boolean(target && almostEq(axis, target.x));
  if (anchorPriority && isAnchoredAxis && !isChildDrop) {
    return { role: 'anchored-stem', movable: false, priority: anchorPriority };
  }
  if (isChildDrop) {
    // Child under an anchored junction shares X with the stem; keep drop role
    // but still immovable. Same familyKey skips self-conflicts.
    if (anchorPriority && isAnchoredAxis) {
      return { role: 'drop', movable: false, priority: 3 };
    }
    return { role: 'drop', movable: false, priority: 3 };
  }
  if (anchorPriority && isAnchoredAxis) {
    return { role: 'anchored-stem', movable: false, priority: anchorPriority };
  }
  return { role: 'stem', movable: true, priority: 4 };
}

export function collectParallelSegments(links, direction = 'vertical', nodesById = null) {
  const segs = [];
  for (const link of links || []) {
    if (link.type === 'spouse') continue;
    const points = link.points || [];
    const target = nodesById?.get(String(link.target));

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (direction === 'horizontal') {
        if (!(almostEq(a[1], b[1]) && !almostEq(a[0], b[0]))) continue;
        const span0 = Math.min(a[0], b[0]);
        const span1 = Math.max(a[0], b[0]);
        const length = span1 - span0;
        if (length < SHORT_STUB_MAX) continue; // junction→stem stubs
        const axis = a[1];
        const classified = classifyParallelSegment({
          direction,
          axis,
          span0,
          span1,
          link,
          target,
        });
        segs.push({
          link,
          familyKey: familyKeyOf(link),
          direction,
          role: classified.role,
          movable: classified.movable,
          priority: classified.priority,
          axis,
          span0,
          span1,
          index: i,
        });
      } else {
        if (!(almostEq(a[0], b[0]) && !almostEq(a[1], b[1]))) continue;
        const span0 = Math.min(a[1], b[1]);
        const span1 = Math.max(a[1], b[1]);
        const axis = a[0];
        const classified = classifyParallelSegment({
          direction,
          axis,
          span0,
          span1,
          link,
          target,
        });
        segs.push({
          link,
          familyKey: familyKeyOf(link),
          direction,
          role: classified.role,
          movable: classified.movable,
          priority: classified.priority,
          axis,
          span0,
          span1,
          index: i,
        });
      }
    }
  }
  return segs;
}

/**
 * Span pad by segment direction:
 * Local family buses and vertical stems conflict only on true overlap.
 * Non-overlapping local segments may share a lane (no generation-rail join).
 */
export function spanPadForDirection(direction, override = null) {
  if (override != null) return override;
  return 0;
}

/**
 * Unrelated parallel segment pairs closer than minGap on the cross-axis
 * with interacting spans on the main axis.
 */
export function findParallelGapConflicts(
  links,
  { minGap = MIN_PARALLEL_GAP, spanPad = null, direction = null, nodesById = null } = {},
) {
  const directions = direction ? [direction] : ['vertical', 'horizontal'];
  const conflicts = [];
  for (const dir of directions) {
    const pad = spanPadForDirection(dir, spanPad);
    const segs = collectParallelSegments(links, dir, nodesById);
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        const a = segs[i];
        const b = segs[j];
        if (a.familyKey === b.familyKey) continue;
        // Two immovable segments cannot be separated without moving cards/anchors.
        if (!a.movable && !b.movable) continue;
        const cross = Math.abs(a.axis - b.axis);
        if (cross + FLOAT_EPS >= minGap) continue;
        if (!spansInteract(a.span0, a.span1, b.span0, b.span1, pad)) continue;
        conflicts.push({ a, b, cross, direction: dir });
      }
    }
  }
  return conflicts;
}

/**
 * Legacy name: generation-corridor conflicts (orientation selects direction).
 */
export function findVerticalLaneConflicts(
  links,
  { threshold = MIN_PARALLEL_GAP, orientation = 'vertical', spanPad = null, nodesById = null } = {},
) {
  return findParallelGapConflicts(links, {
    minGap: threshold,
    spanPad,
    direction: orientation === 'horizontal' ? 'horizontal' : 'vertical',
    nodesById,
  });
}

/**
 * Centered symmetric lane offsets so adjacent lanes are exactly `gap` apart.
 */
export function centeredSymmetricOffsets(count, gap = MIN_PARALLEL_GAP) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const offsets = [];
  for (let i = 0; i < count; i += 1) {
    offsets.push((i - (count - 1) / 2) * gap);
  }
  return offsets;
}

/** @deprecated use centeredSymmetricOffsets */
function symmetricLaneOffsets(count, gap) {
  return centeredSymmetricOffsets(count, gap);
}

function unionFind() {
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
  return { find, union, parent };
}

/**
 * Assign offsets for one axis.
 * Movable families are packed into centered lanes, then shifted as a rigid group
 * (and individually if needed) so every movable axis stays >= gap from obstacles
 * and from other movables.
 */
function offsetsForAxis(conflicts, gap) {
  if (!conflicts.length) return new Map();

  const { find, union } = unionFind();
  const movableFamilies = new Set();
  const obstacleAxesByFamily = new Map(); // familyKey -> number[] natural axes of immovable segs
  const naturalAxisSamples = new Map();

  for (const { a, b } of conflicts) {
    for (const seg of [a, b]) {
      if (!naturalAxisSamples.has(seg.familyKey)) naturalAxisSamples.set(seg.familyKey, []);
      naturalAxisSamples.get(seg.familyKey).push(seg.axis);
      if (seg.movable) movableFamilies.add(seg.familyKey);
      else {
        if (!obstacleAxesByFamily.has(seg.familyKey)) obstacleAxesByFamily.set(seg.familyKey, []);
        obstacleAxesByFamily.get(seg.familyKey).push(seg.axis);
      }
    }
    // Cluster movable families that conflict with each other.
    if (a.movable && b.movable) union(a.familyKey, b.familyKey);
    // Movable vs immovable: movable still needs a lane; track via singleton cluster.
    if (a.movable && !b.movable) union(a.familyKey, a.familyKey);
    if (b.movable && !a.movable) union(b.familyKey, b.familyKey);
  }

  const clusters = new Map();
  for (const familyKey of movableFamilies) {
    const root = find(familyKey);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(familyKey);
  }

  function meanAxis(familyKey) {
    const samples = naturalAxisSamples.get(familyKey) || [0];
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }

  const offsets = new Map();

  for (const members of clusters.values()) {
    const sorted = [...members].sort((left, right) => {
      const axisDiff = meanAxis(left) - meanAxis(right);
      if (Math.abs(axisDiff) > FLOAT_EPS) return axisDiff;
      return left.localeCompare(right);
    });

    // Obstacles that interact with this cluster (immovable axes from conflicts).
    const obstacles = [];
    for (const { a, b } of conflicts) {
      const aIn = members.has(a.familyKey);
      const bIn = members.has(b.familyKey);
      if (aIn && !b.movable) obstacles.push(b.axis);
      if (bIn && !a.movable) obstacles.push(a.axis);
      if (!a.movable && bIn) obstacles.push(a.axis);
      if (!b.movable && aIn) obstacles.push(b.axis);
    }
    // Also include immovable axes from members themselves (own drops) — not obstacles to self.
    const uniqueObstacles = [...new Set(obstacles)].sort((a, b) => a - b);

    let laneOffsets = centeredSymmetricOffsets(sorted.length, gap);

    // Preferred natural axes — final axis ≈ meanAxis + offset for stems that start
    // near meanAxis. For families whose conflict samples are already at card drops
    // (shouldn't happen for movable), meanAxis reflects stem samples.
    const preferred = sorted.map((familyKey) => meanAxis(familyKey));
    // Anchor group so mean preferred stays centered: offsets already centered at 0
    // relative to each family's own natural axis.

    // Push group rigidly so all (preferred[i] + laneOffsets[i]) clear obstacles.
    const finalAxes = () => preferred.map((axis, index) => axis + laneOffsets[index]);

    function minObstacleGap(axes) {
      let best = Number.POSITIVE_INFINITY;
      for (const axis of axes) {
        for (const obstacle of uniqueObstacles) {
          best = Math.min(best, Math.abs(axis - obstacle));
        }
      }
      return best;
    }

    if (uniqueObstacles.length) {
      let shift = 0;
      let axes = finalAxes();
      let guard = 0;
      while (minObstacleGap(axes) + FLOAT_EPS < gap && guard < 24) {
        guard += 1;
        // Deterministic push: move group toward the side with more clearance.
        const mid = axes.reduce((sum, value) => sum + value, 0) / axes.length;
        const obsMid =
          uniqueObstacles.reduce((sum, value) => sum + value, 0) / uniqueObstacles.length;
        const step = mid >= obsMid ? gap : -gap;
        shift += step;
        laneOffsets = centeredSymmetricOffsets(sorted.length, gap).map((value) => value + shift);
        axes = finalAxes();
      }
      // If still colliding, place lanes sequentially in free slots around obstacles.
      if (minObstacleGap(axes) + FLOAT_EPS < gap) {
        const occupied = uniqueObstacles.slice().sort((a, b) => a - b);
        const placed = [];
        for (const familyKey of sorted) {
          const natural = meanAxis(familyKey);
          let best = null;
          // Candidate positions: natural, and ±k*gap from each obstacle/natural.
          const candidates = [natural];
          for (const base of [...occupied, natural]) {
            for (let k = 1; k <= sorted.length + 2; k += 1) {
              candidates.push(base + k * gap, base - k * gap);
            }
          }
          candidates.sort((a, b) => Math.abs(a - natural) - Math.abs(b - natural) || a - b);
          for (const candidate of candidates) {
            const okOthers = placed.every((axis) => Math.abs(axis - candidate) + FLOAT_EPS >= gap);
            const okObs = occupied.every((axis) => Math.abs(axis - candidate) + FLOAT_EPS >= gap);
            if (okOthers && okObs) {
              best = candidate;
              break;
            }
          }
          if (best == null) best = natural + (placed.length + 1) * gap;
          placed.push(best);
          offsets.set(familyKey, best - natural);
        }
        continue;
      }
    }

    sorted.forEach((familyKey, index) => {
      offsets.set(familyKey, laneOffsets[index]);
    });
  }

  return offsets;
}

/**
 * Assign cross-axis offsets for unrelated parallel conflicts.
 * @returns {{ offsetXByFamily: Map<string,number>, offsetYByFamily: Map<string,number> }}
 */
export function assignParallelLanes(
  links,
  { gap = MIN_PARALLEL_GAP, spanPad = PARALLEL_SPAN_JOIN_PAD, nodesById = null } = {},
) {
  const verticalConflicts = findParallelGapConflicts(links, {
    minGap: gap,
    spanPad,
    direction: 'vertical',
    nodesById,
  });
  const horizontalConflicts = findParallelGapConflicts(links, {
    minGap: gap,
    spanPad,
    direction: 'horizontal',
    nodesById,
  });
  return {
    offsetXByFamily: offsetsForAxis(verticalConflicts, gap),
    offsetYByFamily: offsetsForAxis(horizontalConflicts, gap),
  };
}

/**
 * Repack bus (offset Y in vertical trees) so final bus coordinates stay inside
 * each family's open generation gap while preserving MIN_PARALLEL_GAP.
 *
 * families: [{ familyKey, parentBottom, childTop, naturalBusY }]
 * offsetYByFamily: Map from assignParallelLanes
 */
export function fitBusOffsetsToGenerationGaps(families, offsetYByFamily, gap = MIN_PARALLEL_GAP) {
  if (!offsetYByFamily?.size || !families?.length) return offsetYByFamily || new Map();

  // Seed with families that already received an offset, then pull in every
  // family that shares an overlapping open generation-gap band so packing
  // cannot slide a bus onto a neighbor that stayed at its natural Y.
  function gapBand(family) {
    return {
      min: family.parentBottom + 1,
      max: family.childTop - 1,
    };
  }
  function bandsOverlap(left, right) {
    const a = gapBand(left);
    const b = gapBand(right);
    return a.min < b.max - FLOAT_EPS && b.min < a.max - FLOAT_EPS;
  }

  const seedKeys = new Set(offsetYByFamily.keys());
  const involved = [];
  for (const family of families) {
    if (seedKeys.has(family.familyKey)) {
      involved.push(family);
      continue;
    }
    for (const seedKey of seedKeys) {
      const seed = families.find((item) => item.familyKey === seedKey);
      if (seed && bandsOverlap(family, seed)) {
        involved.push(family);
        break;
      }
    }
  }
  if (involved.length < 2) return new Map(offsetYByFamily);

  // Cluster families whose open generation gaps overlap.
  const { find, union } = unionFind();
  for (let i = 0; i < involved.length; i += 1) {
    for (let j = i + 1; j < involved.length; j += 1) {
      if (bandsOverlap(involved[i], involved[j])) {
        union(involved[i].familyKey, involved[j].familyKey);
      }
    }
  }

  const clusters = new Map();
  for (const family of involved) {
    const root = find(family.familyKey);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(family);
  }

  const fitted = new Map(offsetYByFamily);
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const sorted = members.slice().sort((left, right) => {
      const axisDiff = left.naturalBusY - right.naturalBusY;
      if (Math.abs(axisDiff) > FLOAT_EPS) return axisDiff;
      const o =
        (offsetYByFamily.get(left.familyKey) || 0) - (offsetYByFamily.get(right.familyKey) || 0);
      if (Math.abs(o) > FLOAT_EPS) return o;
      return left.familyKey.localeCompare(right.familyKey);
    });

    const hardMin = Math.max(...sorted.map((family) => family.parentBottom + 1));
    const hardMax = Math.min(...sorted.map((family) => family.childTop - 1));
    const n = sorted.length;
    const need = (n - 1) * gap;
    if (hardMax - hardMin + FLOAT_EPS < need) {
      // Not enough room: keep prior offsets (caller may expand gap elsewhere).
      continue;
    }
    const start = (hardMin + hardMax - need) / 2;
    sorted.forEach((family, index) => {
      const absolute = start + index * gap;
      fitted.set(family.familyKey, absolute - family.naturalBusY);
    });
  }
  return fitted;
}

/**
 * Legacy: returns only generation-corridor offsets (Map<familyKey, offset>).
 */
export function assignParallelVerticalLanes(
  links,
  {
    gap = MIN_PARALLEL_GAP,
    threshold = MIN_PARALLEL_GAP,
    orientation = 'vertical',
    nodesById = null,
  } = {},
) {
  const direction = orientation === 'horizontal' ? 'horizontal' : 'vertical';
  const conflicts = findParallelGapConflicts(links, {
    minGap: threshold,
    direction,
    nodesById,
  });
  return offsetsForAxis(conflicts, gap);
}

/**
 * Hard geometric metrics for unrelated parallel gaps.
 */
export function measureUnrelatedParallelGaps(
  links,
  { minGap = MIN_PARALLEL_GAP, spanPad = null, nodesById = null } = {},
) {
  let minUnrelatedParallelGap = Number.POSITIVE_INFINITY;
  let parallelGapViolations = 0;
  let interactingPairs = 0;
  const violationPairs = [];

  for (const direction of ['vertical', 'horizontal']) {
    const pad = spanPadForDirection(direction, spanPad);
    const segs = collectParallelSegments(links, direction, nodesById);
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        const a = segs[i];
        const b = segs[j];
        if (a.familyKey === b.familyKey) continue;
        // Immovable pairs (anchored stems / drops) are not lane-fixable.
        if (!a.movable && !b.movable) continue;
        if (!spansInteract(a.span0, a.span1, b.span0, b.span1, pad)) continue;
        interactingPairs += 1;
        const cross = Math.abs(a.axis - b.axis);
        if (cross < minUnrelatedParallelGap) minUnrelatedParallelGap = cross;
        if (cross + FLOAT_EPS < minGap) {
          parallelGapViolations += 1;
          violationPairs.push({
            direction,
            familyA: a.familyKey,
            familyB: b.familyKey,
            cross,
            roleA: a.role,
            roleB: b.role,
          });
        }
      }
    }
  }

  if (!Number.isFinite(minUnrelatedParallelGap)) {
    minUnrelatedParallelGap = minGap;
  }
  return {
    minUnrelatedParallelGap,
    parallelGapViolations,
    interactingPairs,
    violationPairs,
    minGapRequired: minGap,
  };
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

/**
 * Residual hard overlaps: unrelated corridors still closer than MIN_PARALLEL_GAP.
 */
export function findParallelLaneOverlaps(
  links,
  { orientation = null, minGap = MIN_PARALLEL_GAP, spanPad = null, nodesById = null } = {},
) {
  if (orientation === 'vertical' || orientation === 'horizontal') {
    return findParallelGapConflicts(links, {
      minGap,
      spanPad,
      direction: orientation === 'horizontal' ? 'horizontal' : 'vertical',
      nodesById,
    });
  }
  return findParallelGapConflicts(links, { minGap, spanPad, nodesById });
}

function corridorSegments(link, orientation = 'vertical') {
  return collectParallelSegments([link], orientation === 'horizontal' ? 'horizontal' : 'vertical');
}

export { corridorSegments, symmetricLaneOffsets };
