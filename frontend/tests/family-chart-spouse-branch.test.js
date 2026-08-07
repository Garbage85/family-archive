import test from 'node:test';
import assert from 'node:assert/strict';
import {
  includeDirectSpouseBranches,
  prepareFamilyChartData,
} from '../src/adapters/family-chart-data.js';
import { computeAllKinships } from '../src/kinship-engine.js';

function person(id, gender, rels = {}) {
  return {
    id,
    data: { first_name: id, gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

function family() {
  return [
    person('alexey', 'M', {
      parents: ['sergey', 'elena'],
      spouses: ['alexandra'],
      children: ['pair-child', 'alexey-child'],
    }),
    person('alexandra', 'F', {
      parents: ['vasily', 'natalia'],
      spouses: ['alexey'],
      children: ['pair-child'],
    }),
    person('sergey', 'M', { children: ['alexey'] }),
    person('elena', 'F', { children: ['alexey'] }),
    person('vasily', 'M', { children: ['alexandra'] }),
    person('natalia', 'F', { children: ['alexandra'] }),
    person('pair-child', 'F', { parents: ['alexey', 'alexandra'] }),
    person('alexey-child', 'M', { parents: ['alexey'] }),
  ];
}

function calculatedTree(chartData, centerId) {
  const byId = new Map(chartData.map((item) => [item.id, item]));
  const spouseId = byId.get(centerId).rels.spouses[0];
  const center = { data: byId.get(centerId), x: 118, y: 0, depth: 0, tid: centerId };
  const spouse = {
    data: byId.get(spouseId),
    x: -118,
    y: 0,
    depth: 0,
    tid: spouseId,
    added: true,
    spouse: center,
    sx: 0,
    sy: 0,
  };
  center.spouses = [spouse];
  return {
    data: [center, spouse],
    dim: { width: 472, height: 224, x_off: 236, y_off: 112 },
    is_horizontal: false,
  };
}

test('changing center keeps both spouses, both direct parent branches and spouse children', () => {
  const people = family();
  const before = structuredClone(people);
  const chartData = prepareFamilyChartData(people);

  for (const centerId of ['alexey', 'alexandra']) {
    const tree = calculatedTree(chartData, centerId);
    includeDirectSpouseBranches(tree, chartData, centerId);
    const ids = tree.data.map((node) => node.data.id);
    const spouseId = centerId === 'alexey' ? 'alexandra' : 'alexey';
    const expectedParents = centerId === 'alexey' ? ['vasily', 'natalia'] : ['sergey', 'elena'];
    assert.ok(ids.includes(centerId));
    assert.ok(ids.includes(spouseId));
    assert.ok(expectedParents.every((id) => ids.includes(id)));
    assert.equal(new Set(ids).size, ids.length);
  }

  const alexandraTree = calculatedTree(chartData, 'alexandra');
  includeDirectSpouseBranches(alexandraTree, chartData, 'alexandra');
  assert.ok(alexandraTree.data.some((node) => node.data.id === 'alexey-child'));
  assert.deepEqual(people, before);
});

test('spouse parents stay affinal and never become center parents or saved facts', () => {
  const people = family();
  const chartData = prepareFamilyChartData(people);
  const tree = calculatedTree(chartData, 'alexandra');
  includeDirectSpouseBranches(tree, chartData, 'alexandra');

  const center = chartData.find((item) => item.id === 'alexandra');
  assert.deepEqual(center.rels.parents, ['natalia', 'vasily']);
  assert.equal(center.rels.parents.includes('sergey'), false);
  assert.equal(center.rels.parents.includes('elena'), false);

  const kinships = computeAllKinships({ people, centerId: 'alexandra' }).kinships;
  assert.equal(kinships.get('sergey').kind, 'affinal');
  assert.equal(kinships.get('sergey').label, 'свёкор');
  assert.equal(kinships.get('elena').kind, 'affinal');
  assert.equal(kinships.get('elena').label, 'свекровь');
  assert.equal(JSON.stringify(people).includes('compatibility'), false);
});

test('repeated center switching adds no duplicate layout people', () => {
  const chartData = prepareFamilyChartData(family());
  for (const centerId of ['alexey', 'alexandra', 'alexey']) {
    const tree = calculatedTree(chartData, centerId);
    includeDirectSpouseBranches(tree, chartData, centerId);
    const ids = tree.data.map((node) => node.data.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

function familyWithSiblingSpouse() {
  return [
    person('center', 'M', {
      parents: ['father', 'mother'],
      spouses: ['center-wife'],
      children: ['child'],
    }),
    person('center-wife', 'F', { spouses: ['center'], children: ['child'] }),
    person('brother', 'M', {
      parents: ['father', 'mother'],
      spouses: ['brother-wife'],
    }),
    person('brother-wife', 'F', {
      parents: ['in-law-father', 'in-law-mother'],
      spouses: ['brother'],
    }),
    person('father', 'M', { spouses: ['mother'], children: ['center', 'brother'] }),
    person('mother', 'F', { spouses: ['father'], children: ['center', 'brother'] }),
    person('child', 'F', { parents: ['center', 'center-wife'] }),
    person('in-law-father', 'M', {
      spouses: ['in-law-mother'],
      children: ['brother-wife'],
    }),
    person('in-law-mother', 'F', {
      spouses: ['in-law-father'],
      children: ['brother-wife'],
    }),
  ];
}

/**
 * Mimics Family Chart after setupSpouses + setupSiblings:
 * center spouse is present, sibling is present, sibling spouse is missing.
 */
function calculatedTreeWithSibling(chartData) {
  const byId = new Map(chartData.map((item) => [item.id, item]));
  const father = {
    data: byId.get('father'),
    x: -118,
    y: -224,
    depth: 1,
    is_ancestry: true,
    tid: 'father',
  };
  const mother = {
    data: byId.get('mother'),
    x: 118,
    y: -224,
    depth: 1,
    is_ancestry: true,
    tid: 'mother',
  };
  father.coparent = mother;
  mother.coparent = father;

  const center = {
    data: byId.get('center'),
    x: 0,
    y: 0,
    depth: 0,
    tid: 'center',
    parents: [father, mother],
  };
  father.parent = center;
  mother.parent = center;

  const centerWife = {
    data: byId.get('center-wife'),
    x: 236,
    y: 0,
    depth: 0,
    tid: 'center-wife',
    added: true,
    spouse: center,
    sx: 118,
    sy: 0,
  };
  center.spouses = [centerWife];

  const child = {
    data: byId.get('child'),
    x: 0,
    y: 224,
    depth: 1,
    tid: 'child',
    parent: center,
  };
  center.children = [child];

  const brother = {
    data: byId.get('brother'),
    x: -236,
    y: 0,
    depth: -1,
    tid: 'brother',
    sibling: true,
    parents: [father, mother],
  };

  return {
    data: [center, centerWife, child, father, mother, brother],
    dim: { width: 944, height: 672, x_off: 472, y_off: 336 },
    is_horizontal: false,
  };
}

test('displayed sibling gets missing spouse appended with spouse link without dropping center links', () => {
  const people = familyWithSiblingSpouse();
  const beforePeople = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const tree = calculatedTreeWithSibling(chartData);

  const centerNode = tree.data.find((node) => node.data.id === 'center');
  const centerWifeNode = tree.data.find((node) => node.data.id === 'center-wife');
  const brotherNode = tree.data.find((node) => node.data.id === 'brother');
  const fatherNode = tree.data.find((node) => node.data.id === 'father');
  const motherNode = tree.data.find((node) => node.data.id === 'mother');
  const childNode = tree.data.find((node) => node.data.id === 'child');
  const nodesBefore = new Set(tree.data);

  assert.equal(
    tree.data.some((node) => node.data.id === 'brother-wife'),
    false,
    'precondition: Family Chart fixture omits sibling spouse',
  );

  includeDirectSpouseBranches(tree, chartData, 'center');

  const brotherWifeNode = tree.data.find((node) => node.data.id === 'brother-wife');
  assert.ok(brotherWifeNode, 'sibling spouse must appear in the transient tree');
  assert.equal(brotherWifeNode.spouse, brotherNode);
  assert.ok(Array.isArray(brotherNode.spouses));
  assert.ok(brotherNode.spouses.includes(brotherWifeNode), 'sibling must keep a spouse link');
  assert.equal(brotherWifeNode.y, brotherNode.y);

  assert.ok(tree.data.includes(centerNode));
  assert.ok(tree.data.includes(centerWifeNode));
  assert.ok(tree.data.includes(brotherNode));
  assert.ok(tree.data.includes(fatherNode));
  assert.ok(tree.data.includes(motherNode));
  assert.ok(tree.data.includes(childNode));
  assert.equal(centerNode.spouses[0], centerWifeNode);
  assert.equal(centerWifeNode.spouse, centerNode);
  assert.deepEqual(centerNode.parents, [fatherNode, motherNode]);
  assert.deepEqual(centerNode.children, [childNode]);
  assert.deepEqual(brotherNode.parents, [fatherNode, motherNode]);

  for (const node of nodesBefore) {
    assert.ok(tree.data.includes(node), 'existing transient nodes must be preserved by identity');
  }
  assert.equal(
    tree.data.some((node) => node.data.id === 'in-law-father'),
    false,
    'parents of sibling spouses must not be added',
  );
  assert.equal(
    tree.data.some((node) => node.data.id === 'in-law-mother'),
    false,
    'parents of sibling spouses must not be added',
  );

  const ids = tree.data.map((node) => node.data.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(people, beforePeople);
});
