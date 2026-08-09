/**
 * Orthogonal link routing for the household layout preview.
 *
 * Limitations (explicit, preview-quality):
 * - Parent-child uses a single mid-generation elbow; dense trees may still
 *   cross unrelated cards (validator can report linksThroughCards).
 * - Spouse links are edge-to-edge on the shared household row.
 * - No global crossing minimization / lane assignment yet.
 * - Coordinates are display-only and must never be written to trees.data.
 */

function half(node, axis) {
  if (axis === 'x') return (node.width ?? 184) / 2;
  return (node.height ?? 170) / 2;
}

function routeSpouse(source, target) {
  const left = source.x <= target.x ? source : target;
  const right = source.x <= target.x ? target : source;
  const y = (left.y + right.y) / 2;
  return [
    [left.x + half(left, 'x'), y],
    [right.x - half(right, 'x'), y],
  ];
}

function routeParentChild(parent, child, isHorizontal) {
  if (isHorizontal) {
    const midX = (parent.x + child.x) / 2;
    return [
      [parent.x + half(parent, 'x'), parent.y],
      [midX, parent.y],
      [midX, child.y],
      [child.x - half(child, 'x'), child.y],
    ];
  }
  const midY = (parent.y + child.y) / 2;
  return [
    [parent.x, parent.y + half(parent, 'y')],
    [parent.x, midY],
    [child.x, midY],
    [child.x, child.y - half(child, 'y')],
  ];
}

/**
 * Rebuild link polylines from final node coordinates.
 * Call only after nodes are placed; never mutates people / trees.data.
 */
export function routeLayoutLinks(layout, { orientation = 'vertical' } = {}) {
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const isHorizontal = orientation === 'horizontal';
  return (layout.links || []).map((link) => {
    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) return { ...link, points: link.points || [] };
    const points =
      link.type === 'spouse'
        ? routeSpouse(source, target)
        : routeParentChild(source, target, isHorizontal);
    return { ...link, points };
  });
}
