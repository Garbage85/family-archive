/**
 * Synthetic overlapping-family fixtures for routing-corridor stress tests.
 * Positions are Phase-A style (cross-axis only); generation-axis is filled by
 * the dynamic-gap pipeline under test.
 *
 * Layout idea (interval clique):
 *   parents occupy a left block, children a right block, cards never overlap.
 *   Every parent→child bus covers the open middle, so all N buses mutually
 *   conflict and require N independent lanes.
 */

/**
 * N unrelated single-parent→child families with a complete bus-conflict clique.
 */
export function buildOverlappingRouteFixture(
  routeCount,
  {
    cardWidth = 184,
    cardHeight = 170,
    orientation = 'vertical',
    // Keep cards non-overlapping inside a generation.
    crossStep = 220,
  } = {},
) {
  const n = Math.max(1, Math.floor(routeCount));
  const isHorizontal = orientation === 'horizontal';
  const nodes = [];
  const links = [];
  const people = [];
  // Children start beyond the last parent so every bus shares the middle span.
  const childBlockStart = n * crossStep + crossStep;

  for (let i = 0; i < n; i += 1) {
    const parentId = `P${String(i).padStart(3, '0')}`;
    const childId = `C${String(i).padStart(3, '0')}`;
    const parentCross = i * crossStep;
    const childCross = childBlockStart + i * crossStep;
    const parentPos = isHorizontal ? { x: 0, y: parentCross } : { x: parentCross, y: 0 };
    const childPos = isHorizontal ? { x: 0, y: childCross } : { x: childCross, y: 0 };

    nodes.push({
      id: parentId,
      ...parentPos,
      generation: -1,
      width: cardWidth,
      height: cardHeight,
      gender: i % 2 === 0 ? 'M' : 'F',
    });
    nodes.push({
      id: childId,
      ...childPos,
      generation: 0,
      width: cardWidth,
      height: cardHeight,
      gender: i % 2 === 0 ? 'F' : 'M',
    });
    links.push({
      type: 'parent-child',
      source: parentId,
      target: childId,
      points: [],
    });
    people.push({
      id: parentId,
      data: { gender: i % 2 === 0 ? 'M' : 'F' },
      rels: { parents: [], spouses: [], children: [childId] },
    });
    people.push({
      id: childId,
      data: { gender: i % 2 === 0 ? 'F' : 'M' },
      rels: { parents: [parentId], spouses: [], children: [] },
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  links.sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`));
  people.sort((a, b) => a.id.localeCompare(b.id));

  return {
    kind: 'routing-stress',
    routeCount: n,
    orientation,
    cardWidth,
    cardHeight,
    crossStep,
    nodes,
    links,
    people,
  };
}
