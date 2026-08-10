import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrototypeFamilyTreeChart } from '../src/adapters/prototype-layout-adapter.js';
import {
  MOBILE_MIN_READABLE_SCALE,
  MIN_SCALE,
  MAX_SCALE,
  computeFitAllView,
  computeCenterFocusView,
  panBy,
  readableInitialScale,
  wheelZoomFactor,
  zoomAtPoint,
} from '../src/layout/prototype-viewport.js';
import { assertNoPiiInFixture, loadStructuralPeople } from '../src/layout/structural-fixture.js';

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

function createPreviewDom({ width = 390, height = 700 } = {}) {
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
    clientWidth: width,
    clientHeight: height,
    _html: '',
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height };
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
    addEventListener() {},
    removeEventListener() {},
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
  const documentStub = {
    querySelector(selector) {
      if (selector === '#FamilyChart') return host;
      if (selector === '#search-host') return searchHost;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return { host, viewport, documentStub };
}

test('mobile initial scale is not below mobile readable minimum', () => {
  const mobileWidth = 390;
  const scale = readableInitialScale(mobileWidth);
  assert.ok(scale >= MOBILE_MIN_READABLE_SCALE);
  assert.ok(scale <= MAX_SCALE);

  const view = computeCenterFocusView({
    hostWidth: mobileWidth,
    hostHeight: 700,
    focusX: 0,
    focusY: 0,
    scale,
  });
  assert.ok(view.scale >= MOBILE_MIN_READABLE_SCALE);
});

test('fit-all can shrink scale below readable floor down to MIN_SCALE', () => {
  const nodes = [
    { id: 'a', x: -2000, y: -2000, width: 184, height: 170 },
    { id: 'b', x: 2000, y: 2000, width: 184, height: 170 },
  ];
  const fit = computeFitAllView({
    hostWidth: 390,
    hostHeight: 700,
    nodes,
  });
  assert.ok(fit.scale < MOBILE_MIN_READABLE_SCALE);
  assert.ok(fit.scale >= MIN_SCALE);
});

test('pan changes viewport translate', () => {
  const next = panBy({ scale: 1, translateX: 10, translateY: 20 }, { dx: 40, dy: -15 });
  assert.equal(next.scale, 1);
  assert.equal(next.translateX, 50);
  assert.equal(next.translateY, 5);
});

test('pinch/zoomAt increases and decreases scale within bounds', () => {
  const start = { scale: 1, translateX: 100, translateY: 80 };
  const zoomedIn = zoomAtPoint(start, { hostX: 200, hostY: 160, factor: 1.25 });
  assert.ok(zoomedIn.scale > start.scale);
  const zoomedOut = zoomAtPoint(zoomedIn, { hostX: 200, hostY: 160, factor: 0.5 });
  assert.ok(zoomedOut.scale < zoomedIn.scale);
  const clamped = zoomAtPoint(
    { scale: MAX_SCALE, translateX: 0, translateY: 0 },
    { hostX: 10, hostY: 10, factor: 2 },
  );
  assert.equal(clamped.scale, MAX_SCALE);
});

test('wheel zoom factor zooms in on negative deltaY', () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
});

test('prototype mount uses readable scale; fit shrinks; center change stays readable', async () => {
  const { people, fixture } = await loadFixturePeople();
  const { documentStub, host, viewport } = createPreviewDom({ width: 390, height: 700 });
  const originalDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    const chart = new PrototypeFamilyTreeChart('#FamilyChart');
    chart.mount(people, {
      rootPersonId: fixture.meta.defaultCenterId || 'p010',
      onSelect: () => {},
    });
    const initial = chart.getViewport();
    assert.ok(
      initial.scale >= MOBILE_MIN_READABLE_SCALE,
      `initial scale ${initial.scale} < ${MOBILE_MIN_READABLE_SCALE}`,
    );
    assert.match(String(viewport.style.transform || ''), /scale\(/);

    const beforePan = chart.getViewport();
    chart.panViewport(30, -20);
    const afterPan = chart.getViewport();
    assert.equal(afterPan.translateX, beforePan.translateX + 30);
    assert.equal(afterPan.translateY, beforePan.translateY - 20);
    assert.equal(afterPan.scale, beforePan.scale);

    const beforeWheel = chart.getViewport();
    chart.zoomAt(host.clientWidth / 2, host.clientHeight / 2, wheelZoomFactor(-120));
    assert.ok(chart.getViewport().scale > beforeWheel.scale);

    const beforePinch = chart.getViewport();
    chart.pinchZoom(host.clientWidth / 2, host.clientHeight / 2, 1.2);
    assert.ok(chart.getViewport().scale > beforePinch.scale);
    chart.pinchZoom(host.clientWidth / 2, host.clientHeight / 2, 1 / 1.2);

    chart.fit();
    const fitted = chart.getViewport();
    assert.ok(fitted.scale <= initial.scale);
    assert.ok(fitted.scale >= MIN_SCALE);

    // Restore readable, then change center with fit:true from app — must not go microscopic.
    chart.resetView();
    const readable = chart.getViewport().scale;
    assert.ok(readable >= MOBILE_MIN_READABLE_SCALE);
    const alternate = people.find((person) => person.id !== chart.rootPersonId)?.id;
    assert.ok(alternate);
    chart.setRootPerson(alternate, { fit: true });
    const afterCenter = chart.getViewport();
    assert.ok(
      afterCenter.scale >= MOBILE_MIN_READABLE_SCALE,
      `center change scale ${afterCenter.scale} fell below readable floor`,
    );

    const before = structuredClone(people);
    chart.updateData(people, { fit: true, rootPersonId: chart.rootPersonId });
    assert.deepEqual(people, before);
    assert.equal(JSON.stringify(chart.getData()).includes('"x":'), false);
    chart.destroy();
  } finally {
    globalThis.document = originalDocument;
  }
});

test('main uses resetView for prototype instead of automatic fit-all after mount', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /typeof chart\.resetView === 'function'/);
  assert.match(main, /chart\.resetView\(\)/);
});
