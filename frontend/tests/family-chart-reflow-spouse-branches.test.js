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

function assertNoDuplicateCoordinates(tree) {
  const seen = new Map();
  for (const node of tree.data) {
    const key = `${node.x},${node.y}`;
    if (seen.has(key)) {
      assert.fail(`duplicate coordinates ${key}: ${seen.get(key)} and ${nodeId(node)}`);
    }
    seen.set(key, nodeId(node));
  }
}

function assertNoOverlapsOnGeneration(tree, generation, isHorizontal) {
  const cards = tree.data.filter(
    (node) => nodePosition(node, isHorizontal).generation === generation,
  );
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

/**
 * Center spouse has own parents and a spouse-only child; center has siblings
 * with spouses. Mimics FC: sibling spouses and center-spouse branches absent.
 */
function familyWithCenterSpouseBranchesAndSiblings() {
  return [
    person('center', 'M', {
      parents: ['father', 'mother'],
      spouses: ['center-wife'],
      children: ['shared-child'],
    }),
    person('center-wife', 'F', {
      parents: ['wife-father', 'wife-mother'],
      spouses: ['center'],
      children: ['shared-child', 'wife-only-child'],
    }),
    person('wife-father', 'M', {
      spouses: ['wife-mother'],
      children: ['center-wife'],
    }),
    person('wife-mother', 'F', {
      spouses: ['wife-father'],
      children: ['center-wife'],
    }),
    person('shared-child', 'F', { parents: ['center', 'center-wife'] }),
    person('wife-only-child', 'M', { parents: ['center-wife'] }),
    person('brother-a', 'M', {
      parents: ['father', 'mother'],
      spouses: ['brother-a-wife'],
    }),
    person('brother-a-wife', 'F', { spouses: ['brother-a'] }),
    person('brother-b', 'M', {
      parents: ['father', 'mother'],
      spouses: ['brother-b-wife'],
    }),
    person('brother-b-wife', 'F', { spouses: ['brother-b'] }),
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
  ];
}

function calculatedTreeWithSiblingsAndCenterSpouse(chartData, { isHorizontal = false } = {}) {
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

  const sharedChild = {
    data: byId.get('shared-child'),
    depth: 1,
    tid: 'shared-child',
    parent: center,
  };
  place(sharedChild, 0, LEVEL_SEPARATION);
  center.children = [sharedChild];

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
    data: [center, centerWife, sharedChild, father, mother, brotherA, brotherB, sister],
    dim: {
      width: 5 * NODE_SEPARATION,
      height: 3 * LEVEL_SEPARATION,
      x_off: 2.5 * NODE_SEPARATION,
      y_off: 1.5 * LEVEL_SEPARATION,
    },
    is_horizontal: isHorizontal,
  };
}

function apply(chartData, { isHorizontal = false } = {}) {
  const tree = calculatedTreeWithSiblingsAndCenterSpouse(chartData, { isHorizontal });
  includeDirectSpouseBranches(tree, chartData, 'center', {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    isHorizontal,
  });
  return tree;
}

function assertSiblingSpousesPresent(tree) {
  for (const [personId, spouseId] of [
    ['brother-a', 'brother-a-wife'],
    ['brother-b', 'brother-b-wife'],
    ['sister', 'sister-husband'],
  ]) {
    const personNode = nodeById(tree, personId);
    const spouseNode = nodeById(tree, spouseId);
    assert.ok(spouseNode, `${spouseId} missing after reflow`);
    assert.ok(personNode.spouses?.includes(spouseNode));
    assert.equal(spouseNode.spouse, personNode);
  }
}

function assertCenterSpouseBranches(tree, isHorizontal) {
  const wife = nodeById(tree, 'center-wife');
  const wifeFather = nodeById(tree, 'wife-father');
  const wifeMother = nodeById(tree, 'wife-mother');
  const wifeOnlyChild = nodeById(tree, 'wife-only-child');
  const sharedChild = nodeById(tree, 'shared-child');

  assert.ok(wife, 'center spouse missing');
  assert.ok(wifeFather, 'center spouse father missing');
  assert.ok(wifeMother, 'center spouse mother missing');
  assert.ok(wifeOnlyChild, 'spouse-only child missing');
  assert.ok(sharedChild, 'shared child missing');

  assert.ok(wife.parents?.includes(wifeFather));
  assert.ok(wife.parents?.includes(wifeMother));
  assert.equal(wifeFather.parent, wife);
  assert.equal(wifeMother.parent, wife);
  assert.ok(wife.children?.includes(wifeOnlyChild));
  assert.equal(wifeOnlyChild.parent, wife);

  const wifeGeneration = nodePosition(wife, isHorizontal).generation;
  assert.equal(
    nodePosition(wifeFather, isHorizontal).generation,
    wifeGeneration - LEVEL_SEPARATION,
  );
  assert.equal(
    nodePosition(wifeMother, isHorizontal).generation,
    wifeGeneration - LEVEL_SEPARATION,
  );
  assert.equal(
    nodePosition(wifeOnlyChild, isHorizontal).generation,
    wifeGeneration + LEVEL_SEPARATION,
  );
}

