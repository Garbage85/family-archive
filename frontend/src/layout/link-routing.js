/**
 * Orthogonal link routing for the household layout preview.
 *
 * Parent-child links use a family-junction / bus model (nodes stay fixed).
 * Each family gets its own corridor; when a straight bus would cross a foreign
 * drop/bus, the route takes orthogonal multi-detours (above/below/left/right)
 * around the obstacle. Ambiguous shared collinear lanes are not used.
 *
 * Spouse links stay short edge-to-edge links inside a household.
 * Coordinates are display-only and must never be written to trees.data.
 */

const LANE_GAP = 16;
const BUS_INSET = 10;
const DETOUR_PAD = 14;
const DETOUR_STEP = 18;
const MAX_DETOUR_TRIES = 28;
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
 * Assign lane ranks so a family that must cross another's stem gets a bus
 * closer to the children (larger y in vertical mode) than that stem's end.
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
    family.laneT = maxRank === 0 ? 0.5 : 0.28 + (0.55 * family.laneIndex) / maxRank;
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

function countVerticalBlockers(y, xMin, xMax, foreign) {
  let count = 0;
  for (const seg of foreign) {
    if (!seg.vertical) continue;
    const sx = seg.x1;
    if (sx <= xMin + EPS || sx >= xMax - EPS) continue;
    const sy1 = Math.min(seg.y1, seg.y2);
    const sy2 = Math.max(seg.y1, seg.y2);
    if (y > sy1 - EPS && y < sy2 + EPS) count += 1;
  }
  return count;
}

function countHorizontalBlockers(x, yMin, yMax, foreign) {
  let count = 0;
  for (const seg of foreign) {
    if (!seg.horizontal) continue;
    const sy = seg.y1;
    if (sy <= yMin + EPS || sy >= yMax - EPS) continue;
    const sx1 = Math.min(seg.x1, seg.x2);
    const sx2 = Math.max(seg.x1, seg.x2);
    if (x > sx1 - EPS && x < sx2 + EPS) count += 1;
  }
  return count;
}

/**
 * Prefer a gap bus with zero foreign vertical blockers.
 * If the generation gap is fully blocked (foreign drop spans the gap),
 * use an overflow bus past the child row (below in vertical mode).
 */
function collectVerticalChannels(cards) {
  const sorted = [...cards].sort((a, b) => a.left - b.left || a.id.localeCompare(b.id));
  if (!sorted.length) return [0];
  const channels = [roundCoord(sorted[0].left - DETOUR_PAD)];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1].left - sorted[i].right;
    if (gap > DETOUR_PAD * 2) {
      channels.push(roundCoord((sorted[i].right + sorted[i + 1].left) / 2));
    }
  }
  channels.push(roundCoord(sorted[sorted.length - 1].right + DETOUR_PAD));
  return channels;
}

function chooseOverflowStemX(family, foreign, cards, busY) {
  const yMin = Math.min(family.parentBottom, busY);
  const yMax = Math.max(family.parentBottom, busY);
  const preferred = roundCoord(family.parentMidX);
  const channels = collectVerticalChannels(cards);
  const scored = [];
  for (const x of channels) {
    if (countHorizontalBlockers(x, yMin, yMax, foreign) > 0) continue;
    if (!laneClearVertical(x, yMin, yMax, foreign, cards, null)) continue;
    scored.push({ x, dist: Math.abs(x - preferred) });
  }
  scored.sort((a, b) => a.dist - b.dist || a.x - b.x);
  if (scored.length) return scored[0].x;
  // Deterministic last resort: exterior left of all cards.
  const leftmost = Math.min(...cards.map((rect) => rect.left));
  return roundCoord(leftmost - DETOUR_PAD - (family.laneIndex || 0) * LANE_GAP);
}

