import test from 'node:test';
import assert from 'node:assert/strict';
import {
  includeDirectSpouseBranches,
  prepareFamilyChartData,
} from '../src/adapters/family-chart-data.js';

const NODE_SEPARATION = 236;
const LEVEL_SEPARATION = 224;

function person(id, gender, rels = {}) {
  return {
    id,
    data: { first_name: id, gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

function nodeId(node) {
  return String(node.data?.id || '');
}

function nodeById(tree, id) {
  return tree.data.find((node) => nodeId(node) === String(id));
}

function nodePosition(node, isHorizontal) {
  return isHorizontal
    ? { cross: node.y, generation: node.x }
    : { cross: node.x, generation: node.y };
}

function assertNoDuplicateIds(tree) {
  const ids = tree.data.map(nodeId);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(',')}`);
}

function assertNoOverlapsOnGeneration(tree, generation, isHorizontal) {
  const cards = tree.data.filter(
    (node) => nodePosition(node, isHorizontal).generation === generation,
  );
  const seen = new Map();
  for (const node of cards) {
    const { cross } = nodePosition(node, isHorizontal);
    const key = String(cross);
    if (seen.has(key)) {
      assert.fail(
        `overlap at cross=${cross} generation=${generation}: ${seen.get(key)} and ${nodeId(node)}`,
      );
    }
    seen.set(key, nodeId(node));
  }
  const sorted = [...cards].sort(
    (left, right) =>
      nodePosition(left, isHorizontal).cross - nodePosition(right, isHorizontal).cross,
  );
  for (let i = 1; i < sorted.length; i += 1) {
    const gap =
      nodePosition(sorted[i], isHorizontal).cross - nodePosition(sorted[i - 1], isHorizontal).cross;
    assert.ok(
      gap + 1e-9 >= NODE_SEPARATION,
      `cards ${nodeId(sorted[i - 1])} and ${nodeId(sorted[i])} too close: gap=${gap}`,
    );
  }
}

function assertSpouseLink(tree, personId, spouseId) {
  const personNode = nodeById(tree, personId);
  const spouseNode = nodeById(tree, spouseId);
  assert.ok(personNode, `${personId} missing`);
  assert.ok(spouseNode, `${spouseId} missing`);
  assert.ok(
    personNode.spouses?.includes(spouseNode) || personNode.spouse === spouseNode,
    `${personId} must link to ${spouseId}`,
  );
  assert.equal(spouseNode.spouse, personNode);
  assert.equal(
    nodePosition(spouseNode, tree.is_horizontal).generation,
    nodePosition(personNode, tree.is_horizontal).generation,
  );
}

function multiSiblingFamily() {
  return [
    person('center', 'M', {
      parents: ['father', 'mother'],
      spouses: ['center-wife'],
      children: ['child'],
    }),
    person('center-wife', 'F', { spouses: ['center'], children: ['child'] }),
    person('brother-a', 'M', {
      parents: ['father', 'mother'],
      spouses: ['brother-a-wife'],
    }),
    person('brother-a-wife', 'F', { spouses: ['brother-a'] }),
    person('brother-b', 'M', {
      parents: ['father', 'mother'],
      spouses: ['brother-b-wife-1', 'brother-b-wife-2'],
    }),
    person('brother-b-wife-1', 'F', { spouses: ['brother-b'] }),
    person('brother-b-wife-2', 'F', { spouses: ['brother-b'] }),
    person('sister', 'F', {
      parents: ['father', 'mother'],
      spouses: ['sister-husband'],
    }),
    person('sister-husband', 'M', { spouses: ['sister'] }),
    person('father', 'M', {
      spouses: ['mother'],
      children: ['center', 'brother-a', 'brother-b', 'sister'],
    }),
    person('mother', 'F', {
      spouses: ['father'],
      children: ['center', 'brother-a', 'brother-b', 'sister'],
    }),
    person('child', 'F', { parents: ['center', 'center-wife'] }),
  ];
}

/**
 * Mimics Family Chart after setupSpouses + setupSiblings:
 * center spouse present, siblings present, sibling spouses missing.
 */
function calculatedTreeWithSiblings(chartData, { isHorizontal = false } = {}) {
  const byId = new Map(chartData.map((item) => [item.id, item]));
  const place = (node, cross, generation) => {
    if (isHorizontal) {
      node.x = generation;
      node.y = cross;
    } else {
      node.x = cross;
      node.y = generation;
    }
  };

  const father = {
    data: byId.get('father'),
    depth: 1,
    is_ancestry: true,
    tid: 'father',
  };
  const mother = {
    data: byId.get('mother'),
    depth: 1,
    is_ancestry: true,
    tid: 'mother',
  };
  place(father, -NODE_SEPARATION / 2, -LEVEL_SEPARATION);
  place(mother, NODE_SEPARATION / 2, -LEVEL_SEPARATION);
  father.coparent = mother;
  mother.coparent = father;

  const center = {
    data: byId.get('center'),
    depth: 0,
    tid: 'center',
    parents: [father, mother],
  };
  place(center, 0, 0);
  father.parent = center;
  mother.parent = center;

  const centerWife = {
    data: byId.get('center-wife'),
    depth: 0,
    tid: 'center-wife',
    added: true,
    spouse: center,
  };
  place(centerWife, NODE_SEPARATION, 0);
  centerWife.sx = isHorizontal ? 0 : NODE_SEPARATION / 2;
  centerWife.sy = isHorizontal ? NODE_SEPARATION / 2 : 0;
  center.spouses = [centerWife];

  const child = {
    data: byId.get('child'),
    depth: 1,
    tid: 'child',
    parent: center,
  };
  place(child, 0, LEVEL_SEPARATION);
  center.children = [child];

  // Crowded sibling row: one slot each — will overlap after naive spouse append.
  const brotherA = {
    data: byId.get('brother-a'),
    depth: -1,
    tid: 'brother-a',
    sibling: true,
    parents: [father, mother],
  };
  place(brotherA, -NODE_SEPARATION, 0);

  const brotherB = {
    data: byId.get('brother-b'),
    depth: -1,
    tid: 'brother-b',
    sibling: true,
    parents: [father, mother],
  };
  place(brotherB, -2 * NODE_SEPARATION, 0);

  const sister = {
    data: byId.get('sister'),
    depth: -1,
    tid: 'sister',
    sibling: true,
    parents: [father, mother],
  };
  place(sister, 2 * NODE_SEPARATION, 0);

  return {
    data: [center, centerWife, child, father, mother, brotherA, brotherB, sister],
    dim: {
      width: 5 * NODE_SEPARATION,
      height: 3 * LEVEL_SEPARATION,
      x_off: 2.5 * NODE_SEPARATION,
      y_off: 1.5 * LEVEL_SEPARATION,
    },
    is_horizontal: isHorizontal,
  };
}

function applyLayout(chartData, centerId, { isHorizontal = false } = {}) {
  const tree = calculatedTreeWithSiblings(chartData, { isHorizontal });
  includeDirectSpouseBranches(tree, chartData, centerId, {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    isHorizontal,
  });
  return tree;
}

function expectedSiblingSpouseIds() {
  return [
    ['brother-a', 'brother-a-wife'],
    ['brother-b', 'brother-b-wife-1'],
    ['brother-b', 'brother-b-wife-2'],
    ['sister', 'sister-husband'],
  ];
}

test('two brothers and a sister each get spouses without main-generation overlaps (vertical)', () => {
  const people = multiSiblingFamily();
  const beforePeople = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const beforeChart = structuredClone(chartData);
  const tree = applyLayout(chartData, 'center', { isHorizontal: false });

  for (const [personId, spouseId] of expectedSiblingSpouseIds()) {
    assertSpouseLink(tree, personId, spouseId);
  }
  assertSpouseLink(tree, 'center', 'center-wife');
  assertNoDuplicateIds(tree);
  assertNoOverlapsOnGeneration(tree, 0, false);

  assert.deepEqual(people, beforePeople);
  assert.deepEqual(chartData, beforeChart);
});

test('sibling with two spouses keeps both cards spaced on the main generation', () => {
  const chartData = prepareFamilyChartData(multiSiblingFamily());
  const tree = applyLayout(chartData, 'center');
  const brotherB = nodeById(tree, 'brother-b');
  const wife1 = nodeById(tree, 'brother-b-wife-1');
  const wife2 = nodeById(tree, 'brother-b-wife-2');

  assert.ok(brotherB.spouses.includes(wife1));
  assert.ok(brotherB.spouses.includes(wife2));
  assert.equal(wife1.spouse, brotherB);
  assert.equal(wife2.spouse, brotherB);
  assertNoOverlapsOnGeneration(tree, 0, false);
});

test('center spouse remains and main-generation reflow stays vertical-safe', () => {
  const chartData = prepareFamilyChartData(multiSiblingFamily());
  const tree = applyLayout(chartData, 'center');
  const center = nodeById(tree, 'center');
  const wife = nodeById(tree, 'center-wife');
  assert.equal(center.spouses[0], wife);
  assert.equal(wife.spouse, center);
  assert.equal(center.y, 0);
  assert.equal(wife.y, 0);
  for (const [, spouseId] of expectedSiblingSpouseIds()) {
    assert.ok(nodeById(tree, spouseId), `${spouseId} must be present`);
  }
  assertNoOverlapsOnGeneration(tree, 0, false);
});

test('horizontal layout reflows cross-axis y and keeps generation x', () => {
  const chartData = prepareFamilyChartData(multiSiblingFamily());
  const tree = applyLayout(chartData, 'center', { isHorizontal: true });
  const generation = nodePosition(nodeById(tree, 'center'), true).generation;

  for (const id of [
    'center',
    'center-wife',
    'brother-a',
    'brother-a-wife',
    'brother-b',
    'brother-b-wife-1',
    'brother-b-wife-2',
    'sister',
    'sister-husband',
  ]) {
    assert.equal(nodePosition(nodeById(tree, id), true).generation, generation);
  }
  for (const [personId, spouseId] of expectedSiblingSpouseIds()) {
    assertSpouseLink(tree, personId, spouseId);
  }
  assertNoDuplicateIds(tree);
  assertNoOverlapsOnGeneration(tree, generation, true);
});

test('parent and child object refs keep identity while only main-generation crosses move', () => {
  const chartData = prepareFamilyChartData(multiSiblingFamily());
  const tree = calculatedTreeWithSiblings(chartData);
  const center = nodeById(tree, 'center');
  const father = nodeById(tree, 'father');
  const mother = nodeById(tree, 'mother');
  const child = nodeById(tree, 'child');
  const brotherA = nodeById(tree, 'brother-a');
  const fatherPos = { x: father.x, y: father.y };
  const motherPos = { x: mother.x, y: mother.y };
  const childPos = { x: child.x, y: child.y };
  const parentsBefore = center.parents;
  const childrenBefore = center.children;
  const brotherParentsBefore = brotherA.parents;

  includeDirectSpouseBranches(tree, chartData, 'center', {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
  });

  assert.ok(nodeById(tree, 'brother-a-wife'), 'sibling spouse must be appended');
  assert.equal(center.parents, parentsBefore);
  assert.equal(center.children, childrenBefore);
  assert.equal(brotherA.parents, brotherParentsBefore);
  assert.equal(center.parents[0], father);
  assert.equal(center.parents[1], mother);
  assert.equal(center.children[0], child);
  assert.equal(brotherA.parents[0], father);
  assert.equal(brotherA.parents[1], mother);
  assert.equal(child.parent, center);
  assert.deepEqual({ x: father.x, y: father.y }, fatherPos);
  assert.deepEqual({ x: mother.x, y: mother.y }, motherPos);
  assert.deepEqual({ x: child.x, y: child.y }, childPos);
  assertNoOverlapsOnGeneration(tree, 0, false);
});

test('100 rebuilds with repeated includeDirectSpouseBranches stay idempotent without duplicates', () => {
  const people = multiSiblingFamily();
  const peopleSnapshot = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const chartSnapshot = structuredClone(chartData);

  for (let i = 0; i < 100; i += 1) {
    const isHorizontal = i % 2 === 1;
    const tree = calculatedTreeWithSiblings(chartData, { isHorizontal });
    includeDirectSpouseBranches(tree, chartData, 'center', {
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
      isHorizontal,
    });
    includeDirectSpouseBranches(tree, chartData, 'center', {
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
      isHorizontal,
    });
    assertNoDuplicateIds(tree);
    assertNoOverlapsOnGeneration(
      tree,
      nodePosition(nodeById(tree, 'center'), isHorizontal).generation,
      isHorizontal,
    );
    for (const [personId, spouseId] of expectedSiblingSpouseIds()) {
      assert.ok(nodeById(tree, spouseId), `missing ${spouseId} on iteration ${i}`);
      assertSpouseLink(tree, personId, spouseId);
    }
  }

  assert.deepEqual(chartData, chartSnapshot);
  assert.deepEqual(people, peopleSnapshot);
});

test('stress: repeated calculateTree-style rebuilds keep spouse links and no overlaps', () => {
  const chartData = prepareFamilyChartData(multiSiblingFamily());
  let previousIds = null;
  for (let i = 0; i < 20; i += 1) {
    const tree = applyLayout(chartData, 'center', { isHorizontal: i % 2 === 1 });
    const ids = tree.data.map(nodeId).sort();
    assertNoDuplicateIds(tree);
    assertNoOverlapsOnGeneration(
      tree,
      nodePosition(nodeById(tree, 'center'), tree.is_horizontal).generation,
      tree.is_horizontal,
    );
    for (const [personId, spouseId] of expectedSiblingSpouseIds()) {
      assertSpouseLink(tree, personId, spouseId);
    }
    if (previousIds) assert.deepEqual(ids, previousIds);
    previousIds = ids;
  }
});

test('stress: f3.calculateTree center switches keep sibling spouses without overlaps or ref rebuilds', async () => {
  const f3 = await import('family-chart');
  const people = multiSiblingFamily();
  const peopleSnapshot = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const chartSnapshot = structuredClone(chartData);
  const centers = ['center', 'brother-a', 'brother-b', 'sister'];

  for (let i = 0; i < 100; i += 1) {
    const mainId = centers[i % centers.length];
    const isHorizontal = i % 3 === 0;
    const tree = f3.calculateTree(structuredClone(chartData), {
      main_id: mainId,
      node_separation: NODE_SEPARATION,
      level_separation: LEVEL_SEPARATION,
      show_siblings_of_main: true,
      single_parent_empty_card: false,
      is_horizontal: isHorizontal,
      ancestry_depth: 8,
      progeny_depth: 8,
    });
    const beforeNodes = new Map(tree.data.map((node) => [nodeId(node), node]));
    const parentRefs = new Map(
      tree.data
        .filter((node) => Array.isArray(node.parents))
        .map((node) => [nodeId(node), node.parents]),
    );

    includeDirectSpouseBranches(tree, chartData, mainId, {
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
      isHorizontal,
    });

    assertNoDuplicateIds(tree);
    for (const [id, node] of beforeNodes) {
      assert.equal(nodeById(tree, id), node, `node identity changed for ${id}`);
    }
    for (const [id, parents] of parentRefs) {
      assert.equal(nodeById(tree, id).parents, parents, `parents array rebuilt for ${id}`);
    }

    const mainNode = nodeById(tree, mainId);
    assert.ok(mainNode);
    assertNoOverlapsOnGeneration(
      tree,
      nodePosition(mainNode, isHorizontal).generation,
      isHorizontal,
    );

    const siblings = tree.data.filter((node) => node.sibling);
    for (const sibling of siblings) {
      const person = chartData.find((item) => item.id === nodeId(sibling));
      for (const spouseId of person?.rels.spouses || []) {
        assert.ok(nodeById(tree, spouseId), `${nodeId(sibling)} missing spouse ${spouseId}`);
        assertSpouseLink(tree, nodeId(sibling), spouseId);
      }
    }
  }

  assert.deepEqual(chartData, chartSnapshot);
  assert.deepEqual(people, peopleSnapshot);
});
