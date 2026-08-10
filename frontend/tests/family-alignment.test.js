import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildParentChildFamilies,
  measureFamilyAlignment,
  packHouseholdStarts,
  tightPackStarts,
} from '../src/layout/family-alignment.js';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  coldWarmSignatureMismatch,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function person(id, { parents = [], spouses = [], children = [], gender = 'M' } = {}) {
  return {
    id,
    data: { gender },
    rels: { parents, spouses, children },
  };
}

function hardAlignmentGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(layout.meta.familySideViolations ?? 0, 0, `${label} familySide`);
  assert.equal(layout.meta.branchIntegrityViolations ?? 0, 0, `${label} branch`);
  assert.equal(
    layout.meta.childrenBlockInterleavingViolations ?? 0,
    0,
    `${label} childrenInterleave`,
  );
  assert.equal(layout.meta.familyBusLocalityViolations ?? 0, 0, `${label} busLocal`);
  assert.equal(layout.meta.parallelGapViolations ?? 0, 0, `${label} parallelGap`);
  assert.equal(layout.meta.laneConflicts ?? 0, 0, `${label} laneConflicts`);
  assert.equal(layout.meta.hardViolations ?? 0, 0, `${label} hard`);
  const metrics = collectPlacementMetrics(people, layout, {
    expectedVisibleIds: layout.nodes.map((node) => node.id),
    households: layout.households,
    spouseSide: layout.meta.spouseSide,
  });
  assert.equal(metrics.hardViolations, 0, `${label} metrics.hard`);
  assert.equal(metrics.childrenBlockInterleavingViolations, 0, `${label} metrics.interleave`);
  assert.equal(metrics.linksThroughCards, 0, `${label} metrics.through`);
  assert.equal(metrics.falseJunctions, 0, `${label} metrics.falseJ`);
  return metrics;
}

test('packHouseholdStarts: pinned core stays tight; unpinned end-anchors', () => {
  const households = [
    { id: 'h1', side: 'center', memberIds: ['a'], size: 1 },
    { id: 'h2', side: 'core', memberIds: ['c', 's'], size: 2 },
    { id: 'h3', side: 'center', memberIds: ['b'], size: 1 },
  ];
  const widths = [184, 420, 184];
  const tight = tightPackStarts(households, {
    widths,
    gap: 52,
    pinCenterId: 'c',
    memberOrders: [['a'], ['s', 'c'], ['b']],
    cardCross: 184,
  });
  // center person c is second member → at x=0
  assert.equal(tight[1] + 184 + 52 + 92, 0);

  const pinned = packHouseholdStarts(households, {
    preferred: [-800, 0, 800],
    widths,
    gap: 52,
    pinCenterId: 'c',
    memberOrders: [['a'], ['s', 'c'], ['b']],
    cardCross: 184,
  });
  // Preferences must not open gaps beside the core.
  assert.deepEqual(pinned, tight);
});

test('stress: one parent pair + one child aligns under junction', () => {
  const people = [
    person('a', { spouses: ['b'], children: ['c'] }),
    person('b', { spouses: ['a'], children: ['c'], gender: 'F' }),
    person('c', { parents: ['a', 'b'] }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'c' });
  const metrics = hardAlignmentGate(people, layout, 'one-child');
  assert.equal(metrics.maxFamilyAlignmentError, 0);
  assert.equal(metrics.singleChildHorizontalOffset, 0);
  assert.equal(metrics.localBusLengthByFamily['fam:a+b'], 0);
});

test('stress: parent pair + 3 children centers sibling block', () => {
  const people = [
    person('a', { spouses: ['b'], children: ['c1', 'c2', 'c3'] }),
    person('b', { spouses: ['a'], children: ['c1', 'c2', 'c3'], gender: 'F' }),
    person('c1', { parents: ['a', 'b'] }),
    person('c2', { parents: ['a', 'b'] }),
    person('c3', { parents: ['a', 'b'] }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'c2' });
  const metrics = hardAlignmentGate(people, layout, 'three-children');
  assert.equal(metrics.maxFamilyAlignmentError, 0);
  const fam = metrics.familyAlignmentReport.find((row) => row.familyKey === 'fam:a+b');
  assert.ok(fam);
  assert.equal(fam.childCount, 3);
  assert.equal(fam.alignmentError, 0);
});