function chooseVerticalBusPlan(family, foreign, cards) {
  const gap = family.childTop - family.parentBottom;
  const minY = family.parentBottom + BUS_INSET;
  const maxY = family.childTop - BUS_INSET;
  const fallback = verticalBusY(family);
  const xMin = Math.min(family.spanMinX, family.childMinX) - 1;
  const xMax = Math.max(family.spanMaxX, family.childMaxX) + 1;

  if (maxY > minY) {
    const ts = [0.18, 0.28, 0.38, 0.45, 0.55, 0.65, 0.75, family.laneT ?? 0.45];
    const candidates = [
      ...new Set(
        ts.map((t) => roundCoord(Math.min(maxY, Math.max(minY, family.parentBottom + gap * t)))),
      ),
    ].sort((a, b) => a - b);

    let best = null;
    let bestScore = [Infinity, Infinity, Infinity];
    for (const y of candidates) {
      if (!laneClearHorizontal(y, xMin, xMax, foreign, cards, null)) continue;
      const blockers = countVerticalBlockers(y, xMin, xMax, foreign);
      const parentDist = Math.abs(y - family.parentBottom);
      const score = [blockers, parentDist, Math.abs(y - fallback)];
      if (
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
      ) {
        best = y;
        bestScore = score;
      }
    }
    if (best != null && bestScore[0] === 0) {
      return { mode: 'gap', bus: best, stem: roundCoord(family.parentMidX) };
    }
  }

  const overflowY = roundCoord(family.childBottom + BUS_INSET + (family.laneIndex || 0) * LANE_GAP);
  return {
    mode: 'overflow',
    bus: overflowY,
    stem: chooseOverflowStemX(family, foreign, cards, overflowY),
  };
}

function chooseHorizontalBusPlan(family, foreign, cards) {
  const gap = family.childLeft - family.parentRight;
  const minX = family.parentRight + BUS_INSET;
  const maxX = family.childLeft - BUS_INSET;
  const fallback = horizontalBusX(family);
  const yMin = Math.min(...family.parents.map((n) => n.y), ...family.children.map((n) => n.y)) - 1;
  const yMax = Math.max(...family.parents.map((n) => n.y), ...family.children.map((n) => n.y)) + 1;

  if (maxX > minX) {
    const ts = [0.18, 0.28, 0.38, 0.45, 0.55, 0.65, 0.75, family.laneT ?? 0.45];
    const candidates = [
      ...new Set(
        ts.map((t) => roundCoord(Math.min(maxX, Math.max(minX, family.parentRight + gap * t)))),
      ),
    ].sort((a, b) => a - b);

    let best = null;
    let bestScore = [Infinity, Infinity, Infinity];
    for (const x of candidates) {
      if (!laneClearVertical(x, yMin, yMax, foreign, cards, null)) continue;
      const blockers = countHorizontalBlockers(x, yMin, yMax, foreign);
      const parentDist = Math.abs(x - family.parentRight);
      const score = [blockers, parentDist, Math.abs(x - fallback)];
      if (
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
      ) {
        best = x;
        bestScore = score;
      }
    }
    if (best != null && bestScore[0] === 0) {
      return {
        mode: 'gap',
        bus: best,
        stem: roundCoord(
          family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length,
        ),
      };
    }
  }

  const overflowX = roundCoord(
    Math.max(...family.children.map((node) => node.x + half(node, 'x'))) +
      BUS_INSET +
      (family.laneIndex || 0) * LANE_GAP,
  );
  const stemY = roundCoord(
    Math.min(...cards.map((rect) => rect.top)) - DETOUR_PAD - (family.laneIndex || 0) * LANE_GAP,
  );
  return { mode: 'overflow', bus: overflowX, stem: stemY };
}

function cardRect(node) {
  return {
    id: node.id,
    left: node.x - half(node, 'x'),
    right: node.x + half(node, 'x'),
    top: node.y - half(node, 'y'),
    bottom: node.y + half(node, 'y'),
  };
}

function rangesOverlap(aMin, aMax, bMin, bMax, pad = 0) {
  return aMin <= bMax + pad && bMin <= aMax + pad;
}

function isH(a, b) {
  return almostEq(a[1], b[1]);
}

