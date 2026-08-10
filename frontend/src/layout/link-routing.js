/**
 * Orthogonal family-junction link routing for the household layout preview.
 *
 * Couple with children (one familyKey / one junction):
 *
 *   parent A ---- spouse link ---- parent B
 *                     |
 *                family stem
 *                     |
 *                 child bus
 *                /    |    \
 *             child child child
 *
 * Single-parent family: stem from the parent card to the child bus.
 * Multi-spouse: each parent pair that has children gets its own junction.
 *
 * Pipeline after placement:
 *   1) family-junction routes in the generation gap
 *   2) parallel lane separation for near-parallel unrelated H/V corridors
 *   3) line-jumps only for remaining true H×V crossings
 *
 * Exterior overflow buses under the child row are forbidden.
 * Coordinates are display-only and must never be written to trees.data.
 */

import {
  assignParallelLanes,
  fitBusOffsetsToGenerationGaps,
  MIN_PARALLEL_GAP,
} from './parallel-lanes.js';

export const CROSSING_STYLE = 'line-jump';
export const LINE_JUMP_RADIUS = 10;

const LANE_GAP = 16;
const BUS_INSET = 10;
const EPS = 0.51;

function half(node, axis) {
  if (axis === 'x') return (node.width ?? 184) / 2;
  return (node.height ?? 170) / 2;
}

function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

function almostEq(a, b, eps = EPS) {
  return Math.abs(a - b) < eps;
}

function pt(x, y) {
  return [roundCoord(x), roundCoord(y)];
}

function pairKey(ids) {
  return [...ids].map(String).sort().join('+');
}

export function familyKeyForPair(parentIds) {
  return `fam:${pairKey(parentIds)}`;
}

/**
 * Group visible parent-child edges by the set of visible parents of each child.
 * One family = one parent couple/household feeding one or more children.
 */
export function buildParentFamilies(layout) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const families = new Map();

  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    const childId = String(link.target);
    if (!byId.has(childId)) continue;

    const parentIds = (layout.links || [])
      .filter((item) => item.type === 'parent-child' && String(item.target) === childId)
      .map((item) => String(item.source))
      .filter((id) => byId.has(id))
      .sort();
    if (!parentIds.length) continue;

    const key = parentIds.join('+');
    if (!families.has(key)) {
      families.set(key, {
        key,
        parentIds,
        childIds: new Set(),
        parents: parentIds.map((id) => byId.get(id)),
        children: [],
      });
    }
    families.get(key).childIds.add(childId);
  }

  for (const family of families.values()) {
    family.children = [...family.childIds]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((left, right) => left.x - right.x || left.id.localeCompare(right.id));
    const xs = family.parents.map((node) => node.x);
    family.parentMidX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    family.parentMidY =
      family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length;
    family.parentBottom = Math.max(...family.parents.map((node) => node.y + half(node, 'y')));
    family.parentTop = Math.min(...family.parents.map((node) => node.y - half(node, 'y')));
    family.parentRight = Math.max(...family.parents.map((node) => node.x + half(node, 'x')));
    family.parentLeft = Math.min(...family.parents.map((node) => node.x - half(node, 'x')));
    family.childTop = Math.min(...family.children.map((node) => node.y - half(node, 'y')));
    family.childBottom = Math.max(...family.children.map((node) => node.y + half(node, 'y')));
    family.childLeft = Math.min(...family.children.map((node) => node.x - half(node, 'x')));
    family.childMinX = Math.min(...family.children.map((node) => node.x));
    family.childMaxX = Math.max(...family.children.map((node) => node.x));
    family.childMidY =
      family.children.reduce((sum, node) => sum + node.y, 0) / family.children.length;
    family.spanMinX = Math.min(family.parentMidX, family.childMinX);
    family.spanMaxX = Math.max(family.parentMidX, family.childMaxX);
    family.familyKey = familyKeyForPair(family.parentIds);
    family.isCouple = family.parents.length >= 2;
  }

  return [...families.values()].sort(
    (left, right) => left.parentMidX - right.parentMidX || left.key.localeCompare(right.key),
  );
}

function familyCrossesStem(family, other, isHorizontal = false) {
  if (family.key === other.key) return false;
  if (isHorizontal) {
    // In horizontal orientation the cross-axis is Y; a shared bus X is ambiguous
    // when another family's parent mid-Y falls inside this family's child/parent Y span.
    const spanMinY = Math.min(family.parentMidY, ...family.children.map((child) => child.y));
    const spanMaxY = Math.max(family.parentMidY, ...family.children.map((child) => child.y));
    return other.parentMidY > spanMinY + 1e-6 && other.parentMidY < spanMaxY - 1e-6;
  }
  return other.parentMidX > family.spanMinX + 1e-6 && other.parentMidX < family.spanMaxX - 1e-6;
}

/**
 * Distinct lane ranks inside the generation gap so unrelated families do not
 * share one collinear bus trunk. Crossings between lanes remain allowed.
 */
export function assignFamilyLanes(families, isHorizontal = false) {
  const n = families.length;
  if (!n) return families;

  const rank = new Map(families.map((family) => [family.key, 0]));
  let changed = true;
  let guard = 0;
  while (changed && guard < n * n + 2) {
    changed = false;
    guard += 1;
    for (const left of families) {
      for (const right of families) {
        if (!familyCrossesStem(left, right, isHorizontal)) continue;
        const need = rank.get(right.key) + 1;
        if (rank.get(left.key) < need) {
          rank.set(left.key, need);
          changed = true;
        }
      }
    }
  }

  const maxRank = Math.max(0, ...rank.values());
  for (const family of families) {
    family.laneIndex = rank.get(family.key) || 0;
    family.laneT = maxRank === 0 ? 0.45 : 0.3 + (0.4 * family.laneIndex) / maxRank;
    family.laneOffset = family.laneIndex * LANE_GAP;
  }
  return families;
}