test('stress: child household with spouse uses whole-household center', () => {
  const people = [
    person('a', { spouses: ['b'], children: ['c'] }),
    person('b', { spouses: ['a'], children: ['c'], gender: 'F' }),
    person('c', { parents: ['a', 'b'], spouses: ['d'] }),
    person('d', { spouses: ['c'], gender: 'F' }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'c' });
  const metrics = hardAlignmentGate(people, layout, 'child-spouse');
  assert.equal(metrics.maxFamilyAlignmentError, 0);
  const fam = metrics.familyAlignmentReport.find((row) => row.familyKey === 'fam:a+b');
  assert.equal(fam.alignmentError, 0);
  // Bus covers the child household width, not an elbow away from parents.
  assert.ok(fam.busLength <= 236 + 1e-6);
});

test('stress: two nearby parent families compete without hard violations', () => {
  const people = [
    person('p1', { spouses: ['p2'], children: ['c1'] }),
    person('p2', { spouses: ['p1'], children: ['c1'], gender: 'F' }),
    person('p3', { spouses: ['p4'], children: ['c2'] }),
    person('p4', { spouses: ['p3'], children: ['c2'], gender: 'F' }),
    person('c1', { parents: ['p1', 'p2'], spouses: ['c2'] }),
    person('c2', { parents: ['p3', 'p4'], spouses: ['c1'], gender: 'F' }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'c1' });
  hardAlignmentGate(people, layout, 'two-families');
});

test('stress: half-sibling has one node and soft compromise', () => {
  const people = [
    person('m', { spouses: ['f1', 'f2'], children: ['h1', 'h2'], gender: 'M' }),
    person('f1', { spouses: ['m'], children: ['h1'], gender: 'F' }),
    person('f2', { spouses: ['m'], children: ['h2'], gender: 'F' }),
    person('h1', { parents: ['m', 'f1'] }),
    person('h2', { parents: ['m', 'f2'] }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'm' });
  const metrics = hardAlignmentGate(people, layout, 'half-sibling');
  const ids = layout.nodes.map((node) => node.id);
  assert.equal(ids.filter((id) => id === 'h1').length, 1);
  assert.equal(ids.filter((id) => id === 'h2').length, 1);
  const families = buildParentChildFamilies(people, ids);
  assert.equal(families.length, 2);
  assert.ok(metrics.familyAlignmentErrorTotal >= 0);
});

test('stress: multiple spouse child groups stay separate blocks', () => {
  const people = [
    person('m', { spouses: ['f1', 'f2'], children: ['a', 'b', 'c', 'd'] }),
    person('f1', { spouses: ['m'], children: ['a', 'b'], gender: 'F' }),
    person('f2', { spouses: ['m'], children: ['c', 'd'], gender: 'F' }),
    person('a', { parents: ['m', 'f1'] }),
    person('b', { parents: ['m', 'f1'] }),
    person('c', { parents: ['m', 'f2'] }),
    person('d', { parents: ['m', 'f2'] }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'm' });
  const metrics = hardAlignmentGate(people, layout, 'multi-spouse-groups');
  const keys = Object.keys(metrics.childBlockCenterByFamily).sort();
  assert.deepEqual(keys, ['fam:f1+m', 'fam:f2+m']);
});

