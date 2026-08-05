import test from 'node:test';
import assert from 'node:assert/strict';
import * as f3 from 'family-chart';
import {
  includeDirectSpouseBranches,
  prepareFamilyChartData,
} from '../src/adapters/family-chart-data.js';

const CARD_WIDTH = 184;
const CARD_HEIGHT = 170;
const NODE_SEPARATION = 236;
const LEVEL_SEPARATION = 224;

function person(id, gender, rels = {}) {
  return {
    id,
    data: { first_name: id, gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

function sevenPersonFamily() {
  return [
    person('center', 'M', {
      parents: ['center-father', 'center-mother'],
      spouses: ['spouse'],
    }),
    person('brother', 'M', { parents: ['center-father', 'center-mother'] }),
    person('spouse', 'F', {
      parents: ['spouse-father', 'spouse-mother'],
      spouses: ['center'],
    }),
    person('center-father', 'M', {
      spouses: ['center-mother'],
      children: ['center', 'brother'],
    }),
    person('center-mother', 'F', {
      spouses: ['center-father'],
      children: ['center', 'brother'],
    }),
    person('spouse-father', 'M', {
      spouses: ['spouse-mother'],
      children: ['spouse'],
    }),
    person('spouse-mother', 'F', {
      spouses: ['spouse-father'],
      children: ['spouse'],
    }),
  ];
}

function withEighthChild(people) {
  const updated = structuredClone(people);
  updated.find((item) => item.id === 'center').rels.children.push('child');
  updated.find((item) => item.id === 'spouse').rels.children.push('child');
  updated.push(person('child', 'F', { parents: ['center', 'spouse'] }));
  return updated;
}

function treeOptions(mainId) {
  return {
    main_id: mainId,
    node_separation: NODE_SEPARATION,
    level_separation: LEVEL_SEPARATION,
    single_parent_empty_card: false,
    show_siblings_of_main: true,
    ancestry_depth: 8,
    progeny_depth: 8,
    sortChildrenFunction: (left, right) => left.id.localeCompare(right.id),
    sortSpousesFunction: (item) => item.rels.spouses.sort(),
  };
}

function calculateLayout(chartData, centerId) {
  const tree = f3.calculateTree(structuredClone(chartData), treeOptions(centerId));
  const existingNodes = new Map(tree.data.map((node) => [node.data.id, node]));
  const dataSnapshot = structuredClone(tree.data_stash);
  includeDirectSpouseBranches(tree, chartData, centerId, {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    calculateTree: f3.calculateTree,
  });
  assert.deepEqual(tree.data_stash, dataSnapshot);
  return { tree, existingNodes };
}

function nodeById(tree, id) {
  return tree.data.find((node) => node.data.id === id);
}

function ids(tree) {
  return tree.data.map((node) => node.data.id);
}

function coordinates(tree) {
  return tree.data
    .map((node) => [node.data.id, node.x, node.y])
    .sort(([left], [right]) => left.localeCompare(right));
}

function assertUniquePeople(tree, expectedCount) {
  assert.equal(tree.data.length, expectedCount);
  assert.equal(new Set(ids(tree)).size, expectedCount);
}

function assertNoCardOverlaps(tree) {
  for (let leftIndex = 0; leftIndex < tree.data.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tree.data.length; rightIndex += 1) {
      const left = tree.data[leftIndex];
      const right = tree.data[rightIndex];
      const separated =
        Math.abs(left.x - right.x) >= CARD_WIDTH || Math.abs(left.y - right.y) >= CARD_HEIGHT;
      assert.ok(separated, `${left.data.id} overlaps ${right.data.id}`);
    }
  }
}

function assertReferencesBelongToTree(tree) {
  const nodes = new Set(tree.data);
  for (const node of tree.data) {
    for (const field of ['parent', 'spouse', 'coparent']) {
      if (node[field]) assert.ok(nodes.has(node[field]), `${node.data.id}.${field} leaves tree`);
    }
    for (const field of ['parents', 'children', 'spouses']) {
      if (node[field]) {
        assert.ok(
          node[field].length > 0,
          `${node.data.id}.${field} must be absent instead of empty`,
        );
      }
      for (const relative of node[field] || []) {
        assert.ok(nodes.has(relative), `${node.data.id}.${field} leaves tree`);
      }
    }
  }
}

function assertSevenPersonLinks(tree) {
  const center = nodeById(tree, 'center');
  const spouse = nodeById(tree, 'spouse');
  const brother = nodeById(tree, 'brother');
  const centerFather = nodeById(tree, 'center-father');
  const centerMother = nodeById(tree, 'center-mother');
  const spouseFather = nodeById(tree, 'spouse-father');
  const spouseMother = nodeById(tree, 'spouse-mother');

  assert.deepEqual(new Set(center.parents), new Set([centerFather, centerMother]));
  assert.deepEqual(new Set(brother.parents), new Set([centerFather, centerMother]));
  assert.deepEqual(new Set(spouse.parents), new Set([spouseFather, spouseMother]));
  assert.ok(center.spouses?.includes(spouse) || spouse.spouses?.includes(center));
  assert.ok(center.spouse === spouse || spouse.spouse === center);
  assert.equal(centerFather.coparent, centerMother);
  assert.equal(centerMother.coparent, centerFather);
  assert.equal(spouseFather.coparent, spouseMother);
  assert.equal(spouseMother.coparent, spouseFather);
}

test('real Family Chart nodes retain links and occupy seven non-overlapping card areas', () => {
  const people = sevenPersonFamily();
  const peopleSnapshot = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const chartDataSnapshot = structuredClone(chartData);
  const first = calculateLayout(chartData, 'center');
  const second = calculateLayout(chartData, 'center');

  assertUniquePeople(first.tree, 7);
  assertNoCardOverlaps(first.tree);
  assertReferencesBelongToTree(first.tree);
  assertSevenPersonLinks(first.tree);
  assert.deepEqual(coordinates(first.tree), coordinates(second.tree));
  for (const [id, node] of first.existingNodes) assert.equal(nodeById(first.tree, id), node);
  assert.equal(nodeById(first.tree, 'center-father').parent, nodeById(first.tree, 'center'));
  assert.equal(nodeById(first.tree, 'center-mother').parent, nodeById(first.tree, 'center'));
  assert.equal(nodeById(first.tree, 'spouse').spouse, nodeById(first.tree, 'center'));
  for (const id of ['spouse-father', 'spouse-mother']) {
    assert.equal(
      nodeById(first.tree, id).data,
      first.tree.data_stash.find((item) => item.id === id),
    );
  }

  assert.equal(nodeById(first.tree, 'center').y, nodeById(first.tree, 'spouse').y);
  for (const [parentId, childId] of [
    ['center-father', 'center'],
    ['center-mother', 'brother'],
    ['spouse-father', 'spouse'],
    ['spouse-mother', 'spouse'],
  ]) {
    assert.ok(nodeById(first.tree, parentId).y < nodeById(first.tree, childId).y);
  }
  assert.deepEqual(chartData, chartDataSnapshot);
  assert.deepEqual(people, peopleSnapshot);
});

test('adding an eighth person with stale chartData recalculates without losing transient nodes', () => {
  const people = sevenPersonFamily();
  const originalSnapshot = structuredClone(people);
  const staleChartData = prepareFamilyChartData(people);
  const staleSnapshot = structuredClone(staleChartData);
  const updatedPeople = withEighthChild(people);
  const updatedSnapshot = structuredClone(updatedPeople);
  const updatedChartData = prepareFamilyChartData(updatedPeople);
  const store = f3.createStore({ data: structuredClone(staleChartData), ...treeOptions('center') });

  store.updateTree();
  includeDirectSpouseBranches(store.getTree(), staleChartData, 'center', {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    calculateTree: f3.calculateTree,
  });
  store.updateData(structuredClone(updatedChartData));
  store.updateTree();
  includeDirectSpouseBranches(store.getTree(), staleChartData, 'center', {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    calculateTree: f3.calculateTree,
  });

  const tree = store.getTree();
  const child = nodeById(tree, 'child');
  const center = nodeById(tree, 'center');
  assertUniquePeople(tree, 8);
  assert.equal(child.parent, center);
  assert.ok(center.children.includes(child));
  assert.deepEqual(child.data.rels.parents, ['center', 'spouse']);
  assertReferencesBelongToTree(tree);
  assertNoCardOverlaps(tree);
  assert.deepEqual(staleChartData, staleSnapshot);
  assert.deepEqual(updatedPeople, updatedSnapshot);
  assert.deepEqual(people, originalSnapshot);
});

test('repeated updateMainId and updateTree preserve the full transient structure', () => {
  const people = withEighthChild(sevenPersonFamily());
  const chartData = prepareFamilyChartData(people);
  const snapshot = structuredClone(chartData);
  const store = f3.createStore({ data: structuredClone(chartData), ...treeOptions('center') });

  for (const centerId of ['center', 'spouse', 'center']) {
    store.updateMainId(centerId);
    store.updateTree();
    includeDirectSpouseBranches(store.getTree(), chartData, centerId, {
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
      calculateTree: f3.calculateTree,
    });
    const tree = store.getTree();
    assert.equal(store.getTreeMainDatum().data.id, centerId);
    assertUniquePeople(tree, 8);
    assertReferencesBelongToTree(tree);
    assertSevenPersonLinks(tree);
    assertNoCardOverlaps(tree);
  }

  assert.deepEqual(chartData, snapshot);
});