function naturalVerticalBusY(family) {
  if (Number.isFinite(family.busAbsolute)) return roundCoord(family.busAbsolute);
  const gap = family.childTop - family.parentBottom;
  const minY = family.parentBottom + BUS_INSET;
  const maxY = family.childTop - BUS_INSET;
  if (maxY <= minY) return roundCoord((family.parentBottom + family.childTop) / 2);
  const t = family.laneT ?? 0.45;
  const busY = family.parentBottom + gap * t;
  return roundCoord(Math.min(maxY, Math.max(minY, busY)));
}

function verticalBusY(family) {
  if (Number.isFinite(family.busAbsolute)) {
    return roundCoord(family.busAbsolute + (family.busOffset || 0));
  }
  const busOffset = family.busOffset || 0;
  const raw = naturalVerticalBusY(family) + busOffset;
  // Legacy path: keep bus inside the open gap.
  const hardMin = family.parentBottom + 1;
  const hardMax = family.childTop - 1;
  if (hardMax <= hardMin) return roundCoord((family.parentBottom + family.childTop) / 2);
  return roundCoord(Math.min(hardMax, Math.max(hardMin, raw)));
}

function naturalHorizontalBusX(family) {
  if (Number.isFinite(family.busAbsolute)) return roundCoord(family.busAbsolute);
  const gap = family.childLeft - family.parentRight;
  const minX = family.parentRight + BUS_INSET;
  const maxX = family.childLeft - BUS_INSET;
  if (maxX <= minX) return roundCoord((family.parentRight + family.childLeft) / 2);
  const t = family.laneT ?? 0.45;
  const busX = family.parentRight + gap * t;
  return roundCoord(Math.min(maxX, Math.max(minX, busX)));
}

function horizontalBusX(family) {
  if (Number.isFinite(family.busAbsolute)) {
    return roundCoord(family.busAbsolute + (family.busOffset || 0));
  }
  const busOffset = family.busOffset || 0;
  const raw = naturalHorizontalBusX(family) + busOffset;
  const hardMin = family.parentRight + 1;
  const hardMax = family.childLeft - 1;
  if (hardMax <= hardMin) return roundCoord((family.parentRight + family.childLeft) / 2);
  return roundCoord(Math.min(hardMax, Math.max(hardMin, raw)));
}

export function simplifyPoints(points) {
  if (!points?.length) return [];
  const out = [];
  for (const point of points) {
    const next = pt(point[0], point[1]);
    const prev = out[out.length - 1];
    if (prev && almostEq(prev[0], next[0]) && almostEq(prev[1], next[1])) continue;
    out.push(next);
  }
  let i = 1;
  while (i < out.length - 1) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const colH = almostEq(a[1], b[1]) && almostEq(b[1], c[1]);
    const colV = almostEq(a[0], b[0]) && almostEq(b[0], c[0]);
    if (colH || colV) out.splice(i, 1);
    else i += 1;
  }
  return out;
}

/**
 * Visible spouse-link endpoints between two parent cards (card-edge to card-edge).
 * Vertical trees: horizontal spouse bar. Horizontal trees: vertical spouse bar.
 */
export function visibleSpouseLinkEndpoints(parentA, parentB, isHorizontal = false) {
  if (isHorizontal) {
    const top = parentA.y <= parentB.y ? parentA : parentB;
    const bottom = parentA.y <= parentB.y ? parentB : parentA;
    const x = (top.x + bottom.x) / 2;
    return {
      start: pt(x, top.y + half(top, 'y')),
      end: pt(x, bottom.y - half(bottom, 'y')),
    };
  }
  const left = parentA.x <= parentB.x ? parentA : parentB;
  const right = parentA.x <= parentB.x ? parentB : parentA;
  const y = (left.y + right.y) / 2;
  return {
    start: pt(left.x + half(left, 'x'), y),
    end: pt(right.x - half(right, 'x'), y),
  };
}

function routeSpouse(source, target, isHorizontal = false) {
  const { start, end } = visibleSpouseLinkEndpoints(source, target, isHorizontal);
  return simplifyPoints([start, end]);
}

/**
 * Spouse-junction for a couple: geometric midpoint of the visible spouse-link.
 * Anchored family stem starts here — never at a lane-shifted X/Y.
 */
export function coupleSpouseJunction(family, isHorizontal = false) {
  if ((family.parents || []).length >= 2) {
    const { start, end } = visibleSpouseLinkEndpoints(
      family.parents[0],
      family.parents[1],
      isHorizontal,
    );
    return {
      x: roundCoord((start[0] + end[0]) / 2),
      y: roundCoord((start[1] + end[1]) / 2),
      kind: 'spouse-junction',
    };
  }
  return {
    x: roundCoord(family.parentMidX),
    y: roundCoord(family.parentMidY),
    kind: 'spouse-junction',
  };
}

/**
 * Single-parent junction: center of the parent card edge facing children.
 */
export function singleParentJunction(parent, isHorizontal = false) {
  if (isHorizontal) {
    return {
      x: roundCoord(parent.x + half(parent, 'x')),
      y: roundCoord(parent.y),
      kind: 'single-parent-junction',
    };
  }
  return {
    x: roundCoord(parent.x),
    y: roundCoord(parent.y + half(parent, 'y')),
    kind: 'single-parent-junction',
  };
}

/**
 * Parent-child polyline for one edge. Couple edges start at the shared spouse
 * junction (not at each parent card), so parents connect through the spouse link.
 *
 * Anchored family stem (junction → bus) keeps the junction cross-axis forever.
 * Parallel-lane offsets must never bend this stem off the spouse midpoint /
 * single-parent card center.
 */
