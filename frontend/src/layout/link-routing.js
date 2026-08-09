/**
 * Orthogonal family-junction link routing for the household layout preview.
 *
 * Design rules (display-only; never writes trees.data):
 * - Parent→child flows in the natural generation direction only
 *   (parents → junction/bus in the generation gap → children).
 * - Each parent household has its own junction and short family bus.
 * - Unrelated family buses MAY cross; that is not a kinship signal.
 * - Ambiguous shared collinear trunks across families are avoided via lane offsets.
 * - Long exterior detours around the tree (e.g. bus below the child row) are forbidden.
 * - Routing priority: avoid cards → natural generation flow → short length →
 *   few bends → only then fewer crossings.
 * - Spouse links stay short horizontal edge-to-edge segments in a household.
 *
 * Crossing style: line-jump (SVG semicircle) on the horizontal segment at an
 * unrelated H×V crossing. Chosen over a plain 4-way cross because junctions
 * already look connected via shared family geometry; a bare cross on mobile
 * is easy to misread as a branch point. Jump radius stays small for touch UIs.
 */

export const CROSSING_STYLE = 'line-jump';
export const LINE_JUMP_RADIUS = 7;

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

function routeSpouse(source, target) {
  const left = source.x <= target.x ? source : target;
  const right = source.x <= target.x ? target : source;
  const y = (left.y + right.y) / 2;
  return [pt(left.x + half(left, 'x'), y), pt(right.x - half(right, 'x'), y)];
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
  }

  return [...families.values()].sort(
    (left, right) => left.parentMidX - right.parentMidX || left.key.localeCompare(right.key),
  );
}

function familyCrossesStem(family, other) {
  if (family.key === other.key) return false;
  return other.parentMidX > family.spanMinX + 1e-6 && other.parentMidX < family.spanMaxX - 1e-6;
}

/**
 * Distinct lane ranks inside the generation gap so unrelated families do not
 * share one collinear bus trunk. Crossings between lanes remain allowed.
 */
export function assignFamilyLanes(families, _isHorizontal = false) {
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
        if (!familyCrossesStem(left, right)) continue;
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
    // Spread lanes inside the parent→child gap only (never past the child row).
    family.laneT = maxRank === 0 ? 0.45 : 0.3 + (0.4 * family.laneIndex) / maxRank;
    family.laneOffset = family.laneIndex * LANE_GAP;
  }
  return families;
}

function verticalBusY(family) {
  const gap = family.childTop - family.parentBottom;
  const minY = family.parentBottom + BUS_INSET;
  const maxY = family.childTop - BUS_INSET;
  if (maxY <= minY) return roundCoord((family.parentBottom + family.childTop) / 2);
  const t = family.laneT ?? 0.45;
  const busY = family.parentBottom + gap * t;
  return roundCoord(Math.min(maxY, Math.max(minY, busY)));
}

