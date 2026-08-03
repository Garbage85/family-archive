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