function isV(a, b) {
  return almostEq(a[0], b[0]);
}

/** @param {[number, number][]} points */
export function segmentsOfPoints(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (almostEq(a[0], b[0]) && almostEq(a[1], b[1])) continue;
    segs.push({
      x1: a[0],
      y1: a[1],
      x2: b[0],
      y2: b[1],
      horizontal: isH(a, b),
      vertical: isV(a, b),
    });
  }
  return segs;
}

function segmentHitsCard(seg, rect, pad = 4) {
  const left = rect.left - pad;
  const right = rect.right + pad;
  const top = rect.top - pad;
  const bottom = rect.bottom + pad;
  const minX = Math.min(seg.x1, seg.x2);
  const maxX = Math.max(seg.x1, seg.x2);
  const minY = Math.min(seg.y1, seg.y2);
  const maxY = Math.max(seg.y1, seg.y2);
  if (maxX < left || minX > right || maxY < top || minY > bottom) return false;

  if (seg.horizontal) {
    const y = seg.y1;
    if (y <= top + EPS || y >= bottom - EPS) return false;
    return rangesOverlap(minX, maxX, left, right, -EPS);
  }
  if (seg.vertical) {
    const x = seg.x1;
    if (x <= left + EPS || x >= right - EPS) return false;
    return rangesOverlap(minY, maxY, top, bottom, -EPS);
  }
  return true;
}

function laneClearHorizontal(y, xMin, xMax, foreign, cards, ignoreIds) {
  const probe = { x1: xMin, y1: y, x2: xMax, y2: y, horizontal: true, vertical: false };
  for (const rect of cards) {
    if (ignoreIds?.has(rect.id)) continue;
    if (segmentHitsCard(probe, rect)) return false;
  }
  for (const seg of foreign) {
    if (!seg.horizontal) continue;
    if (!almostEq(seg.y1, y)) continue;
    if (rangesOverlap(Math.min(seg.x1, seg.x2), Math.max(seg.x1, seg.x2), xMin, xMax, EPS)) {
      return false;
    }
  }
  return true;
}

function laneClearVertical(x, yMin, yMax, foreign, cards, ignoreIds) {
  const probe = { x1: x, y1: yMin, x2: x, y2: yMax, horizontal: false, vertical: true };
  for (const rect of cards) {
    if (ignoreIds?.has(rect.id)) continue;
    if (segmentHitsCard(probe, rect)) return false;
  }
  for (const seg of foreign) {
    if (!seg.vertical) continue;
    if (!almostEq(seg.x1, x)) continue;
    if (rangesOverlap(Math.min(seg.y1, seg.y2), Math.max(seg.y1, seg.y2), yMin, yMax, EPS)) {
      return false;
    }
  }
  return true;
}

function verticalLegClear(x, y1, y2, foreign, cards, ignoreIds) {
  const probe = {
    x1: x,
    y1,
    x2: x,
    y2,
    horizontal: false,
    vertical: true,
  };
  for (const rect of cards) {
    if (ignoreIds?.has(rect.id)) continue;
    if (segmentHitsCard(probe, rect)) return false;
  }
  for (const seg of foreign) {
    if (!seg.horizontal) continue;
    const sy = seg.y1;
    if (sy <= Math.min(y1, y2) + EPS || sy >= Math.max(y1, y2) - EPS) continue;
    if (x > Math.min(seg.x1, seg.x2) - EPS && x < Math.max(seg.x1, seg.x2) + EPS) {
      return false;
    }
  }
  return true;
}

function horizontalLegClear(y, x1, x2, foreign, cards, ignoreIds) {
  const probe = {
    x1,
    y1: y,
    x2,
    y2: y,
    horizontal: true,
    vertical: false,
  };
  for (const rect of cards) {
    if (ignoreIds?.has(rect.id)) continue;
    if (segmentHitsCard(probe, rect)) return false;
  }
  for (const seg of foreign) {
    if (!seg.vertical) continue;
    const sx = seg.x1;
    if (sx <= Math.min(x1, x2) + EPS || sx >= Math.max(x1, x2) - EPS) continue;
    if (y > Math.min(seg.y1, seg.y2) - EPS && y < Math.max(seg.y1, seg.y2) + EPS) {
      return false;
    }
  }
  return true;
}