function assertLayoutInvariants(tree, isHorizontal) {
  assertNoDuplicateIds(tree);
  assertNoDuplicateCoordinates(tree);
  const mainGeneration = nodePosition(nodeById(tree, 'center'), isHorizontal).generation;
  assertNoOverlapsOnGeneration(tree, mainGeneration, isHorizontal);
  assertSiblingSpousesPresent(tree);
  assertCenterSpouseBranches(tree, isHorizontal);
}

function runOrientationSuite(isHorizontal, label) {
  test(`reflow + center-spouse branches: single pass (${label})`, () => {
    const people = familyWithCenterSpouseBranchesAndSiblings();
    const peopleSnapshot = structuredClone(people);
    const chartData = prepareFamilyChartData(people);
    const chartSnapshot = structuredClone(chartData);
    const tree = apply(chartData, { isHorizontal });

    assertLayoutInvariants(tree, isHorizontal);
    assert.equal(nodeById(tree, 'center').spouses[0], nodeById(tree, 'center-wife'));
    assert.equal(nodeById(tree, 'center-wife').spouse, nodeById(tree, 'center'));
    assert.deepEqual(people, peopleSnapshot);
    assert.deepEqual(chartData, chartSnapshot);
  });

  test(`reflow + center-spouse branches: repeated include keeps grafts (${label})`, () => {
    const chartData = prepareFamilyChartData(familyWithCenterSpouseBranchesAndSiblings());
    const tree = calculatedTreeWithSiblingsAndCenterSpouse(chartData, { isHorizontal });
    const options = {
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
      isHorizontal,
    };

    includeDirectSpouseBranches(tree, chartData, 'center', options);

    const wife = nodeById(tree, 'center-wife');
    const wifeFather = nodeById(tree, 'wife-father');
    const wifeMother = nodeById(tree, 'wife-mother');
    const wifeOnlyChild = nodeById(tree, 'wife-only-child');
    const sharedChild = nodeById(tree, 'shared-child');
    const father = nodeById(tree, 'father');
    const mother = nodeById(tree, 'mother');
    const center = nodeById(tree, 'center');

    const parentsArray = wife.parents;
    const childrenArray = wife.children;
    const centerParents = center.parents;
    const centerChildren = center.children;
    const wifeFatherPos = { x: wifeFather.x, y: wifeFather.y };
    const wifeMotherPos = { x: wifeMother.x, y: wifeMother.y };
    const wifeOnlyChildPos = { x: wifeOnlyChild.x, y: wifeOnlyChild.y };
    const wifePos = { x: wife.x, y: wife.y };
    const bloodParentPos = {
      father: { x: father.x, y: father.y },
      mother: { x: mother.x, y: mother.y },
      sharedChild: { x: sharedChild.x, y: sharedChild.y },
    };

    includeDirectSpouseBranches(tree, chartData, 'center', options);
    includeDirectSpouseBranches(tree, chartData, 'center', options);

    assert.equal(nodeById(tree, 'center-wife'), wife);
    assert.equal(nodeById(tree, 'wife-father'), wifeFather);
    assert.equal(nodeById(tree, 'wife-mother'), wifeMother);
    assert.equal(nodeById(tree, 'wife-only-child'), wifeOnlyChild);
    assert.equal(wife.parents, parentsArray);
    assert.equal(wife.children, childrenArray);
    assert.equal(center.parents, centerParents);
    assert.equal(center.children, centerChildren);
    assert.ok(wife.parents.includes(wifeFather));
    assert.ok(wife.parents.includes(wifeMother));
    assert.equal(wifeFather.parent, wife);
    assert.equal(wifeMother.parent, wife);
    assert.ok(wife.children.includes(wifeOnlyChild));
    assert.equal(wifeOnlyChild.parent, wife);
    assert.deepEqual({ x: wifeFather.x, y: wifeFather.y }, wifeFatherPos);
    assert.deepEqual({ x: wifeMother.x, y: wifeMother.y }, wifeMotherPos);
    assert.deepEqual({ x: wifeOnlyChild.x, y: wifeOnlyChild.y }, wifeOnlyChildPos);
    assert.deepEqual({ x: wife.x, y: wife.y }, wifePos);
    assert.deepEqual({ x: father.x, y: father.y }, bloodParentPos.father);
    assert.deepEqual({ x: mother.x, y: mother.y }, bloodParentPos.mother);
    assert.deepEqual({ x: sharedChild.x, y: sharedChild.y }, bloodParentPos.sharedChild);

    assertLayoutInvariants(tree, isHorizontal);
  });
}

runOrientationSuite(false, 'vertical');
runOrientationSuite(true, 'horizontal');