export function routeFamilyParentChild(family, parent, child, isHorizontal) {
  const singleChild = (family.children || []).length <= 1;

  if (isHorizontal) {
    const busX = horizontalBusX(family);
    const junction = family.isCouple
      ? coupleSpouseJunction(family, true)
      : singleParentJunction(parent, true);
    // Single child under the stem: direct generation-axis segment, no bus rail.
    if (singleChild && almostEq(junction.y, child.y)) {
      return simplifyPoints([pt(junction.x, junction.y), pt(child.x - half(child, 'x'), child.y)]);
    }
    // Single child with offset: minimal elbow (stem → short bus → drop).
    if (singleChild) {
      return simplifyPoints([
        pt(junction.x, junction.y),
        pt(busX, junction.y),
        pt(busX, child.y),
        pt(child.x - half(child, 'x'), child.y),
      ]);
    }
    return simplifyPoints([
      pt(junction.x, junction.y),
      pt(busX, junction.y),
      pt(busX, child.y),
      pt(child.x - half(child, 'x'), child.y),
    ]);
  }

  const busY = verticalBusY(family);
  const junction = family.isCouple
    ? coupleSpouseJunction(family, false)
    : singleParentJunction(parent, false);

  // Single child under the stem: one vertical, no horizontal magistral.
  if (singleChild && almostEq(junction.x, child.x)) {
    return simplifyPoints([pt(junction.x, junction.y), pt(child.x, child.y - half(child, 'y'))]);
  }

  // Local bus: stem stays on junction X; horizontal only covers stem→this child
  // (union across siblings forms the family-local bus, never a generation rail).
  return simplifyPoints([
    pt(junction.x, junction.y),
    pt(junction.x, busY),
    pt(child.x, busY),
    pt(child.x, child.y - half(child, 'y')),
  ]);
}

function linkFamilyKey(link) {
  return link.familyKey || `${link.type}:${link.source}->${link.target}`;
}

function segmentsOf(points) {
  const segs = [];
  for (let i = 0; i < (points || []).length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (almostEq(a[0], b[0]) && almostEq(a[1], b[1])) continue;
    segs.push({
      a,
      b,
      index: i,
      horizontal: almostEq(a[1], b[1]),
      vertical: almostEq(a[0], b[0]),
    });
  }
  return segs;
}

/**
 * Orthogonal H×V intersection, INCLUSIVE of endpoints/bends.
 *
 * Root cause of missed live jumps: the previous exclusive parametric test
 * (0 < t,u < 1) dropped crossings that landed exactly on a bend or segment
 * end (e.g. child-drop top where family bus turns into the drop, or a bus
 * tip touching a foreign stem). For unrelated familyKeys those are still
 * crossings and must get a line-jump.
 */
export function orthogonalCrossingPoint(segA, segB) {
  const aH = segA.horizontal;
  const aV = segA.vertical;
  const bH = segB.horizontal;
  const bV = segB.vertical;
  if (!(aH && bV) && !(aV && bH)) return null;

  const horizontal = aH ? segA : segB;
  const vertical = aV ? segA : segB;
  const x = vertical.a[0];
  const y = horizontal.a[1];
  const hMin = Math.min(horizontal.a[0], horizontal.b[0]);
  const hMax = Math.max(horizontal.a[0], horizontal.b[0]);
  const vMin = Math.min(vertical.a[1], vertical.b[1]);
  const vMax = Math.max(vertical.a[1], vertical.b[1]);
  if (x < hMin - 1e-9 || x > hMax + 1e-9) return null;
  if (y < vMin - 1e-9 || y > vMax + 1e-9) return null;

  const onHEnd = almostEq(x, horizontal.a[0]) || almostEq(x, horizontal.b[0]);
  const onVEnd = almostEq(y, vertical.a[1]) || almostEq(y, vertical.b[1]);
  return {
    point: pt(x, y),
    kind: onHEnd || onVEnd ? 'endpoint/bend' : 'interior',
    onHorizontalEndpoint: onHEnd,
    onVerticalEndpoint: onVEnd,
  };
}

