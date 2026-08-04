import test from 'node:test';
import assert from 'node:assert/strict';
import * as f3 from 'family-chart';
import { layoutFullFamilyTree, prepareFamilyChartData } from '../src/adapters/family-chart-data.js';

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

function runLayout(people, centerId) {
  const chartData = prepareFamilyChartData(people);
  const tree = f3.calculateTree(structuredClone(chartData), {
    main_id: centerId,
    node_separation: NODE_SEPARATION,
    level_separation: LEVEL_SEPARATION,
    single_parent_empty_card: false,
    show_siblings_of_main: true,
  });
  layoutFullFamilyTree(tree, chartData, centerId, {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
  });
  return tree;
}

function nodeById(tree, id) {
  return tree.data.find((node) => node.data.id === id);
}

function coordinatesById(tree) {
  return tree.data
    .map((node) => [node.data.id, node.x, node.y])
    .sort(([left], [right]) => left.localeCompare(right));
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

test('full layout keeps seven unique people in stable non-overlapping generation bands', () => {
  const people = sevenPersonFamily();
  const snapshot = structuredClone(people);
  const first = runLayout(people, 'center');
  const second = runLayout(people, 'center');
  const spouseCentered = runLayout(people, 'spouse');
  const ids = first.data.map((node) => node.data.id);

  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  assert.equal(first.data[0].data.id, 'center');
  assert.equal(spouseCentered.data[0].data.id, 'spouse');
  assert.deepEqual(
    first.data.map((node) => [node.data.id, node.x, node.y]),
    second.data.map((node) => [node.data.id, node.x, node.y]),
  );
  assert.deepEqual(coordinatesById(first), coordinatesById(spouseCentered));
  assert.equal(nodeById(first, 'center').y, nodeById(first, 'spouse').y);
  assert.equal(
    Math.abs(nodeById(first, 'center').x - nodeById(first, 'spouse').x),
    NODE_SEPARATION,
  );
  for (const [parentId, childId] of [
    ['center-father', 'center'],
    ['center-mother', 'brother'],
    ['spouse-father', 'spouse'],
    ['spouse-mother', 'spouse'],
  ]) {
    assert.ok(nodeById(first, parentId).y < nodeById(first, childId).y);
  }
  assertNoCardOverlaps(first);
  assert.deepEqual(people, snapshot);
});

function threeChildrenWithSpouseFamilies() {
  const people = [
    person('parent-1', 'M', {
      spouses: ['parent-2'],
      children: ['child-1', 'child-2', 'child-3'],
    }),
    person('parent-2', 'F', {
      spouses: ['parent-1'],
      children: ['child-1', 'child-2', 'child-3'],
    }),
  ];
  for (let index = 1; index <= 3; index += 1) {
    people.push(
      person(`child-${index}`, index === 2 ? 'F' : 'M', {
        parents: ['parent-1', 'parent-2'],
        spouses: [`child-${index}-spouse`],
      }),
      person(`child-${index}-spouse`, index === 2 ? 'M' : 'F', {
        parents: [`spouse-${index}-father`, `spouse-${index}-mother`],
        spouses: [`child-${index}`],
      }),
      person(`spouse-${index}-father`, 'M', {
        spouses: [`spouse-${index}-mother`],
        children: [`child-${index}-spouse`],
      }),
      person(`spouse-${index}-mother`, 'F', {
        spouses: [`spouse-${index}-father`],
        children: [`child-${index}-spouse`],
      }),
    );
  }
  return people;
}

test('three child households keep every person exactly once without card overlaps', () => {
  const people = threeChildrenWithSpouseFamilies();
  const snapshot = structuredClone(people);
  const tree = runLayout(people, 'parent-1');
  const ids = tree.data.map((node) => node.data.id);

  assert.equal(ids.length, people.length);
  assert.equal(new Set(ids).size, people.length);
  for (let index = 1; index <= 3; index += 1) {
    const child = nodeById(tree, `child-${index}`);
    const spouse = nodeById(tree, `child-${index}-spouse`);
    assert.equal(child.y, spouse.y);
    assert.equal(Math.abs(child.x - spouse.x), NODE_SEPARATION);
    assert.ok(nodeById(tree, `spouse-${index}-father`).y < spouse.y);
    assert.ok(nodeById(tree, `spouse-${index}-mother`).y < spouse.y);
  }
  assertNoCardOverlaps(tree);
  assert.deepEqual(people, snapshot);
});