function pickDetourY(
  laneY,
  blocker,
  foreign,
  cards,
  preferDown,
  xMin,
  xMax,
  ignoreIds,
  approachX,
  pastX,
) {
  const above = Math.min(blocker.y1, blocker.y2) - DETOUR_PAD;
  const below = Math.max(blocker.y1, blocker.y2) + DETOUR_PAD;
  // Prefer the side that stays in the generation gap (usually above child drops).
  const ordered = preferDown
    ? [above, below, above - DETOUR_STEP, below + DETOUR_STEP]
    : [below, above, below + DETOUR_STEP, above - DETOUR_STEP];

  for (let i = 0; i < MAX_DETOUR_TRIES; i += 1) {
    const y =
      i < ordered.length
        ? ordered[i]
        : i % 2 === 0
          ? above - DETOUR_STEP * Math.floor((i - ordered.length) / 2 + 1)
          : below + DETOUR_STEP * Math.floor((i - ordered.length) / 2 + 1);
    if (
      !laneClearHorizontal(
        y,
        Math.min(approachX, pastX),
        Math.max(approachX, pastX),
        foreign,
        cards,
        ignoreIds,
      )
    ) {
      continue;
    }
    if (!verticalLegClear(approachX, laneY, y, foreign, cards, ignoreIds)) continue;
    if (!verticalLegClear(pastX, laneY, y, foreign, cards, ignoreIds)) continue;
    if (!horizontalLegClear(y, approachX, pastX, foreign, cards, ignoreIds)) continue;
    return roundCoord(y);
  }
  // No validated detour: keep lane (caller may still cross; overflow plan avoids this).
  return roundCoord(laneY);
}

function pickDetourX(
  laneX,
  blocker,
  foreign,
  cards,
  preferRight,
  yMin,
  yMax,
  ignoreIds,
  approachY,
  pastY,
) {
  const left = Math.min(blocker.x1, blocker.x2) - DETOUR_PAD;
  const right = Math.max(blocker.x1, blocker.x2) + DETOUR_PAD;
  const ordered = preferRight
    ? [left, right, left - DETOUR_STEP, right + DETOUR_STEP]
    : [right, left, right + DETOUR_STEP, left - DETOUR_STEP];

  for (let i = 0; i < MAX_DETOUR_TRIES; i += 1) {
    const x =
      i < ordered.length
        ? ordered[i]
        : i % 2 === 0
          ? left - DETOUR_STEP * Math.floor((i - ordered.length) / 2 + 1)
          : right + DETOUR_STEP * Math.floor((i - ordered.length) / 2 + 1);
    if (
      !laneClearVertical(
        x,
        Math.min(approachY, pastY),
        Math.max(approachY, pastY),
        foreign,
        cards,
        ignoreIds,
      )
    ) {
      continue;
    }
    if (!horizontalLegClear(approachY, laneX, x, foreign, cards, ignoreIds)) continue;
    if (!horizontalLegClear(pastY, laneX, x, foreign, cards, ignoreIds)) continue;
    if (!verticalLegClear(x, approachY, pastY, foreign, cards, ignoreIds)) continue;
    return roundCoord(x);
  }
  return roundCoord(laneX);
}

function appendPoint(points, point) {
  const last = points[points.length - 1];
  if (last && almostEq(last[0], point[0]) && almostEq(last[1], point[1])) return;
  points.push(pt(point[0], point[1]));
}

/**
 * Horizontal walk from→to at constant y, U-turning around foreign verticals.
 * Returns points after `from`, including `to`.
 */
