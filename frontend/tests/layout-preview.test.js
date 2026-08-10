import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrototypeFamilyTreeChart } from '../src/adapters/prototype-layout-adapter.js';
import {
  LAYOUT_MODE_FAMILY_CHART,
  LAYOUT_MODE_LEGACY,
  LAYOUT_MODE_PROTOTYPE,
  isPrototypeLayoutMode,
  resolveLayoutMode,
} from '../src/layout/layout-mode.js';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  findCardOverlaps,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
} from '../src/layout/layout-validators.js';
import { assertNoPiiInFixture, loadStructuralPeople } from '../src/layout/structural-fixture.js';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/structural-tree.topology.json',
);

async function loadFixturePeople() {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assertNoPiiInFixture(fixture);
  return { fixture, people: loadStructuralPeople(fixture) };
}

class FakeClassList {
  constructor(...names) {
    this.names = new Set(names);
  }
  add(name) {
    this.names.add(name);
  }
  remove(name) {
    this.names.delete(name);
  }
  toggle(name, force) {
    const enabled = force ?? !this.names.has(name);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }
  contains(name) {
    return this.names.has(name);
  }
}

function createPreviewDom() {
  const listeners = new Map();
  const links = {
    _html: '',
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
  };
  const cards = {
    _html: '',
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
  };
  const viewport = {
    style: {},
    querySelector(selector) {
      if (selector === '[data-prototype-links]') return links;
      if (selector === '[data-prototype-cards]') return cards;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const host = {
    classList: new FakeClassList('f3', 'chart-surface'),
    dataset: {},
    style: {},
    clientWidth: 900,
    clientHeight: 700,
    _html: '',
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 900, height: 700 };
    },
    contains() {
      return true;
    },
    querySelector(selector) {
      if (selector === '[data-prototype-viewport]') return viewport;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    setPointerCapture() {},
  };
  const searchHost = {
    _html: '',
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
    querySelector() {
      return null;
    },
    contains() {
      return false;
    },
  };
  const docListeners = new Map();
  const documentStub = {
    querySelector(selector) {
      if (selector === '#FamilyChart') return host;
      if (selector === '#search-host') return searchHost;
      return null;
    },
    addEventListener(type, handler, options) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add({ handler, options });
    },
    removeEventListener(type, handler) {
      const bucket = docListeners.get(type);
      if (!bucket) return;
      for (const entry of [...bucket]) {
        if (entry.handler === handler) bucket.delete(entry);
      }
    },
  };
  return { host, searchHost, viewport, links, cards, documentStub, listeners };
}