test('stress: three generations cascade alignment', () => {
  const people = [
    person('gp1', { spouses: ['gp2'], children: ['p1'] }),
    person('gp2', { spouses: ['gp1'], children: ['p1'], gender: 'F' }),
    person('p1', { parents: ['gp1', 'gp2'], spouses: ['p2'], children: ['k1'] }),
    person('p2', { spouses: ['p1'], children: ['k1'], gender: 'F' }),
    person('k1', { parents: ['p1', 'p2'] }),
  ];
  const layout = layoutFamilyTree(people, { centerId: 'p1' });
  const metrics = hardAlignmentGate(people, layout, 'three-gen');
  assert.ok(metrics.maxFamilyAlignmentError <= 1e-6);
});

test('stress: dense sibling / collateral branches keep hard gates', () => {
  const children = ['s1', 's2', 's3', 's4', 's5'];
  const people = [
    person('f', { spouses: ['m'], children }),
    person('m', { spouses: ['f'], children, gender: 'F' }),
    ...children.map((id) => person(id, { parents: ['f', 'm'] })),
    person('u1', { spouses: ['u2'], children: ['f'] }),
    person('u2', { spouses: ['u1'], children: ['f'], gender: 'F' }),
  ];
  // Attach aunt/uncle via grandparents of center s3.
  people.push(
    person('gp1', { spouses: ['gp2'], children: ['f', 'uncle'] }),
    person('gp2', { spouses: ['gp1'], children: ['f', 'uncle'], gender: 'F' }),
    person('uncle', { parents: ['gp1', 'gp2'], spouses: ['aunt'] }),
    person('aunt', { spouses: ['uncle'], gender: 'F' }),
  );
  const layout = layoutFamilyTree(people, { centerId: 's3' });
  hardAlignmentGate(people, layout, 'dense-collateral');
});

test('PRODUCTION p010: family alignment BEFORE→AFTER report', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010', returnCandidates: true });
  const metrics = hardAlignmentGate(people, layout, 'p010');

  const families = (metrics.familyAlignmentReport || []).map((row) => ({
    familyKey: row.familyKey,
    parentMidpoint: row.familyTargetCross,
    childBlockCenter: row.childBlockCenter,
    alignmentError: row.alignmentError,
    childCount: row.childCount,
    busLength: row.busLength,
    horizontalOffset: row.singleChildHorizontalOffset,
  }));

  // Structural dense archive: keep hard gates and avoid alignment regression
  // above the pre-alignment baseline envelope (~1062 unweighted / max 236).
  assert.ok(metrics.maxFamilyAlignmentError <= 236 + 1e-6, 'max alignment not worse than baseline');
  assert.ok(metrics.familyAlignmentErrorTotal < 800, 'weighted alignment stays bounded');
  assert.ok(metrics.foreignHouseholdsUnderBus <= 1, 'foreign under bus');

  const report = {
    centerId: 'p010',
    before: {
      note: 'independent generation centering; edge single-child elbows ~236',
      familyAlignmentErrorTotal: 1062,
      maxFamilyAlignmentError: 236,
      singleChildAlignmentError: 472,
      routeLength: 5498,
      foreignHouseholdsUnderBus: 1,
      maxBusLength: 708,
      bends: 2,
    },
    after: {
      familyAlignmentErrorTotal: metrics.familyAlignmentErrorTotal,
      maxFamilyAlignmentError: metrics.maxFamilyAlignmentError,
      singleChildAlignmentError: metrics.singleChildAlignmentError,
      singleChildHorizontalOffset: metrics.singleChildHorizontalOffset,
      routeLength: metrics.routeLength,
      bends: metrics.bends,
      foreignHouseholdsUnderBus: metrics.foreignHouseholdsUnderBus,
      maxBusLength: metrics.maxBusLength,
      hardViolations: metrics.hardViolations,
      spouseSide: layout.meta.spouseSide,
      families,
      familyTargetByFamily: metrics.familyTargetByFamily,
      childBlockCenterByFamily: metrics.childBlockCenterByFamily,
      localBusLengthByFamily: metrics.localBusLengthByFamily,
    },
  };
  console.log('\nFAMILY ALIGNMENT BEFORE→AFTER (p010)\n', JSON.stringify(report, null, 2));
});