/** @deprecated exclusive interior-only test — kept for regression contrast */
export function exclusiveInteriorCrossingPoint(segA, segB) {
  const d =
    (segA.b[0] - segA.a[0]) * (segB.b[1] - segB.a[1]) -
    (segA.b[1] - segA.a[1]) * (segB.b[0] - segB.a[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t =
    ((segB.a[0] - segA.a[0]) * (segB.b[1] - segB.a[1]) -
      (segB.a[1] - segA.a[1]) * (segB.b[0] - segA.a[0])) /
    d;
  const u =
    ((segB.a[0] - segA.a[0]) * (segA.b[1] - segA.a[1]) -
      (segB.a[1] - segA.a[1]) * (segA.b[0] - segA.a[0])) /
    d;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return pt(segA.a[0] + t * (segA.b[0] - segA.a[0]), segA.a[1] + t * (segA.b[1] - segA.a[1]));
}

function sameFamilyKeys(a, b) {
  return Boolean(a && b && a === b);
}

function isIntentionalFamilyJunctionPoint(link, point) {
  const junction = link.junction;
  if (!junction || !Number.isFinite(junction.x) || !Number.isFinite(junction.y)) return false;
  return almostEq(point[0], junction.x) && almostEq(point[1], junction.y);
}

/**
 * Enumerate unrelated H×V crossings (endpoints/bends included).
 *
 * JUNCTION only when both segments share familyKey AND the point is that
 * family's intentional branch/junction. Any other geometric H×V hit between
 * different familyKeys is a CROSSING — even on bends, endpoints, child-drops,
 * or near a foreign junction.
 */
export function findUnrelatedCrossingSites(links) {
  const sites = [];
  const indexed = (links || []).map((link, linkIndex) => ({
    link,
    linkIndex,
    familyKey: linkFamilyKey(link),
    segs: segmentsOf(link.points),
  }));

  for (let i = 0; i < indexed.length; i += 1) {
    for (let j = i + 1; j < indexed.length; j += 1) {
      const left = indexed[i];
      const right = indexed[j];
      const sameFamily = sameFamilyKeys(left.familyKey, right.familyKey);

      for (const segA of left.segs) {
        for (const segB of right.segs) {
          if (!(segA.horizontal && segB.vertical) && !(segA.vertical && segB.horizontal)) {
            continue;
          }
          const hit = orthogonalCrossingPoint(segA, segB);
          if (!hit) continue;

          // Same family: only skip when this is the intentional junction join.
          // (Shared collinear trunks are handled by ambiguous-segment validators.)
          if (sameFamily) {
            if (
              isIntentionalFamilyJunctionPoint(left.link, hit.point) ||
              isIntentionalFamilyJunctionPoint(right.link, hit.point)
            ) {
              continue;
            }
            // Same-family non-junction geometry is not an unrelated crossing.
            continue;
          }

          const horizontal = segA.horizontal ? left : right;
          const vertical = segA.horizontal ? right : left;
          const horizontalSeg = segA.horizontal ? segA : segB;
          const verticalSeg = segA.horizontal ? segB : segA;
          sites.push({
            x: hit.point[0],
            y: hit.point[1],
            kind: hit.kind,
            classification: 'crossing',
            horizontalLink: horizontal.link,
            verticalLink: vertical.link,
            horizontalSegIndex: horizontalSeg.index,
            verticalSegIndex: verticalSeg.index,
            horizontalSegId: `${horizontal.link.type}:${horizontal.link.source}->${horizontal.link.target}#${horizontalSeg.index}`,
            verticalSegId: `${vertical.link.type}:${vertical.link.source}->${vertical.link.target}#${verticalSeg.index}`,
            familyA: left.familyKey,
            familyB: right.familyKey,
            horizontalFamilyKey: horizontal.familyKey,
            verticalFamilyKey: vertical.familyKey,
            a: `${left.link.type}:${left.link.source}->${left.link.target}`,
            b: `${right.link.type}:${right.link.source}->${right.link.target}`,
          });
        }
      }
    }
  }
  return sites;
}

/** Unique physical unrelated crossing points (deduped). */
export function uniqueUnrelatedCrossingPoints(links) {
  const map = new Map();
  for (const site of findUnrelatedCrossingSites(links)) {
    const key = `${roundCoord(site.x)},${roundCoord(site.y)}`;
    if (!map.has(key)) map.set(key, site);
  }
  return [...map.values()];
}

/** Unique rendered jump points (deduped). */
export function uniqueRenderedJumpPoints(links) {
  const map = new Map();
  for (const link of links || []) {
    for (const jump of link.jumps || []) {
      const key = `${roundCoord(jump.x)},${roundCoord(jump.y)}`;
      if (!map.has(key)) map.set(key, jump);
    }
  }
  return [...map.values()];
}

/**
 * Annotate line-jumps on the horizontal segment of every unrelated H×V crossing.
 * Vertical stays straight underneath. Every horizontal link whose geometry
 * contains the crossing point receives the jump so overlapping duplicate
 * parent→child polylines all render the bridge.
 */
export function annotateLineJumps(links) {
  const enriched = (links || []).map((link) => ({
    ...link,
    jumps: [],
    crossingStyle: CROSSING_STYLE,
  }));

  for (const site of findUnrelatedCrossingSites(enriched)) {
    const underKey = `${site.verticalLink.type}:${site.verticalLink.source}->${site.verticalLink.target}`;
    for (const link of enriched) {
      if (linkFamilyKey(link) !== site.horizontalFamilyKey) continue;
      for (const seg of segmentsOf(link.points)) {
        if (!seg.horizontal) continue;
        const minX = Math.min(seg.a[0], seg.b[0]);
        const maxX = Math.max(seg.a[0], seg.b[0]);
        if (!almostEq(seg.a[1], site.y)) continue;
        if (site.x < minX - 1e-9 || site.x > maxX + 1e-9) continue;
        link.jumps.push({
          x: site.x,
          y: site.y,
          axis: 'h',
          segmentIndex: seg.index,
          kind: site.kind,
          under: underKey,
        });
      }
    }
  }

  for (const link of enriched) {
    const seen = new Set();
    link.jumps = link.jumps
      .sort((a, b) => a.segmentIndex - b.segmentIndex || a.x - b.x || a.y - b.y)
      .filter((jump) => {
        const key = `${jump.segmentIndex}@${roundCoord(jump.x)},${roundCoord(jump.y)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  return enriched;
}

/**
 * Build SVG path `d` with semicircular line-jumps on annotated crossings.
 * Logical `points` stay orthogonal for validators/metrics.
 * Jump arcs are clamped inside the host segment so endpoint/bend crossings
 * still render a visible bridge instead of collapsing.
 */
export function pointsToSvgPath(points, jumps = [], radius = LINE_JUMP_RADIUS) {
  if (!points?.length) return '';
  const jumpBySeg = new Map();
  for (const jump of jumps || []) {
    if (!jumpBySeg.has(jump.segmentIndex)) jumpBySeg.set(jump.segmentIndex, []);
    jumpBySeg.get(jump.segmentIndex).push(jump);
  }

  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const segJumps = almostEq(a[1], b[1])
      ? [...(jumpBySeg.get(i) || [])].sort((left, right) =>
          a[0] <= b[0] ? left.x - right.x : right.x - left.x,
        )
      : [];

    if (!segJumps.length) {
      d += `L${b[0]},${b[1]}`;
      continue;
    }

    let cursorX = a[0];
    const y = a[1];
    const dir = Math.sign(b[0] - a[0]) || 1;
    const segMin = Math.min(a[0], b[0]);
    const segMax = Math.max(a[0], b[0]);
    for (const jump of segJumps) {
      let r = radius;
      const roomLeft = jump.x - segMin;
      const roomRight = segMax - jump.x;
      const maxR = Math.max(2, Math.min(roomLeft, roomRight) - 0.5);
      if (maxR < r) r = maxR;
      if (r < 2) {
        // Degenerate end touch: still break the stroke with a tiny gap+bump.
        r = 2;
      }
      let approach = jump.x - dir * r;
      let leave = jump.x + dir * r;
      approach = Math.min(segMax, Math.max(segMin, approach));
      leave = Math.min(segMax, Math.max(segMin, leave));
      if ((leave - cursorX) * dir <= EPS) continue;
      if ((approach - cursorX) * dir > EPS) {
        d += `L${roundCoord(approach)},${y}`;
      }
      const sweep = dir > 0 ? 1 : 0;
      d += `A${roundCoord(r)},${roundCoord(r)} 0 0 ${sweep} ${roundCoord(leave)},${y}`;
      cursorX = leave;
    }
    d += `L${b[0]},${b[1]}`;
  }
  return d;
}

function pointOnSegment(point, a, b, pad = EPS) {
  const minX = Math.min(a[0], b[0]) - pad;
  const maxX = Math.max(a[0], b[0]) + pad;
  const minY = Math.min(a[1], b[1]) - pad;
  const maxY = Math.max(a[1], b[1]) + pad;
  if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) return false;
  if (almostEq(a[0], b[0])) return almostEq(point[0], a[0], pad);
  if (almostEq(a[1], b[1])) return almostEq(point[1], a[1], pad);
  return false;
}

function buildRoutedLinks(layout, families, isHorizontal) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const familyByParentChild = new Map();
  const familyByCoupleKey = new Map();
  for (const family of families) {
    familyByCoupleKey.set(pairKey(family.parentIds), family);
    for (const parentId of family.parentIds) {
      for (const child of family.children) {
        familyByParentChild.set(`${parentId}->${child.id}`, family);
      }
    }
  }

  return (layout.links || []).map((link) => {
    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) return { ...link, points: link.points || [], jumps: [] };

    if (link.type === 'spouse') {
      const couple = familyByCoupleKey.get(pairKey([link.source, link.target]));
      const points = routeSpouse(source, target, isHorizontal);
      if (couple?.isCouple) {
        const junction = coupleSpouseJunction(couple, isHorizontal);
        return {
          ...link,
          familyKey: couple.familyKey,
          laneIndex: couple.laneIndex,
          laneOffsetX: 0,
          anchoredStem: true,
          junction,
          points,
        };
      }
      return {
        ...link,
        familyKey: `spouse:${pairKey([link.source, link.target])}`,
        junction: null,
        points,
      };
    }

    const family = familyByParentChild.get(`${link.source}->${link.target}`);
    if (!family) {
      const midY = (source.y + target.y) / 2;
      return {
        ...link,
        familyKey: `fam:${link.source}->${link.target}`,
        junction: { x: source.x, y: midY, kind: 'fallback-junction' },
        busMode: 'gap',
        points: simplifyPoints([
          pt(source.x, source.y + half(source, 'y')),
          pt(source.x, midY),
          pt(target.x, midY),
          pt(target.x, target.y - half(target, 'y')),
        ]),
      };
    }

    const busY = isHorizontal ? null : verticalBusY(family);
    const busX = isHorizontal ? horizontalBusX(family) : null;
    const singleParent = family.parents[0];
    const junction = family.isCouple
      ? coupleSpouseJunction(family, isHorizontal)
      : singleParentJunction(singleParent, isHorizontal);

    return {
      ...link,
      familyKey: family.familyKey,
      laneIndex: family.laneIndex,
      // Anchored family stems never receive lane offsets.
      laneOffsetX: 0,
      anchoredStem: true,
      busMode: 'gap',
      junction,
      bus: isHorizontal ? { x: busX, y: null } : { x: null, y: busY },
      points: routeFamilyParentChild(family, source, target, isHorizontal),
    };
  });
}

/**
 * Rebuild link polylines from final node coordinates.
 * Call only after nodes are placed; never mutates people / trees.data.
 */
export function routeLayoutLinks(
  layout,
  {
    orientation = 'vertical',
    applyParallelLanes = true,
    parallelGap = MIN_PARALLEL_GAP,
    routingPlan = null,
  } = {},
) {
  const isHorizontal = orientation === 'horizontal';
  const families = assignFamilyLanes(buildParentFamilies(layout), isHorizontal);
  for (const family of families) {
    family.stemOffset = 0;
    family.busOffset = 0;
    family.busAbsolute = null;
    if (routingPlan?.laneByFamilyKey?.has(family.familyKey)) {
      const lane = routingPlan.laneByFamilyKey.get(family.familyKey);
      family.laneIndex = lane.laneIndex ?? family.laneIndex ?? 0;
      if (Number.isFinite(lane.axis)) family.busAbsolute = lane.axis;
    }
  }

  // Pass 1: family-junction routes (bus Y/X from routingPlan when present).
  // Anchored stems are baked in at spouse-midpoint / parent-edge center.
  let routed = buildRoutedLinks(layout, families, isHorizontal);

  // Pass 2: separate near-parallel unrelated corridors.
  // Anchored family stems are immovable obstacles — only lower-priority
  // routes may receive offsets. Never apply stemOffset to parent families.
  if (applyParallelLanes) {
    const nodesById = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
    const { offsetXByFamily, offsetYByFamily } = assignParallelLanes(routed, {
      gap: parallelGap,
      nodesById,
    });

    // Drop any offsets that would shift an anchored family stem. Parent
    // families always keep stemOffset = 0 (hard semantic rule).
    for (const family of families) {
      family.stemOffset = 0;
      offsetXByFamily.delete(family.familyKey);
      offsetYByFamily.delete(family.familyKey);
    }

    let changed = false;
    if (!routingPlan && (offsetXByFamily.size || offsetYByFamily.size)) {
      // Legacy path only: pack movable horizontal buses into fixed gaps.
      // Structured routingPlan already owns bus lanes.
      const familyGapMeta = families.map((family) =>
        isHorizontal
          ? {
              familyKey: family.familyKey,
              parentBottom: family.parentRight,
              childTop: family.childLeft,
              naturalBusY: naturalHorizontalBusX({ ...family, busAbsolute: null, busOffset: 0 }),
            }
          : {
              familyKey: family.familyKey,
              parentBottom: family.parentBottom,
              childTop: family.childTop,
              naturalBusY: naturalVerticalBusY({ ...family, busAbsolute: null, busOffset: 0 }),
            },
      );
      let fittedBus = isHorizontal ? offsetXByFamily : offsetYByFamily;
      if (fittedBus.size) {
        fittedBus = fitBusOffsetsToGenerationGaps(familyGapMeta, fittedBus, parallelGap);
        for (const family of families) {
          // Still never shift the anchored stem; busOffset alone is legacy.
          family.busOffset = fittedBus.get(family.familyKey) || 0;
          if (family.busOffset) changed = true;
        }
      }
    }

    if (changed) routed = buildRoutedLinks(layout, families, isHorizontal);
  }

  // Pass 3: line-jumps only for remaining true H×V crossings.
  return annotateLineJumps(routed);
}

export function routeSignature(link) {
  const pts = (link.points || []).map((p) => `${roundCoord(p[0])},${roundCoord(p[1])}`).join(';');
  const jumps = (link.jumps || [])
    .map((jump) => `${roundCoord(jump.x)},${roundCoord(jump.y)}`)
    .join(';');
  return `${link.type}|${link.source}->${link.target}|${link.familyKey || ''}|${pts}|j:${jumps}`;
}

export function countParentChildSegments(links) {
  let segments = 0;
  for (const link of links || []) {
    if (link.type !== 'parent-child') continue;
    segments += Math.max(0, (link.points || []).length - 1);
  }
  return segments;
}

export function countFamilyJunctions(links) {
  const keys = new Set();
  for (const link of links || []) {
    if (!link.junction || !link.familyKey) continue;
    if (String(link.familyKey).startsWith('fam:')) keys.add(link.familyKey);
  }
  return keys.size;
}

export function routingMetrics(links) {
  let maxBends = 0;
  let maxLength = 0;
  let totalLength = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let jumpCount = 0;

  for (const link of links || []) {
    jumpCount += (link.jumps || []).length;
    if (link.type !== 'parent-child') continue;
    const points = link.points || [];
    maxBends = Math.max(maxBends, Math.max(0, points.length - 2));
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    }
    maxLength = Math.max(maxLength, length);
    totalLength += length;
    for (const p of points) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }

  const uniqueCrossings = uniqueUnrelatedCrossingPoints(links).length;
  const uniqueJumps = uniqueRenderedJumpPoints(links).length;
  return {
    crossingStyle: CROSSING_STYLE,
    lineJumpCount: jumpCount,
    uniqueUnrelatedCrossings: uniqueCrossings,
    uniqueRenderedJumps: uniqueJumps,
    parentChildSegments: countParentChildSegments(links),
    familyJunctions: countFamilyJunctions(links),
    maxBendsPerParentChild: maxBends,
    maxParentChildLength: Number.isFinite(maxLength) ? roundCoord(maxLength) : 0,
    totalParentChildLength: Number.isFinite(totalLength) ? roundCoord(totalLength) : 0,
    routingBounds: Number.isFinite(minX)
      ? {
          minX: roundCoord(minX),
          minY: roundCoord(minY),
          maxX: roundCoord(maxX),
          maxY: roundCoord(maxY),
          width: roundCoord(maxX - minX),
          height: roundCoord(maxY - minY),
        }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
  };
}

export function findExteriorParentChildDetours(layout) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const hits = [];
  const isHorizontal = (layout.links || []).some(
    (link) => link.type === 'parent-child' && link.bus && link.bus.x != null && link.bus.y == null,
  );

  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    if (link.busMode && link.busMode !== 'gap') {
      hits.push({
        link: `${link.source}->${link.target}`,
        reason: `busMode=${link.busMode}`,
      });
      continue;
    }
    const parent = byId.get(String(link.source));
    const child = byId.get(String(link.target));
    if (!parent || !child) continue;

    if (isHorizontal) {
      const childFar = child.x + half(child, 'x');
      const childLeft = child.x - half(child, 'x');
      for (const point of link.points || []) {
        const x = point[0];
        if (x > childFar + EPS) {
          hits.push({
            link: `${link.source}->${link.target}`,
            reason: 'point-beyond-child-row',
            x,
            childFar,
          });
          break;
        }
        if (child.x >= parent.x && x < parent.x - half(parent, 'x') - LANE_GAP) {
          hits.push({
            link: `${link.source}->${link.target}`,
            reason: 'point-before-parent-row',
            x,
          });
          break;
        }
      }
      const points = link.points || [];
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (!almostEq(a[0], b[0])) continue;
        const x = a[0];
        const span = Math.abs(b[1] - a[1]);
        if (span < half(child, 'y')) continue;
        // Vertical bus corridor must stay left of child attach (generation gap).
        if (child.x >= parent.x && x > childLeft + EPS) {
          hits.push({
            link: `${link.source}->${link.target}`,
            reason: 'vertical-bus-past-child-left',
            x,
            childLeft,
          });
          break;
        }
      }
      continue;
    }

    const childFar = child.y + half(child, 'y');
    const childTop = child.y - half(child, 'y');
    for (const point of link.points || []) {
      const y = point[1];
      if (y > childFar + EPS) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'point-below-child-row',
          y,
          childFar,
        });
        break;
      }
      // Above the parent card top is non-natural for downward trees.
      if (child.y >= parent.y && y < parent.y - half(parent, 'y') - LANE_GAP) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'point-above-parent-row',
          y,
        });
        break;
      }
    }
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!almostEq(a[1], b[1])) continue;
      const y = a[1];
      const span = Math.abs(b[0] - a[0]);
      if (span < half(child, 'x')) continue;
      // Child bus must stay above the child-top attach (generation gap).
      if (child.y >= parent.y && y > childTop + EPS) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'horizontal-bus-below-child-top',
          y,
          childTop,
        });
        break;
      }
    }
  }
  return hits;
}

export function findInvalidJunctions(layout) {
  const issues = [];
  for (const link of layout.links || []) {
    if (link.type === 'parent-child' && !link.familyKey) {
      issues.push({ link: `${link.source}->${link.target}`, reason: 'missing-familyKey' });
    }
    if (link.type === 'parent-child' && !link.junction) {
      issues.push({ link: `${link.source}->${link.target}`, reason: 'missing-junction' });
    }
  }
  return issues;
}

/** One familyKey / junction per parent pair that has children. */
export function findOneFamilyJunctionPerParentPairIssues(layout) {
  const families = buildParentFamilies(layout);
  const issues = [];
  for (const family of families) {
    const expected = family.familyKey;
    const related = (layout.links || []).filter((link) => {
      if (link.type === 'parent-child') {
        return (
          family.parentIds.includes(String(link.source)) && family.childIds.has(String(link.target))
        );
      }
      if (link.type === 'spouse' && family.isCouple) {
        const key = pairKey([link.source, link.target]);
        return key === pairKey(family.parentIds);
      }
      return false;
    });
    for (const link of related) {
      if (link.familyKey !== expected) {
        issues.push({
          family: expected,
          link: `${link.type}:${link.source}->${link.target}`,
          familyKey: link.familyKey,
          reason: 'familyKey-mismatch',
        });
      }
    }
    if (family.isCouple) {
      const junctions = related
        .map((link) => link.junction)
        .filter(
          (junction) => junction && Number.isFinite(junction.x) && Number.isFinite(junction.y),
        );
      if (!junctions.length) {
        issues.push({ family: expected, reason: 'missing-couple-junction' });
      } else {
        const x0 = junctions[0].x;
        const y0 = junctions[0].y;
        for (const junction of junctions) {
          if (!almostEq(junction.x, x0) || !almostEq(junction.y, y0)) {
            issues.push({
              family: expected,
              reason: 'multiple-junction-coordinates',
              junctions,
            });
            break;
          }
        }
      }
    }
  }
  return issues;
}

/** Child routes of a couple must start at the shared spouse junction. */
export function findChildBusNotAttachedToSpouseJunction(layout) {
  const isHorizontal = layout.meta?.orientation === 'horizontal';
  const families = buildParentFamilies(layout);
  const issues = [];
  for (const family of families) {
    if (!family.isCouple) continue;
    const junction = coupleSpouseJunction(family, isHorizontal);
    for (const link of layout.links || []) {
      if (link.type !== 'parent-child') continue;
      if (link.familyKey !== family.familyKey) continue;
      const start = (link.points || [])[0];
      if (!start || !almostEq(start[0], junction.x) || !almostEq(start[1], junction.y)) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          start,
          junction,
          reason: 'child-route-not-starting-at-spouse-junction',
        });
      }
      const spouse = (layout.links || []).find(
        (item) =>
          item.type === 'spouse' &&
          item.familyKey === family.familyKey &&
          (item.points || []).length >= 2,
      );
      if (spouse) {
        const a = spouse.points[0];
        const b = spouse.points[spouse.points.length - 1];
        if (!pointOnSegment([junction.x, junction.y], a, b, 1)) {
          issues.push({
            family: family.familyKey,
            reason: 'spouse-junction-not-on-spouse-link',
            junction,
            spouse: spouse.points,
          });
        }
      }
    }
  }
  return issues;
}

function firstStemAxis(points, isHorizontal) {
  for (let i = 0; i < (points || []).length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (isHorizontal) {
      // Anchored stem runs along generation-axis X at constant Y = junction.y
      if (almostEq(a[1], b[1]) && Math.abs(a[0] - b[0]) > SHORT_STUB_LEN) {
        return { axis: a[1], a, b, index: i };
      }
    } else if (almostEq(a[0], b[0]) && Math.abs(a[1] - b[1]) > SHORT_STUB_LEN) {
      return { axis: a[0], a, b, index: i };
    }
  }
  return null;
}

const SHORT_STUB_LEN = 1;

/**
 * Two-parent family stem must leave the geometric midpoint of the spouse-link
 * and keep that cross-axis through the stem (no lane-shift stub).
 */
export function findTwoParentStemAnchorViolations(layout) {
  const isHorizontal = layout.meta?.orientation === 'horizontal';
  const families = buildParentFamilies(layout);
  const issues = [];
  for (const family of families) {
    if (!family.isCouple) continue;
    const expected = coupleSpouseJunction(family, isHorizontal);
    const childLinks = (layout.links || []).filter(
      (link) => link.type === 'parent-child' && link.familyKey === family.familyKey,
    );
    for (const link of childLinks) {
      const start = (link.points || [])[0];
      if (!start || !almostEq(start[0], expected.x) || !almostEq(start[1], expected.y)) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'twoParentStemAnchoredToSpouseMidpoint',
          expected,
          start,
        });
        continue;
      }
      const stem = firstStemAxis(link.points, isHorizontal);
      if (!stem) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'twoParentStemAnchoredToSpouseMidpoint',
          detail: 'missing-stem-segment',
          expected,
        });
        continue;
      }
      const expectedAxis = isHorizontal ? expected.y : expected.x;
      if (!almostEq(stem.axis, expectedAxis)) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'twoParentStemAnchoredToSpouseMidpoint',
          expectedAxis,
          actualAxis: stem.axis,
          delta: stem.axis - expectedAxis,
        });
      }
      if (link.laneOffsetX) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'familyStemLaneShiftViolations',
          laneOffsetX: link.laneOffsetX,
        });
      }
    }
  }
  return issues;
}

/**
 * Single-parent stem must leave the parent card edge center and keep that axis.
 */
export function findSingleParentStemAnchorViolations(layout) {
  const isHorizontal = layout.meta?.orientation === 'horizontal';
  const families = buildParentFamilies(layout);
  const issues = [];
  for (const family of families) {
    if (family.isCouple) continue;
    const parent = family.parents[0];
    if (!parent) continue;
    const expected = singleParentJunction(parent, isHorizontal);
    const childLinks = (layout.links || []).filter(
      (link) => link.type === 'parent-child' && link.familyKey === family.familyKey,
    );
    for (const link of childLinks) {
      const start = (link.points || [])[0];
      if (!start || !almostEq(start[0], expected.x) || !almostEq(start[1], expected.y)) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'singleParentStemAnchoredToCardCenter',
          expected,
          start,
        });
        continue;
      }
      const stem = firstStemAxis(link.points, isHorizontal);
      const expectedAxis = isHorizontal ? expected.y : expected.x;
      if (stem && !almostEq(stem.axis, expectedAxis)) {
        issues.push({
          family: family.familyKey,
          link: `${link.source}->${link.target}`,
          reason: 'singleParentStemAnchoredToCardCenter',
          expectedAxis,
          actualAxis: stem.axis,
          delta: stem.axis - expectedAxis,
        });
      }
      if (link.laneOffsetX) {
        issues.push({
          family: family.familyKey,
          reason: 'familyStemLaneShiftViolations',
          laneOffsetX: link.laneOffsetX,
        });
      }
    }
  }
  return issues;
}

/** One parent pair must not emit multiple distinct stem axes. */
export function findMultipleStemsPerParentPair(layout) {
  const isHorizontal = layout.meta?.orientation === 'horizontal';
  const byFamily = new Map();
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child' || !link.familyKey) continue;
    const stem = firstStemAxis(link.points, isHorizontal);
    if (!stem) continue;
    if (!byFamily.has(link.familyKey)) byFamily.set(link.familyKey, new Set());
    byFamily.get(link.familyKey).add(roundCoord(stem.axis));
  }
  const issues = [];
  for (const [familyKey, axes] of byFamily) {
    if (axes.size > 1) {
      issues.push({
        family: familyKey,
        reason: 'multipleStemsPerParentPair',
        axes: [...axes],
      });
    }
  }
  return issues;
}

/**
 * Declared junction must match spouse-link midpoint (couples) or card edge
 * (single parent), and must match the route start.
 */
export function findFamilyJunctionMismatch(layout) {
  const isHorizontal = layout.meta?.orientation === 'horizontal';
  const families = buildParentFamilies(layout);
  const familyByKey = new Map(families.map((family) => [family.familyKey, family]));
  const issues = [];
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child' || !link.junction) continue;
    const family = familyByKey.get(link.familyKey);
    if (!family) continue;
    const expected = family.isCouple
      ? coupleSpouseJunction(family, isHorizontal)
      : singleParentJunction(family.parents[0], isHorizontal);
    if (!almostEq(link.junction.x, expected.x) || !almostEq(link.junction.y, expected.y)) {
      issues.push({
        family: family.familyKey,
        link: `${link.source}->${link.target}`,
        reason: 'familyJunctionMismatch',
        expected,
        actual: link.junction,
      });
    }
  }
  return issues;
}

export function findFamilyStemLaneShiftViolations(layout) {
  return [
    ...findTwoParentStemAnchorViolations(layout),
    ...findSingleParentStemAnchorViolations(layout),
  ].filter((issue) => issue.reason === 'familyStemLaneShiftViolations');
}

export function countAnchoredStemViolations(layout) {
  const twoParent = findTwoParentStemAnchorViolations(layout).filter(
    (issue) => issue.reason === 'twoParentStemAnchoredToSpouseMidpoint',
  );
  const singleParent = findSingleParentStemAnchorViolations(layout).filter(
    (issue) => issue.reason === 'singleParentStemAnchoredToCardCenter',
  );
  return {
    twoParentStemAnchoredToSpouseMidpoint: twoParent.length,
    singleParentStemAnchoredToCardCenter: singleParent.length,
    familyStemLaneShiftViolations: findFamilyStemLaneShiftViolations(layout).length,
    multipleStemsPerParentPair: findMultipleStemsPerParentPair(layout).length,
    familyJunctionMismatch: findFamilyJunctionMismatch(layout).length,
  };
}

export function findUnrelatedCrossingsWithoutJump(layout) {
  const jumps = uniqueRenderedJumpPoints(layout.links || []);
  return uniqueUnrelatedCrossingPoints(layout.links || []).filter((site) => {
    return !jumps.some((jump) => almostEq(jump.x, site.x, 1.5) && almostEq(jump.y, site.y, 1.5));
  });
}

/** Jumps that do not correspond to any unrelated geometric crossing. */
export function findFalseJumps(layout) {
  const crossings = uniqueUnrelatedCrossingPoints(layout.links || []);
  return uniqueRenderedJumpPoints(layout.links || []).filter((jump) => {
    return !crossings.some(
      (site) => almostEq(jump.x, site.x, 1.5) && almostEq(jump.y, site.y, 1.5),
    );
  });
}

/** Invariant: unique unrelated crossings === unique rendered jumps. */
export function assertCrossingJumpParity(layout) {
  const crossings = uniqueUnrelatedCrossingPoints(layout.links || []).length;
  const jumps = uniqueRenderedJumpPoints(layout.links || []).length;
  return {
    ok: crossings === jumps,
    unrelatedGeometricCrossings: crossings,
    renderedLineJumps: jumps,
    missedJumps: findUnrelatedCrossingsWithoutJump(layout).length,
    falseJumps: findFalseJumps(layout).length,
  };
}

/**
 * Unrelated families must not share a vertex/T-join that looks like a branch.
 * Intentional joins only within the same familyKey.
 */
export function findFalseJunctionsBetweenUnrelatedFamilies(layout) {
  const links = layout.links || [];
  const issues = [];
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      const left = links[i];
      const right = links[j];
      if (sameFamilyKeys(linkFamilyKey(left), linkFamilyKey(right))) continue;
      const leftPts = left.points || [];
      const rightSegs = segmentsOf(right.points || []);
      for (const point of leftPts) {
        for (const seg of rightSegs) {
          const atEnd =
            (almostEq(point[0], seg.a[0]) && almostEq(point[1], seg.a[1])) ||
            (almostEq(point[0], seg.b[0]) && almostEq(point[1], seg.b[1]));
          if (atEnd) continue;
          if (pointOnSegment(point, seg.a, seg.b, EPS)) {
            issues.push({
              a: `${left.type}:${left.source}->${left.target}`,
              b: `${right.type}:${right.source}->${right.target}`,
              point,
              reason: 'endpoint-lies-on-unrelated-segment',
            });
          }
        }
      }
    }
  }
  return issues;
}