test('1. resolveLayoutMode defaults to prototype without query parameter', () => {
  assert.equal(resolveLayoutMode(''), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('?foo=1'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('?layout=family-chart'), LAYOUT_MODE_FAMILY_CHART);
  assert.equal(resolveLayoutMode(`?layout=${LAYOUT_MODE_LEGACY}`), LAYOUT_MODE_FAMILY_CHART);
  assert.equal(resolveLayoutMode('?layout=xxx'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(isPrototypeLayoutMode(''), true);
});

test('2. ?layout=prototype enables prototype renderer mode', () => {
  assert.equal(resolveLayoutMode('?layout=prototype'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('layout=prototype'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('?x=1&layout=prototype&y=2'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(isPrototypeLayoutMode('?layout=prototype'), true);
});

test('factory wiring keeps both prototype default and legacy Family Chart fallback', async () => {
  const [factory, main] = await Promise.all([
    source('src/adapters/create-tree-chart.js'),
    source('src/main.js'),
  ]);
  assert.match(factory, /LAYOUT_MODE_PROTOTYPE/);
  assert.match(factory, /new PrototypeFamilyTreeChart/);
  assert.match(factory, /new FamilyTreeChart/);
  assert.match(factory, /mode === LAYOUT_MODE_PROTOTYPE/);
  assert.match(main, /createTreeChart\('#FamilyChart'/);
  assert.match(main, /resolveLayoutMode\(/);
  assert.doesNotMatch(main, /new FamilyTreeChart\(/);
  assert.doesNotMatch(main, /new PrototypeFamilyTreeChart\(/);
});

test('8. reload with query parameter keeps prototype mode', () => {
  // Same search string after reload must keep prototype mode.
  assert.equal(resolveLayoutMode('?layout=prototype'), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('?layout=prototype'), LAYOUT_MODE_PROTOTYPE);
});

test('9. without query parameter behavior stays on prototype path', async () => {
  assert.equal(resolveLayoutMode(''), LAYOUT_MODE_PROTOTYPE);
  assert.equal(resolveLayoutMode('?draft=1'), LAYOUT_MODE_PROTOTYPE);
  const main = await source('src/main.js');
  assert.match(main, /createTreeChart\('#FamilyChart',\s*\{\s*layoutMode\s*\}\)/);
  assert.match(main, /const layoutMode = resolveLayoutMode\(\)/);
});

test('3. prototype center change recomputes layout', async () => {
  const { people, fixture } = await loadFixturePeople();
  const { documentStub, host, cards } = createPreviewDom();
  const originalDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    const chart = new PrototypeFamilyTreeChart('#FamilyChart');
    chart.mount(people, {
      rootPersonId: fixture.meta.defaultCenterId || 'p010',
      onSelect: () => {},
      onRootSelect: () => {},
      onKinshipClick: () => {},
    });
    const firstLayout = chart.getLayout();
    assert.ok(firstLayout?.nodes?.length > 0);
    assert.ok(String(cards.innerHTML).includes('data-person-id'));
    assert.equal(host.dataset.layoutEngine, 'prototype');

    const firstCenter = chart.rootPersonId;
    const alternate = people.find((person) => person.id !== firstCenter)?.id;
    assert.ok(alternate);
    const firstSignature = firstLayout.nodes
      .map((node) => `${node.id}:${node.x},${node.y}`)
      .join('|');
    assert.equal(chart.setRootPerson(alternate, { fit: true }), true);
    assert.equal(chart.rootPersonId, alternate);
    const secondLayout = chart.getLayout();
    assert.notEqual(secondLayout, firstLayout);
    const secondSignature = secondLayout.nodes
      .map((node) => `${node.id}:${node.x},${node.y}`)
      .join('|');
    assert.notEqual(secondSignature, firstSignature);
    chart.destroy();
  } finally {
    globalThis.document = originalDocument;
  }
});

test('4. card selection calls existing onSelect path', async () => {
  const { people, fixture } = await loadFixturePeople();
  const { documentStub } = createPreviewDom();
  const originalDocument = globalThis.document;
  globalThis.document = documentStub;
  const selected = [];
  try {
    const chart = new PrototypeFamilyTreeChart('#FamilyChart');
    chart.mount(people, {
      rootPersonId: fixture.meta.defaultCenterId || 'p010',
      onSelect: (id) => selected.push(id),
    });
    const targetId = chart.getLayout().nodes[0]?.id;
    assert.ok(targetId);
    chart.select(targetId);
    assert.deepEqual(selected, [targetId]);
    chart.destroy();
  } finally {
    globalThis.document = originalDocument;
  }
});

test('5. prototype does not mutate source tree', async () => {
  const { people } = await loadFixturePeople();
  const before = structuredClone(people);
  const layout = layoutFamilyTree(people, { centerId: people[0].id });
  assert.ok(layout.nodes.length > 0);
  assert.deepEqual(people, before);

  const { documentStub } = createPreviewDom();
  const originalDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    const chart = new PrototypeFamilyTreeChart('#FamilyChart');
    const sourcePeople = structuredClone(people);
    chart.mount(sourcePeople, {
      rootPersonId: people[0].id,
      onSelect: () => {},
    });
    chart.setRootPerson(people[1]?.id || people[0].id, { fit: true });
    chart.updateData(sourcePeople, { fit: true, rootPersonId: people[0].id });
    assert.deepEqual(sourcePeople, before);
    assert.deepEqual(people, before);
    const exported = chart.getData();
    assert.equal(JSON.stringify(exported).includes('"x":'), false);
    assert.equal(JSON.stringify(exported).includes('householdId'), false);
    chart.destroy();
  } finally {
    globalThis.document = originalDocument;
  }
});

test('6-7. production fixture: no overlaps and no missing visible spouse/parent-child links', async () => {
  const { people } = await loadFixturePeople();
  for (const person of people) {
    const layout = layoutFamilyTree(people, { centerId: person.id });
    assert.equal(findCardOverlaps(layout.nodes).length, 0, `${person.id} overlaps`);
    assert.equal(
      findMissingVisibleParentChildLinks(people, layout).length,
      0,
      `${person.id} missing parent-child`,
    );
    assert.equal(
      findMissingVisibleSpouseLinks(people, layout).length,
      0,
      `${person.id} missing spouse`,
    );
  }
});

test('prototype adapter reuses Family Archive cards with standard gender shell classes', async () => {
  const [adapter, css] = await Promise.all([
    source('src/adapters/prototype-layout-adapter.js'),
    source('src/styles.css'),
  ]);
  assert.match(adapter, /createFamilyChartCardHtml/);
  assert.match(adapter, /layoutFamilyTree/);
  assert.match(adapter, /cloneTree\(this\.data\)/);
  assert.match(adapter, /Display-only/);
  assert.match(adapter, /card-male/);
  assert.match(adapter, /card-female/);
  assert.match(adapter, /card-genderless/);
  assert.match(adapter, /card-main/);
  assert.match(css, /--male-color:\s*rgb\(120,\s*159,\s*172\)/);
  assert.match(css, /--female-color:\s*rgb\(196,\s*138,\s*146\)/);
  assert.match(css, /\.card-male \.card-inner/);
  // Layout engine stays ours — no family-chart JS/CSS module import.
  assert.doesNotMatch(adapter, /from ['"]family-chart['"]|family-chart\/styles/);
  assert.doesNotMatch(adapter, /saveTree|trees\.data\s*=/);
});