function horizontalBusX(family) {
  const gap = family.childLeft - family.parentRight;
  const minX = family.parentRight + BUS_INSET;
  const maxX = family.childLeft - BUS_INSET;
  if (maxX <= minX) return roundCoord((family.parentRight + family.childLeft) / 2);
  const t = family.laneT ?? 0.45;
  const busX = family.parentRight + gap * t;
  return roundCoord(Math.min(maxX, Math.max(minX, busX)));
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
 * Build polyline for one parent→child edge inside a family junction.
 * Same-family edges share stem + bus; child drops are per child.
 * Path stays inside the generation gap (no exterior overflow bus).
 */
export function routeFamilyParentChild(family, parent, child, isHorizontal) {
  if (isHorizontal) {
    const busX = horizontalBusX(family);
    const stemY = roundCoord(
      family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length,
    );
    return simplifyPoints([
      pt(parent.x + half(parent, 'x'), parent.y),
      pt(busX, parent.y),
      pt(busX, stemY),
      pt(busX, child.y),
      pt(child.x - half(child, 'x'), child.y),
    ]);
  }

  const busY = verticalBusY(family);
  const stemX = roundCoord(family.parentMidX);
  return simplifyPoints([
    pt(parent.x, parent.y + half(parent, 'y')),
    pt(stemX, parent.y + half(parent, 'y')),
    pt(stemX, busY),
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

function segmentIntersectionPoint(a, b) {
  const d = (a.b[0] - a.a[0]) * (b.b[1] - b.a[1]) - (a.b[1] - a.a[1]) * (b.b[0] - b.a[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b.a[0] - a.a[0]) * (b.b[1] - b.a[1]) - (b.a[1] - a.a[1]) * (b.b[0] - b.a[0])) / d;
  const u = ((b.a[0] - a.a[0]) * (a.b[1] - a.a[1]) - (b.a[1] - a.a[1]) * (a.b[0] - a.a[0])) / d;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return pt(a.a[0] + t * (a.b[0] - a.a[0]), a.a[1] + t * (a.b[1] - a.a[1]));
}

/**
 * Annotate unrelated H×V crossings. The horizontal segment is the "over" line
 * and receives a line-jump; the vertical stays straight underneath.
 */
export function annotateLineJumps(links) {
  const enriched = (links || []).map((link) => ({
    ...link,
    jumps: [],
    crossingStyle: CROSSING_STYLE,
  }));

  const indexed = enriched.map((link, linkIndex) => ({
    link,
    linkIndex,
    familyKey: linkFamilyKey(link),
    segs: segmentsOf(link.points),
  }));

  for (let i = 0; i < indexed.length; i += 1) {
    for (let j = i + 1; j < indexed.length; j += 1) {
      const left = indexed[i];
      const right = indexed[j];
      if (left.familyKey && left.familyKey === right.familyKey) continue;

      for (const segA of left.segs) {
        for (const segB of right.segs) {
          if (!(segA.horizontal && segB.vertical) && !(segA.vertical && segB.horizontal)) {
            continue;
          }
          const point = segmentIntersectionPoint(segA, segB);
          if (!point) continue;
          // Jump only on parent-child horizontal buses — spouse stubs stay plain.
          let over;
          let under;
          let overSeg;
          if (segA.horizontal && left.link.type === 'parent-child') {
            over = left;
            under = right;
            overSeg = segA;
          } else if (segB.horizontal && right.link.type === 'parent-child') {
            over = right;
            under = left;
            overSeg = segB;
          } else {
            continue;
          }
          over.link.jumps.push({
            x: point[0],
            y: point[1],
            axis: 'h',
            segmentIndex: overSeg.index,
            under: `${under.link.type}:${under.link.source}->${under.link.target}`,
          });
        }
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
    for (const jump of segJumps) {
      const left = jump.x - radius;
      const right = jump.x + radius;
      const approach = dir > 0 ? left : right;
      const leave = dir > 0 ? right : left;
      // Skip degenerate jumps that would collapse after a previous nearby jump.
      if ((leave - cursorX) * dir <= EPS) continue;
      if ((approach - cursorX) * dir > EPS) {
        d += `L${roundCoord(approach)},${y}`;
      }
      // Upper semicircle for left→right; mirror sweep for right→left.
      const sweep = dir > 0 ? 1 : 0;
      d += `A${radius},${radius} 0 0 ${sweep} ${roundCoord(leave)},${y}`;
      cursorX = leave;
    }
    d += `L${b[0]},${b[1]}`;
  }
  return d;
}

/**
 * Rebuild link polylines from final node coordinates.
 * Call only after nodes are placed; never mutates people / trees.data.
 */
export function routeLayoutLinks(layout, { orientation = 'vertical' } = {}) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const isHorizontal = orientation === 'horizontal';
  const families = assignFamilyLanes(buildParentFamilies(layout), isHorizontal);
  const familyByParentChild = new Map();
  for (const family of families) {
    for (const parentId of family.parentIds) {
      for (const child of family.children) {
        familyByParentChild.set(`${parentId}->${child.id}`, family);
      }
    }
  }

  const routed = (layout.links || []).map((link) => {
    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) return { ...link, points: link.points || [], jumps: [] };

    if (link.type === 'spouse') {
      return {
        ...link,
        familyKey: `spouse:${[link.source, link.target].map(String).sort().join('+')}`,
        junction: null,
        points: simplifyPoints(routeSpouse(source, target)),
      };
    }

    const family = familyByParentChild.get(`${link.source}->${link.target}`);
    if (!family) {
      const midY = (source.y + target.y) / 2;
      return {
        ...link,
        familyKey: `pc:${link.source}->${link.target}`,
        junction: { x: source.x, y: midY },
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
    const stemX = isHorizontal ? null : roundCoord(family.parentMidX);
    const stemY = isHorizontal
      ? roundCoord(family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length)
      : null;

    return {
      ...link,
      familyKey: `pc:${family.key}`,
      laneIndex: family.laneIndex,
      busMode: 'gap',
      junction: isHorizontal
        ? { x: busX, y: stemY, kind: 'family-junction' }
        : { x: stemX, y: busY, kind: 'family-junction' },
      points: routeFamilyParentChild(family, source, target, isHorizontal),
    };
  });

  return annotateLineJumps(routed);
}

export function routeSignature(link) {
  const pts = (link.points || []).map((p) => `${roundCoord(p[0])},${roundCoord(p[1])}`).join(';');
  const jumps = (link.jumps || [])
    .map((jump) => `${roundCoord(jump.x)},${roundCoord(jump.y)}`)
    .join(';');
  return `${link.type}|${link.source}->${link.target}|${link.familyKey || ''}|${pts}|j:${jumps}`;
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

  return {
    crossingStyle: CROSSING_STYLE,
    lineJumpCount: jumpCount,
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

/**
 * True when a parent-child polyline leaves the parent→child generation band
 * on the far side of the children (exterior overflow corridor).
 */
export function findExteriorParentChildDetours(layout) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const hits = [];
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
    const childFar = child.y + half(child, 'y');
    const childTop = child.y - half(child, 'y');
    const parentBottom = parent.y + half(parent, 'y');
    for (const point of link.points || []) {
      const y = point[1];
      // Below the child card (past sibling/child row) — forbidden exterior corridor.
      if (y > childFar + EPS) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'point-below-child-row',
          y,
          childFar,
        });
        break;
      }
      // Far above the parent row — non-natural for downward trees.
      if (child.y >= parent.y && y < parent.y - half(parent, 'y') - LANE_GAP) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'point-above-parent-row',
          y,
        });
        break;
      }
    }
    // Horizontal bus must stay inside the generation gap, not under the child row.
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!almostEq(a[1], b[1])) continue;
      const y = a[1];
      const span = Math.abs(b[0] - a[0]);
      if (span < half(child, 'x')) continue;
      if (child.y >= parent.y && y > childTop + EPS) {
        hits.push({
          link: `${link.source}->${link.target}`,
          reason: 'horizontal-bus-below-child-top',
          y,
          childTop,
          parentBottom,
        });
        break;
      }
    }
  }
  return hits;
}

export function findInvalidJunctions(layout) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const issues = [];
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    if (!link.familyKey) {
      issues.push({ link: `${link.source}->${link.target}`, reason: 'missing-familyKey' });
      continue;
    }
    const parent = byId.get(String(link.source));
    const child = byId.get(String(link.target));
    if (!parent || !child) {
      issues.push({ link: `${link.source}->${link.target}`, reason: 'missing-endpoint' });
      continue;
    }
    const junction = link.junction;
    if (!junction || !Number.isFinite(junction.x) || !Number.isFinite(junction.y)) {
      issues.push({ link: `${link.source}->${link.target}`, reason: 'missing-junction' });
      continue;
    }
    const parentBottom = parent.y + half(parent, 'y');
    const childTop = child.y - half(child, 'y');
    if (child.y >= parent.y) {
      if (junction.y < parentBottom - EPS || junction.y > childTop + EPS) {
        issues.push({
          link: `${link.source}->${link.target}`,
          reason: 'junction-outside-generation-gap',
          junction,
          parentBottom,
          childTop,
        });
      }
    }
  }
  return issues;
}
