import test from 'node:test';
import assert from 'node:assert/strict';
import * as f3 from 'family-chart';
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

function treeOptions(mainId, { isHorizontal = false } = {}) {
  return {
    main_id: mainId,
    node_separation: NODE_SEPARATION,
    level_separation: LEVEL_SEPARATION,
    show_siblings_of_main: true,
    single_parent_empty_card: false,
    is_horizontal: isHorizontal,
    ancestry_depth: 8,
    progeny_depth: 8,
  };
}

function calculate(people, mainId, { isHorizontal = false } = {}) {
  const chartData = prepareFamilyChartData(people);
  const tree = f3.calculateTree(structuredClone(chartData), treeOptions(mainId, { isHorizontal }));
  return { tree, chartData, people };
}

function applyCenterSpouseBranches(tree, chartData, mainId, { isHorizontal = false } = {}) {
  includeDirectSpouseBranches(tree, chartData, mainId, {
    nodeSeparation: NODE_SEPARATION,
    levelSeparation: LEVEL_SEPARATION,
    isHorizontal,
  });
  return tree;
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
      assert.fail(`overlap at ${key}: ${seen.get(key)} and ${nodeId(node)}`);
    }
    seen.set(key, nodeId(node));
  }
}

function assertNoOverlapsOnGeneration(tree, generation, isHorizontal) {
  // calculateTree swaps node/level separation when is_horizontal is true, so the
  // cross-axis step equals levelSeparation in horizontal mode.
  const crossSeparation = isHorizontal ? LEVEL_SEPARATION : NODE_SEPARATION;
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
      gap + 1e-9 >= crossSeparation,
      `cards ${nodeId(sorted[i - 1])} and ${nodeId(sorted[i])} too close: gap=${gap}`,
    );
  }
}

function assertSpouseLink(tree, personId, spouseId) {
  const personNode = nodeById(tree, personId);
  const spouseNode = nodeById(tree, spouseId);
  assert.ok(personNode, `${personId} missing`);
  assert.ok(spouseNode, `${spouseId} missing from calculated tree`);
  assert.ok(
    personNode.spouses?.includes(spouseNode),
    `${personId}.spouses must include ${spouseId}`,
  );
  assert.equal(spouseNode.spouse, personNode);
}