function horizontalWithDetours(from, to, foreign, cards, preferDown, ignoreIds) {
  if (almostEq(from[0], to[0])) return [pt(to[0], to[1])];

  const y = from[1];
  const xMin = Math.min(from[0], to[0]);
  const xMax = Math.max(from[0], to[0]);
  const dir = Math.sign(to[0] - from[0]) || 1;

  const blockers = [];
  for (const seg of foreign) {
    if (!seg.vertical) continue;
    const sx = seg.x1;
    if (sx <= xMin + EPS || sx >= xMax - EPS) continue;
    const sy1 = Math.min(seg.y1, seg.y2);
    const sy2 = Math.max(seg.y1, seg.y2);
    if (y > sy1 - EPS && y < sy2 + EPS) {
      blockers.push({ x: sx, y1: sy1, y2: sy2 });
    }
  }
  blockers.sort((a, b) => (a.x - b.x) * dir);

  if (!blockers.length) return [pt(to[0], to[1])];

  const out = [];
  let cursorX = from[0];
  let cursorY = y;
  for (const blocker of blockers) {
    const approachX = blocker.x - dir * DETOUR_PAD;
    const pastX = blocker.x + dir * DETOUR_PAD;
    if ((approachX - cursorX) * dir > EPS) {
      appendPoint(out, [approachX, cursorY]);
      cursorX = approachX;
    }
    const detourY = pickDetourY(
      cursorY,
      blocker,
      foreign,
      cards,
      preferDown,
      xMin,
      xMax,
      ignoreIds,
      cursorX,
      pastX,
    );
    appendPoint(out, [cursorX, detourY]);
    appendPoint(out, [pastX, detourY]);
    appendPoint(out, [pastX, y]);
    cursorX = pastX;
    cursorY = y;
  }
  appendPoint(out, [to[0], to[1]]);
  return out;
}

/**
 * Vertical walk from→to at constant x, U-turning around foreign horizontals.
 * Returns points after `from`, including `to`.
 */
