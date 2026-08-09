/**
 * Orthogonal link routing for the household layout preview.
 *
 * Parent-child links use a family-junction / bus model (nodes stay fixed):
 *
 *   parents household
 *          |
 *       junction
 *      /   |   \
 *   child child child
 *
 * Different parent couples get distinct lane offsets in the generation gap.
 * Lane order is chosen so a family's horizontal bus sits below the stems it
 * would otherwise cross (reduces unrelated crossings).
 * Spouse links stay short edge-to-edge links inside a household.
 *
 * Coordinates are display-only and must never be written to trees.data.
 */

const LANE_GAP = 16;
const BUS_INSET = 10;

function half(node, axis) {
  if (axis === 'x') return (node.width ?? 184) / 2;
  return (node.height ?? 170) / 2;
}

function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

function routeSpouse(source, target) {
  const left = source.x <= target.x ? source : target;
  const right = source.x <= target.x ? target : source;
  const y = (left.y + right.y) / 2;
  return [
    [roundCoord(left.x + half(left, 'x')), roundCoord(y)],
    [roundCoord(right.x - half(right, 'x')), roundCoord(y)],
  ];
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
    family.parentRight = Math.max(...family.parents.map((node) => node.x + half(node, 'x')));
    family.parentLeft = Math.min(...family.parents.map((node) => node.x - half(node, 'x')));
    family.childTop = Math.min(...family.children.map((node) => node.y - half(node, 'y')));
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

  // Constraint: if A crosses stem(B), rank(A) > rank(B) (A bus closer to children).
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
    // Spread from near-parents (low rank) toward children (high rank).
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

/**
 * Build polyline for one parent→child edge inside a family junction.
 * Same-family edges share stem X and bus coordinate; drops are per child.
 */
export function routeFamilyParentChild(family, parent, child, isHorizontal) {
  if (isHorizontal) {
    const busX = horizontalBusX(family);
    const stemY = roundCoord(
      family.parents.reduce((sum, node) => sum + node.y, 0) / family.parents.length,
    );
    const parentAttachX = roundCoord(parent.x + half(parent, 'x'));
    const parentAttachY = roundCoord(parent.y);
    const childAttachX = roundCoord(child.x - half(child, 'x'));
    const childAttachY = roundCoord(child.y);
    return [
      [parentAttachX, parentAttachY],
      [busX, parentAttachY],
      [busX, stemY],
      [busX, childAttachY],
      [childAttachX, childAttachY],
    ].map((point) => [roundCoord(point[0]), roundCoord(point[1])]);
  }

  const busY = verticalBusY(family);
  const stemX = roundCoord(family.parentMidX);
  const parentAttachX = roundCoord(parent.x);
  const parentAttachY = roundCoord(parent.y + half(parent, 'y'));
  const childAttachX = roundCoord(child.x);
  const childAttachY = roundCoord(child.y - half(child, 'y'));

  return [
    [parentAttachX, parentAttachY],
    [stemX, parentAttachY],
    [stemX, busY],
    [childAttachX, busY],
    [childAttachX, childAttachY],
  ].map((point) => [roundCoord(point[0]), roundCoord(point[1])]);
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

  return (layout.links || []).map((link) => {
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

    const family = familyByParentChild.get(`${link.source}->${link.target}`);
    if (!family) {
      const midY = (source.y + target.y) / 2;
      return {
        ...link,
        familyKey: `pc:${link.source}->${link.target}`,
        points: [
          [source.x, source.y + half(source, 'y')],
          [source.x, midY],
          [target.x, midY],
          [target.x, target.y - half(target, 'y')],
        ].map((point) => [roundCoord(point[0]), roundCoord(point[1])]),
      };
    }

    return {
      ...link,
      familyKey: `pc:${family.key}`,
      laneIndex: family.laneIndex,
      points: routeFamilyParentChild(family, source, target, isHorizontal),
    };
  });
}