function coordinatesById(tree) {
  return Object.fromEntries(
    tree.data
      .map((node) => [nodeId(node), { x: node.x, y: node.y }])
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

/** Siblings without spouses — must match stock family-chart@0.9.0 geometry. */
function familyWithoutSiblingSpouses() {
  return [
    person('center', 'M', {
      parents: ['father', 'mother'],
      spouses: ['center-wife'],
      children: ['child'],
    }),
    person('center-wife', 'F', { spouses: ['center'], children: ['child'] }),
    person('brother', 'M', { parents: ['father', 'mother'] }),
    person('sister', 'F', { parents: ['father', 'mother'] }),
    person('father', 'M', {
      spouses: ['mother'],
      children: ['center', 'brother', 'sister'],
    }),
    person('mother', 'F', {
      spouses: ['father'],
      children: ['center', 'brother', 'sister'],
    }),
    person('child', 'F', { parents: ['center', 'center-wife'] }),
  ];
}

/**
 * Captured from unpatched family-chart@0.9.0 calculateTree with the same options.
 * Patch must not change this layout (ADR-008 unused).
 */
const VANILLA_NO_SIBLING_SPOUSE_COORDS = {
  brother: { x: 354, y: 0 },
  center: { x: -118, y: 0 },
  'center-wife': { x: 118, y: 0 },
  child: { x: 0, y: 224 },
  father: { x: -118, y: -224 },
  mother: { x: 118, y: -224 },
  sister: { x: 590, y: 0 },
};

function familyWithSiblingSpousesAndCenterBranches() {
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
  ];
}

test('patch keeps vanilla geometry when siblings have no spouses', () => {
  const { tree } = calculate(familyWithoutSiblingSpouses(), 'center');
  assert.deepEqual(coordinatesById(tree), VANILLA_NO_SIBLING_SPOUSE_COORDS);
  assert.equal(nodeById(tree, 'brother').sibling, true);
  assert.equal(nodeById(tree, 'sister').sibling, true);
  assert.equal(nodeById(tree, 'brother').spouses, undefined);
  assertNoDuplicateIds(tree);
  assertNoDuplicateCoordinates(tree);
});

test('patch keeps center parent positions when ADR-008 is unused', () => {
  const { tree } = calculate(familyWithoutSiblingSpouses(), 'center');
  assert.deepEqual(
    { x: nodeById(tree, 'father').x, y: nodeById(tree, 'father').y },
    VANILLA_NO_SIBLING_SPOUSE_COORDS.father,
  );
  assert.deepEqual(
    { x: nodeById(tree, 'mother').x, y: nodeById(tree, 'mother').y },
    VANILLA_NO_SIBLING_SPOUSE_COORDS.mother,
  );
  assert.deepEqual(nodeById(tree, 'center').parents?.map(nodeId).sort(), ['father', 'mother']);
  assert.equal(nodeById(tree, 'brother').parents?.[0], nodeById(tree, 'father'));
  assert.equal(nodeById(tree, 'brother').parents?.[1], nodeById(tree, 'mother'));
});

test('f3.calculateTree includes spouses of siblings with links and no overlaps (vertical)', () => {
  const people = familyWithSiblingSpousesAndCenterBranches();
  const peopleSnapshot = structuredClone(people);
  const { tree, chartData } = calculate(people, 'center');
  const chartSnapshot = structuredClone(chartData);

  assertSpouseLink(tree, 'center', 'center-wife');
  assertSpouseLink(tree, 'brother-a', 'brother-a-wife');
  assertSpouseLink(tree, 'brother-b', 'brother-b-wife-1');
  assertSpouseLink(tree, 'brother-b', 'brother-b-wife-2');
  assertSpouseLink(tree, 'sister', 'sister-husband');
  assert.equal(nodeById(tree, 'brother-b').spouses.length, 2);

  assert.ok(nodeById(tree, 'father'));
  assert.ok(nodeById(tree, 'mother'));
  assert.ok(nodeById(tree, 'shared-child'));
  assert.equal(nodeById(tree, 'shared-child').parent, nodeById(tree, 'center'));
  assert.deepEqual(nodeById(tree, 'center').parents?.map(nodeId).sort(), ['father', 'mother']);

  assertNoDuplicateIds(tree);
  assertNoDuplicateCoordinates(tree);
  assertNoOverlapsOnGeneration(tree, 0, false);
  assert.deepEqual(people, peopleSnapshot);
  assert.deepEqual(chartData, chartSnapshot);
});

test('f3.calculateTree sibling spouses work in horizontal orientation', () => {
  const { tree } = calculate(familyWithSiblingSpousesAndCenterBranches(), 'center', {
    isHorizontal: true,
  });
  assertSpouseLink(tree, 'brother-a', 'brother-a-wife');
  assertSpouseLink(tree, 'brother-b', 'brother-b-wife-1');
  assertSpouseLink(tree, 'brother-b', 'brother-b-wife-2');
  assertSpouseLink(tree, 'sister', 'sister-husband');
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
  assertNoDuplicateIds(tree);
  assertNoDuplicateCoordinates(tree);
  assertNoOverlapsOnGeneration(tree, generation, true);
});

test('center spouse branches still graft after patched calculateTree', () => {
  const { tree, chartData } = calculate(familyWithSiblingSpousesAndCenterBranches(), 'center');
  const center = nodeById(tree, 'center');
  const father = nodeById(tree, 'father');
  const mother = nodeById(tree, 'mother');
  const sharedChild = nodeById(tree, 'shared-child');
  const centerParents = center.parents;
  const centerChildren = center.children;

  applyCenterSpouseBranches(tree, chartData, 'center');

  assert.equal(center.parents, centerParents);
  assert.equal(center.children, centerChildren);
  assert.equal(center.parents[0], father);
  assert.equal(center.parents[1], mother);
  assert.equal(sharedChild.parent, center);

  const wife = nodeById(tree, 'center-wife');
  const wifeFather = nodeById(tree, 'wife-father');
  const wifeMother = nodeById(tree, 'wife-mother');
  const wifeOnlyChild = nodeById(tree, 'wife-only-child');
  assert.ok(wifeFather);
  assert.ok(wifeMother);
  assert.ok(wifeOnlyChild);
  assert.ok(wife.parents?.includes(wifeFather));
  assert.ok(wife.parents?.includes(wifeMother));
  assert.equal(wifeFather.parent, wife);
  assert.equal(wifeMother.parent, wife);
  assert.ok(wife.children?.includes(wifeOnlyChild));
  assert.equal(wifeOnlyChild.parent, wife);

  assertSpouseLink(tree, 'brother-a', 'brother-a-wife');
  assertNoDuplicateIds(tree);
  // Main-generation spacing is owned by the FC patch; ancestry collisions from the
  // pre-existing center-spouse graft helper are outside this patch's scope.
  assertNoOverlapsOnGeneration(tree, 0, false);
});

test('100 center switches and repeated calculateTree keep sibling spouses without duplicates', () => {
  const people = familyWithSiblingSpousesAndCenterBranches();
  const chartData = prepareFamilyChartData(people);
  const centers = ['center', 'brother-a', 'brother-b', 'sister'];
  const chartSnapshot = structuredClone(chartData);

  for (let i = 0; i < 100; i += 1) {
    const mainId = centers[i % centers.length];
    const isHorizontal = i % 2 === 1;
    const tree = f3.calculateTree(
      structuredClone(chartData),
      treeOptions(mainId, { isHorizontal }),
    );
    assertNoDuplicateIds(tree);
    assertNoDuplicateCoordinates(tree);
    const mainGeneration = nodePosition(nodeById(tree, mainId), isHorizontal).generation;
    assertNoOverlapsOnGeneration(tree, mainGeneration, isHorizontal);

    const siblings = tree.data.filter((node) => node.sibling);
    for (const sibling of siblings) {
      const person = chartData.find((item) => item.id === nodeId(sibling));
      for (const spouseId of person?.rels.spouses || []) {
        assertSpouseLink(tree, nodeId(sibling), spouseId);
      }
    }

    applyCenterSpouseBranches(tree, chartData, mainId, { isHorizontal });
    assertNoDuplicateIds(tree);
    const mainPerson = chartData.find((item) => item.id === mainId);
    for (const spouseId of mainPerson?.rels.spouses || []) {
      if (nodeById(tree, spouseId)) assertSpouseLink(tree, mainId, spouseId);
    }
    assertNoOverlapsOnGeneration(
      tree,
      nodePosition(nodeById(tree, mainId), isHorizontal).generation,
      isHorizontal,
    );
  }

  assert.deepEqual(chartData, chartSnapshot);
  assert.deepEqual(people, familyWithSiblingSpousesAndCenterBranches());
});

test('patch-package marker: sibling spouse attach helpers exist in loaded family-chart', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const esmPath = path.join(
    path.dirname(fileURLToPath(import.meta.resolve('family-chart'))),
    'family-chart.esm.js',
  );
  // import.meta.resolve may point at package root export; fall back to node_modules path.
  const candidates = [esmPath, path.resolve('node_modules/family-chart/dist/family-chart.esm.js')];
  const source = candidates
    .map((file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    })
    .find((text) => text.includes('setupSiblings'));
  assert.ok(source, 'family-chart.esm.js not found');
  assert.match(source, /attachSpousesToPerson/);
  assert.match(source, /pendingSpouseIds/);
  assert.match(source, /Reserve household width from pending spouse counts/);
});