function verticalWithDetours(from, to, foreign, cards, preferRight, ignoreIds) {
  if (almostEq(from[1], to[1])) return [pt(to[0], to[1])];

  const x = from[0];
  const yMin = Math.min(from[1], to[1]);
  const yMax = Math.max(from[1], to[1]);
  const dir = Math.sign(to[1] - from[1]) || 1;

  const blockers = [];
  for (const seg of foreign) {
    if (!seg.horizontal) continue;
    const sy = seg.y1;
    if (sy <= yMin + EPS || sy >= yMax - EPS) continue;
    const sx1 = Math.min(seg.x1, seg.x2);
    const sx2 = Math.max(seg.x1, seg.x2);
    if (x > sx1 - EPS && x < sx2 + EPS) {
      blockers.push({ y: sy, x1: sx1, x2: sx2 });
    }
  }
  blockers.sort((a, b) => (a.y - b.y) * dir);

  if (!blockers.length) return [pt(to[0], to[1])];

  const out = [];
  let cursorX = x;
  let cursorY = from[1];
  for (const blocker of blockers) {
    const approachY = blocker.y - dir * DETOUR_PAD;
    const pastY = blocker.y + dir * DETOUR_PAD;
    if ((approachY - cursorY) * dir > EPS) {
      appendPoint(out, [cursorX, approachY]);
      cursorY = approachY;
    }
    const detourX = pickDetourX(
      cursorX,
      blocker,
      foreign,
      cards,
      preferRight,
      yMin,
      yMax,
      ignoreIds,
      cursorY,
      pastY,
    );
    appendPoint(out, [detourX, cursorY]);
    appendPoint(out, [detourX, pastY]);
    appendPoint(out, [x, pastY]);
    cursorX = x;
    cursorY = pastY;
  }
  appendPoint(out, [to[0], to[1]]);
  return out;
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
 * Build polyline for one parent→child edge inside a family junction,
 * detouring around foreign family corridors when needed.
 */
export function routeFamilyParentChild(family, parent, child, isHorizontal, ctx = {}) {
  const foreign = ctx.foreign || [];
  const cards = ctx.cards || [];
  const ignoreIds = new Set([parent.id, child.id]);
  const plan = ctx.busPlan || null;

  if (isHorizontal) {
    const busPlan = plan || chooseHorizontalBusPlan(family, foreign, cards);
    const busX = busPlan.bus;
    const stemY =
      busPlan.stem ??
      roundCoord(family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length);
    const start = pt(parent.x + half(parent, 'x'), parent.y);
    const end =
      busPlan.mode === 'overflow'
        ? pt(child.x + half(child, 'x'), child.y)
        : pt(child.x - half(child, 'x'), child.y);
    const atStemParent = pt(start[0], stemY);
    const atBusStem = pt(busX, stemY);
    const atBusChild = pt(busX, child.y);

    const points = [start];
    for (const p of verticalWithDetours(start, atStemParent, foreign, cards, true, ignoreIds)) {
      appendPoint(points, p);
    }
    for (const p of horizontalWithDetours(
      atStemParent,
      atBusStem,
      foreign,
      cards,
      true,
      ignoreIds,
    )) {
      appendPoint(points, p);
    }
    for (const p of verticalWithDetours(atBusStem, atBusChild, foreign, cards, true, ignoreIds)) {
      appendPoint(points, p);
    }
    for (const p of horizontalWithDetours(atBusChild, end, foreign, cards, true, ignoreIds)) {
      appendPoint(points, p);
    }
    return simplifyPoints(points);
  }

  const busPlan = plan || chooseVerticalBusPlan(family, foreign, cards);
  const busY = busPlan.bus;
  const stemX = busPlan.stem ?? roundCoord(family.parentMidX);
  const start = pt(parent.x, parent.y + half(parent, 'y'));
  const atStemParent = pt(stemX, start[1]);
  const atBusStem = pt(stemX, busY);
  const atBusChild = pt(child.x, busY);
  const end =
    busPlan.mode === 'overflow'
      ? pt(child.x, child.y + half(child, 'y'))
      : pt(child.x, child.y - half(child, 'y'));
  const preferDown = true;
  const preferRight = child.x >= stemX;

  const points = [start];
  for (const p of horizontalWithDetours(
    start,
    atStemParent,
    foreign,
    cards,
    preferDown,
    ignoreIds,
  )) {
    appendPoint(points, p);
  }
  for (const p of verticalWithDetours(
    atStemParent,
    atBusStem,
    foreign,
    cards,
    preferRight,
    ignoreIds,
  )) {
    appendPoint(points, p);
  }
  for (const p of horizontalWithDetours(
    atBusStem,
    atBusChild,
    foreign,
    cards,
    preferDown,
    ignoreIds,
  )) {
    appendPoint(points, p);
  }
  for (const p of verticalWithDetours(atBusChild, end, foreign, cards, preferRight, ignoreIds)) {
    appendPoint(points, p);
  }
  return simplifyPoints(points);
}

function reserveLinkSegments(link, familyKey, reserved) {
  for (const seg of segmentsOfPoints(link.points || [])) {
    reserved.push({ ...seg, familyKey });
  }
}

/**
 * Rebuild link polylines from final node coordinates.
 * Call only after nodes are placed; never mutates people / trees.data.
 */
export function routeLayoutLinks(layout, { orientation = 'vertical' } = {}) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const cards = (layout.nodes || []).map(cardRect);
  const isHorizontal = orientation === 'horizontal';
  const families = assignFamilyLanes(buildParentFamilies(layout), isHorizontal);

  // Small families first so their corridors become obstacles for wider buses.
  const routeOrder = [...families].sort((left, right) => {
    if (left.children.length !== right.children.length) {
      return left.children.length - right.children.length;
    }
    return left.key.localeCompare(right.key);
  });

  /** @type {{ x1:number,y1:number,x2:number,y2:number, horizontal:boolean, vertical:boolean, familyKey:string }[]} */
  const reserved = [];
  const routedByKey = new Map();

  // Spouse links first — short, direct; reserved as soft obstacles.
  for (const link of layout.links || []) {
    if (link.type !== 'spouse') continue;
    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) continue;
    const familyKey = `spouse:${[link.source, link.target].map(String).sort().join('+')}`;
    const routed = {
      ...link,
      familyKey,
      points: routeSpouse(source, target),
    };
    routedByKey.set(`${link.type}:${link.source}->${link.target}`, routed);
    reserveLinkSegments(routed, familyKey, reserved);
  }

  for (const family of routeOrder) {
    const familyKey = `pc:${family.key}`;
    const foreign = reserved.filter((seg) => seg.familyKey !== familyKey);
    const busPlan = isHorizontal
      ? chooseHorizontalBusPlan(family, foreign, cards)
      : chooseVerticalBusPlan(family, foreign, cards);
    const ctx = { foreign, cards, busPlan };

    for (const parentId of family.parentIds) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      for (const child of family.children) {
        const edgeKey = `parent-child:${parentId}->${child.id}`;
        const draft = (layout.links || []).find(
          (link) =>
            link.type === 'parent-child' &&
            String(link.source) === parentId &&
            String(link.target) === child.id,
        );
        if (!draft) continue;
        const points = routeFamilyParentChild(family, parent, child, isHorizontal, ctx);
        const routed = {
          ...draft,
          familyKey,
          laneIndex: family.laneIndex,
          busMode: busPlan.mode,
          points,
        };
        routedByKey.set(edgeKey, routed);
      }
    }

    // Reserve this family's corridors only after all its edges are routed,
    // so same-family links may share stem/bus without treating each other as foreign.
    for (const parentId of family.parentIds) {
      for (const child of family.children) {
        const routed = routedByKey.get(`parent-child:${parentId}->${child.id}`);
        if (routed) reserveLinkSegments(routed, familyKey, reserved);
      }
    }
  }

  return (layout.links || []).map((link) => {
    const key = `${link.type}:${link.source}->${link.target}`;
    if (routedByKey.has(key)) return routedByKey.get(key);

    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) return { ...link, points: link.points || [] };

    if (link.type === 'spouse') {
      return {
        ...link,
        familyKey: `spouse:${[link.source, link.target].map(String).sort().join('+')}`,
        points: routeSpouse(source, target),
      };
    }

    const midY = (source.y + target.y) / 2;
    return {
      ...link,
      familyKey: `pc:${link.source}->${link.target}`,
      points: simplifyPoints([
        pt(source.x, source.y + half(source, 'y')),
        pt(source.x, midY),
        pt(target.x, midY),
        pt(target.x, target.y - half(target, 'y')),
      ]),
    };
  });
}