test('all production centers: alignment hard gates', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const rows = [];
  for (const person of fixture.people) {
    const layout = layoutFamilyTree(people, { centerId: person.id });
    const metrics = hardAlignmentGate(people, layout, person.id);
    rows.push({
      centerId: person.id,
      align: Math.round(metrics.familyAlignmentErrorTotal),
      maxAlign: Math.round(metrics.maxFamilyAlignmentError),
      singleOff: Math.round(metrics.singleChildHorizontalOffset),
      route: Math.round(metrics.routeLength),
      foreign: metrics.foreignHouseholdsUnderBus,
      hard: metrics.hardViolations,
    });
  }
  console.log('\nALL-CENTERS ALIGNMENT GATE\n', JSON.stringify(rows, null, 2));
});

test('determinism: alignment geometry stable cold/warm/20x', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const cold = layoutFamilyTree(people, { centerId: 'p010' });
  const warm = layoutFamilyTree(people, { centerId: 'p010', previousLayout: cold });
  assert.equal(coldWarmSignatureMismatch(cold, warm), 0);
  const coldAlign = measureFamilyAlignment(cold, { people, centerId: 'p010' });
  const warmAlign = measureFamilyAlignment(warm, { people, centerId: 'p010' });
  assert.deepEqual(coldAlign.familyTargetByFamily, warmAlign.familyTargetByFamily);
  assert.deepEqual(coldAlign.childBlockCenterByFamily, warmAlign.childBlockCenterByFamily);
  const sig = layoutRouteSignature(cold);
  for (let i = 0; i < 20; i += 1) {
    const again = layoutFamilyTree(people, { centerId: 'p010' });
    assert.equal(layoutRouteSignature(again), sig, `repeat ${i}`);
    const againAlign = measureFamilyAlignment(again, { people, centerId: 'p010' });
    assert.deepEqual(againAlign.childBlockCenterByFamily, coldAlign.childBlockCenterByFamily);
  }
});

test('performance sanity: production + dense synthetic stay bounded', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);

  const prodOnce = layoutFamilyTree(people, { centerId: 'p010', returnCandidates: true });
  const t0 = Date.now();
  for (let i = 0; i < 25; i += 1) layoutFamilyTree(people, { centerId: 'p010' });
  const productionMs = Date.now() - t0;

  const kids = Array.from({ length: 12 }, (_, index) => `k${index}`);
  const dense = [
    person('f', { spouses: ['m'], children: kids }),
    person('m', { spouses: ['f'], children: kids, gender: 'F' }),
    ...kids.map((id) => person(id, { parents: ['f', 'm'] })),
  ];
  const denseOnce = layoutFamilyTree(dense, { centerId: 'k0', returnCandidates: true });
  const t1 = Date.now();
  for (let i = 0; i < 25; i += 1) layoutFamilyTree(dense, { centerId: 'k0' });
  const denseMs = Date.now() - t1;

  // Keep the historical 5000ms ceiling; require ~20% headroom on dense 25x.
  assert.ok(productionMs < 5000, `production 25x too slow: ${productionMs}ms`);
  assert.ok(denseMs < 5000, `dense 25x too slow: ${denseMs}ms`);
  assert.ok(denseMs < 4000, `dense 25x lacks 20% headroom: ${denseMs}ms`);
  assert.equal(denseOnce.meta.hardViolations, 0);
  assert.equal(prodOnce.meta.hardViolations, 0);

  console.log(
    '\nALIGNMENT PERF\n',
    JSON.stringify(
      {
        productionMs,
        denseMs,
        dense1xCandidateCount: denseOnce.meta.candidateCount,
        dense1xFullRoutingEvaluations: denseOnce.meta.fullRoutingEvaluations,
        production1xCandidateCount: prodOnce.meta.candidateCount,
        production1xFullRoutingEvaluations: prodOnce.meta.fullRoutingEvaluations,
        productionAlign: Math.round(prodOnce.meta.familyAlignmentErrorTotal || 0),
      },
      null,
      2,
    ),
  );
});
