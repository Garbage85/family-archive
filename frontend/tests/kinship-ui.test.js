import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareFamilyChartData } from '../src/adapters/family-chart-data.js';
import { buildKinshipDialogModel } from '../src/kinship-dialog.js';
import { computeAllKinships } from '../src/kinship-engine.js';
import {
  CENTER_PERSON_STORAGE_KEY,
  KinshipCalculator,
  ensureCenterPersonId,
  persistCenterPersonId,
  readStoredCenterPersonId,
  resolveCenterPersonId,
  selectCenterPersonId,
} from '../src/kinship-state.js';
import { addRelative } from '../src/tree-utils.js';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

function person(id, gender = '', rels = {}) {
  return {
    id,
    data: { first_name: id, gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

test('saved center wins, missing saved center is ignored and deletion gets a fallback', () => {
  const people = [person('first'), person('saved'), person('selected')];
  assert.equal(
    resolveCenterPersonId(people, { savedCenterId: 'saved', currentPersonId: 'selected' }),
    'saved',
  );
  assert.equal(
    resolveCenterPersonId(people, { savedCenterId: 'missing', currentPersonId: 'selected' }),
    'selected',
  );
  const storage = new MemoryStorage({ [CENTER_PERSON_STORAGE_KEY]: 'deleted' });
  assert.equal(ensureCenterPersonId(people, 'deleted', { storage }), 'first');
  assert.equal(storage.getItem(CENTER_PERSON_STORAGE_KEY), 'first');
});

test('center state persists only an ID in localStorage', () => {
  const storage = new MemoryStorage();
  persistCenterPersonId('person-42', storage);
  assert.deepEqual([...storage.values], [[CENTER_PERSON_STORAGE_KEY, 'person-42']]);
  assert.equal(readStoredCenterPersonId(storage), 'person-42');
});

test('explicit make-center action validates and persists the new center', () => {
  const storage = new MemoryStorage();
  const people = [person('first'), person('new-center')];
  assert.equal(selectCenterPersonId(people, 'new-center', storage), 'new-center');
  assert.equal(storage.getItem(CENTER_PERSON_STORAGE_KEY), 'new-center');
  assert.equal(selectCenterPersonId(people, 'missing', storage), '');
  assert.equal(storage.getItem(CENTER_PERSON_STORAGE_KEY), 'new-center');
});

test('ordinary adapter selection is separate from explicit root rebuilding', async () => {
  const adapter = await source('src/adapters/family-chart-adapter.js');
  const selectBody = adapter.slice(adapter.indexOf('select(id)'), adapter.indexOf('getData()'));
  const rootBody = adapter.slice(
    adapter.indexOf('setRootPerson(personId'),
    adapter.indexOf('setKinships('),
  );
  assert.doesNotMatch(selectBody, /updateMainId|setRootPerson/);
  assert.match(rootBody, /this\.rootPersonId = nextId/);
  assert.match(rootBody, /updateMainId\(nextId\)\.updateTree/);
});

test('calculator memoizes by tree identity, revision and center', () => {
  const people = [person('center')];
  const calculator = new KinshipCalculator();
  const first = calculator.compute(people, 'center', 7);
  assert.equal(calculator.compute(people, 'center', 7), first);
  assert.notEqual(calculator.compute([...people], 'center', 7), first);
});

test('Family Chart compatibility data is reciprocal, cycle-safe and not persisted', () => {
  const people = [
    person('a', '', { parents: ['b', 'missing'] }),
    person('b', '', { parents: ['a'], children: ['a', 'a'] }),
    person('c', '', { children: ['a'] }),
  ];
  const before = structuredClone(people);
  const chartData = prepareFamilyChartData(people);
  const byId = new Map(chartData.map((item) => [item.id, item]));
  assert.deepEqual(people, before);
  assert.equal(byId.get('a').rels.parents.includes('missing'), false);
  assert.equal(byId.get('a').rels.parents.length, 2);
  assert.equal(byId.get('b').rels.parents.includes('a'), false);
  assert.deepEqual(byId.get('b').rels.children, ['a']);
  assert.equal(JSON.stringify(people).includes('kinship'), false);
});

test('dialog model exposes primary path while alternatives remain separate', () => {
  const people = [
    person('center', 'M', { parents: ['p1', 'p2'] }),
    person('target', 'F', { parents: ['q1', 'q2'] }),
    person('p1', '', { parents: ['a1'] }),
    person('q1', '', { parents: ['a1'] }),
    person('p2', '', { parents: ['a2'] }),
    person('q2', '', { parents: ['a2'] }),
    person('a1'),
    person('a2'),
  ];
  const relationship = computeAllKinships({ people, centerId: 'center' }).kinships.get('target');
  const model = buildKinshipDialogModel(people, relationship);
  assert.equal(model.label, 'двоюродная сестра');
  assert.equal(model.primaryPath.people[0].label, 'center');
  assert.equal(model.primaryPath.people.at(-1).label, 'target');
  assert.equal(model.alternativePaths.length, 1);
  assert.ok(model.primaryPath.steps.every((step) => !step.fromId.includes('missing')));
});

test('adding a relative recalculates labels without writing derived facts to tree data', () => {
  const original = [person('center', 'F')];
  const next = addRelative(original, 'center', 'child', { first_name: 'Сын', gender: 'M' });
  const relationship = computeAllKinships({ people: next.data, centerId: 'center' }).kinships.get(
    next.person.id,
  );
  assert.equal(relationship.label, 'сын');
  assert.equal(JSON.stringify(next.data).includes('Центр дерева'), false);
  assert.equal(JSON.stringify(next.data).includes('kinship'), false);
});

test('chart cards and mobile styles expose center, labels and overflow guards', async () => {
  const [adapter, css, dialog, ui] = await Promise.all([
    source('src/adapters/family-chart-adapter.js'),
    source('src/styles.css'),
    source('src/kinship-dialog.js'),
    source('src/ui.js'),
  ]);
  assert.match(adapter, /setRootPerson\(personId/);
  assert.match(adapter, /updateMainId\(nextId\)\.updateTree/);
  assert.match(adapter, /kinship-center-card-inner/);
  assert.match(adapter, /kinship-card-label/);
  assert.match(css, /\.kinship-card-label\s*\{[\s\S]*?-webkit-line-clamp: 2/);
  assert.match(css, /\.center-person-button\s*\{[\s\S]*?text-overflow: ellipsis/);
  assert.match(css, /\.kinship-dialog\s*\{[\s\S]*?max-height/);
  assert.match(dialog, /this\.alternatives\.classList\.add\('hidden'\)/);
  assert.match(ui, /Сделать|center-person-button/);
});