export function routeSignature(link) {
  const pts = (link.points || []).map((p) => `${roundCoord(p[0])},${roundCoord(p[1])}`).join(';');
  return `${link.type}|${link.source}->${link.target}|${link.familyKey || ''}|${pts}`;
}

export function routingMetrics(links) {
  let maxBends = 0;
  let totalLength = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const link of links || []) {
    if (link.type !== 'parent-child') continue;
    const points = link.points || [];
    maxBends = Math.max(maxBends, Math.max(0, points.length - 2));
    for (let i = 0; i < points.length - 1; i += 1) {
      totalLength += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    }
    for (const p of points) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }

  return {
    maxBendsPerParentChild: maxBends,
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

export function polylineHasZeroLengthSegment(points) {
  for (let i = 0; i < (points || []).length - 1; i += 1) {
    if (almostEq(points[i][0], points[i + 1][0]) && almostEq(points[i][1], points[i + 1][1])) {
      return true;
    }
  }
  return false;
}

function orient(ax, ay, bx, by, cx, cy) {
  const v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : 2;
}

function segmentsCrossProper(a, b) {
  const o1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const o2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const o4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function polylineSelfIntersects(points) {
  const segs = segmentsOfPoints(points || []);
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (j === i + 1) continue;
      if (i === 0 && j === segs.length - 1) continue;
      if (segmentsCrossProper(segs[i], segs[j])) return true;
    }
  }
  return false;
}
