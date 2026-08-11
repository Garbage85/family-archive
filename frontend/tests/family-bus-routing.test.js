import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  findCardOverlaps,
  findAmbiguousSharedSegments,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
} from '../src/layout/layout-validators.js';
import {
  findFalseJunctionsBetweenUnrelatedFamilies,
  findUnrelatedCrossingSites,
  MIN_BUS_CARD_GAP,
  routeLayoutLinks,
  uniqueRenderedJumpPoints,
  routingMetrics,
} from '../src/layout/link-routing.js';
import { MIN_PARALLEL_GAP } from '../src/layout/parallel-lanes.js';

const productionFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/production-routing.topology.json',
);

function routingPeople() {
  const people = new Map();
  const add = (id) =>
    people.set(id, { id, data: { gender: 'M' }, rels: { parents: [], spouses: [], children: [] } });
  const spouse = (left, right) => {
    people.get(left).rels.spouses.push(right);
    people.get(right).rels.spouses.push(left);
  };
  const child = (parentIds, childId) => {
    for (const parentId of parentIds) people.get(parentId).rels.children.push(childId);
    people.get(childId).rels.parents.push(...parentIds);
  };

  for (const id of [
    'p001',
    'p002',
    'p003',
    'p004',
    'p005',
    'p006',
    'p007',
    'p008',
    'p009',
    'p010',
    'p011',
    'p012',
    'p013',
    'p014',
    'p015',
    'p016',
    'p017',
    'p018',
    'p019',
  ])
    add(id);

  spouse('p001', 'p002');
  spouse('p003', 'p004');
  for (const [childId, spouseId] of [
    ['p005', 'p011'],
    ['p006', 'p012'],
    ['p007', 'p013'],
    ['p008', 'p014'],
    ['p009', 'p015'],
  ])
    spouse(childId, spouseId);
  spouse('p005', 'p008');

  child(['p001', 'p002'], 'p005');
  child(['p001', 'p002'], 'p006');
  child(['p001', 'p002'], 'p007');
  child(['p003', 'p004'], 'p008');
  child(['p003', 'p004'], 'p009');
  child(['p005', 'p008'], 'p010');
  child(['p006', 'p012'], 'p016');
  child(['p007', 'p013'], 'p017');
  child(['p009', 'p015'], 'p018');
  child(['p008', 'p014'], 'p019');
  return [...people.values()];
}

test('production-shaped independent parental buses remain deterministic after lane optimization', () => {
  const people = routingPeople();
  const layout = layoutFamilyTree(people, { centerId: 'p010', orientation: 'vertical' });
  assert.equal(findCardOverlaps(layout.nodes).length, 0);
  assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0);
  assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0);
  const repeat = layoutFamilyTree(people, { centerId: 'p010', orientation: 'vertical' });
  assert.deepEqual(
    layout.nodes.map(({ id, x, y }) => ({ id, x, y })),
    repeat.nodes.map(({ id, x, y }) => ({ id, x, y })),
  );
});

test('final bus routing separates overlapping independent horizontal segments', () => {
  const node = (id, x, y) => ({ id, x, y, width: 20, height: 20 });
  const layout = {
    nodes: [
      node('a-parent', 0, 0),
      node('a-child-1', 120, 300),
      node('a-child-2', 180, 300),
      node('b-parent', 60, 0),
      node('b-child', 180, 300),
      node('d-parent', 100, 0),
      node('d-child', 220, 300),
      node('c-parent', 400, 0),
      node('c-child', 520, 300),
    ],
    links: [
      { type: 'parent-child', source: 'a-parent', target: 'a-child-1' },
      { type: 'parent-child', source: 'a-parent', target: 'a-child-2' },
      { type: 'parent-child', source: 'b-parent', target: 'b-child' },
      { type: 'parent-child', source: 'd-parent', target: 'd-child' },
      { type: 'parent-child', source: 'c-parent', target: 'c-child' },
    ],
  };
  const routingPlan = {
    laneByFamilyKey: new Map([
      ['fam:a-parent', { axis: 285, laneIndex: 0 }],
      ['fam:b-parent', { axis: 285, laneIndex: 0 }],
      ['fam:d-parent', { axis: 285, laneIndex: 0 }],
      ['fam:c-parent', { axis: 150, laneIndex: 0 }],
    ]),
  };
  const links = routeLayoutLinks(layout, {
    orientation: 'vertical',
    routingPlan,
    optimizeStemAwareLanes: false,
  });
  const buses = new Map();
  for (const link of links) {
    for (let index = 0; index < link.points.length - 1; index += 1) {
      const [a, b] = [link.points[index], link.points[index + 1]];
      if (Math.abs(a[1] - b[1]) < 0.51 && Math.abs(a[0] - b[0]) > 0.51) {
        buses.set(link.familyKey, { y: a[1], x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
      }
    }
  }
  for (const left of ['fam:a-parent', 'fam:b-parent', 'fam:d-parent']) {
    for (const right of ['fam:a-parent', 'fam:b-parent', 'fam:d-parent']) {
      if (left >= right) continue;
      assert.ok(Math.abs(buses.get(left).y - buses.get(right).y) >= MIN_PARALLEL_GAP);
    }
  }
  for (const familyKey of ['fam:a-parent', 'fam:b-parent', 'fam:d-parent', 'fam:c-parent']) {
    assert.ok(290 - buses.get(familyKey).y >= MIN_BUS_CARD_GAP);
  }
  assert.equal(buses.get('fam:c-parent').y, 150);
  assert.equal(
    new Set(
      links
        .filter((link) => link.familyKey === 'fam:a-parent')
        .flatMap((link) =>
          link.points
            .slice(0, -1)
            .map((point, index) => [point, link.points[index + 1]])
            .filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.51 && Math.abs(a[0] - b[0]) > 0.51)
            .map(([a]) => a[1]),
        ),
    ).size,
    1,
  );
  assert.ok(Number.isFinite(buses.get('fam:c-parent').y));
});

test('anonymized production snapshot remains routing-safe after the fix', async () => {
  const fixture = JSON.parse(await readFile(productionFixturePath, 'utf8'));
  const layout = layoutFamilyTree(fixture.people, {
    centerId: fixture.centerId,
    orientation: 'vertical',
  });
  assert.equal(fixture.personCount, 20);
  assert.equal(layout.nodes.length, 18);
  const crossings = findUnrelatedCrossingSites(layout.links).filter(
    (site) =>
      site.horizontalLink?.type === 'parent-child' && site.verticalLink?.type === 'parent-child',
  );
  assert.ok(crossings.length <= 40);
  assert.ok(uniqueRenderedJumpPoints(layout.links).length <= 8);
  assert.ok((layout.meta.maxLaneCount || 0) <= 4);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0);
  assert.equal(routingMetrics(layout.links).totalParentChildLength, 9177.681);
  assert.equal(layout.meta.acceptedLocalOrderSwaps, 3);
  assert.equal(findCardOverlaps(layout.nodes).length, 0);
  assert.equal(findMissingVisibleParentChildLinks(fixture.people, layout).length, 0);
  assert.equal(findMissingVisibleSpouseLinks(fixture.people, layout).length, 0);
});

test('production routing lane optimization is deterministic for every connected center', async () => {
  const fixture = JSON.parse(await readFile(productionFixturePath, 'utf8'));
  const ids = fixture.people
    .filter((person) => person.id !== 'p008' && person.id !== 'p009')
    .map((person) => person.id)
    .sort();
  const snapshots = [];
  const phaseOneBaseline = {
    p001: [40, 8],
    p002: [28, 5],
    p003: [32, 5],
    p004: [44, 9],
    p005: [24, 6],
    p006: [24, 6],
    p007: [34, 7],
    p010: [16, 3],
    p011: [28, 4],
    p012: [16, 3],
    p013: [14, 4],
    p014: [14, 4],
    p015: [26, 5],
    p016: [28, 4],
    p017: [32, 8],
    p018: [26, 5],
    p019: [18, 5],
    p020: [16, 3],
  };
  for (const centerId of ids) {
    const layout = layoutFamilyTree(fixture.people, { centerId, orientation: 'vertical' });
    const crossings = findUnrelatedCrossingSites(layout.links).filter(
      (site) =>
        site.horizontalLink?.type === 'parent-child' && site.verticalLink?.type === 'parent-child',
    );
    snapshots.push({
      centerId,
      crossings: crossings.length,
      jumps: uniqueRenderedJumpPoints(layout.links).length,
      lanes: layout.meta.maxLaneCount,
      pathLength: routingMetrics(layout.links).totalParentChildLength,
      acceptedSwaps: layout.meta.acceptedLocalOrderSwaps || 0,
    });
    assert.equal(findCardOverlaps(layout.nodes).length, 0);
    assert.equal(findMissingVisibleParentChildLinks(fixture.people, layout).length, 0);
    assert.equal(findMissingVisibleSpouseLinks(fixture.people, layout).length, 0);
    assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0);
    assert.equal(findAmbiguousSharedSegments(layout).length, 0);
    const baseline = phaseOneBaseline[centerId];
    assert.ok(baseline, `missing baseline for ${centerId}`);
    assert.ok(crossings.length <= baseline[0]);
    assert.ok(uniqueRenderedJumpPoints(layout.links).length <= baseline[1]);
    assert.ok((layout.meta.acceptedLocalOrderSwaps || 0) <= ids.length);
    const repeat = layoutFamilyTree(fixture.people, { centerId, orientation: 'vertical' });
    assert.deepEqual(
      layout.nodes.map(({ id, x, y }) => ({ id, x, y })),
      repeat.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
  }
  assert.equal(snapshots.find((row) => row.centerId === 'p001').crossings, 20);
  assert.equal(snapshots.find((row) => row.centerId === 'p001').jumps, 4);
  assert.equal(snapshots.find((row) => row.centerId === 'p004').crossings, 16);
  assert.equal(snapshots.find((row) => row.centerId === 'p004').jumps, 3);
  assert.equal(snapshots.find((row) => row.centerId === 'p007').crossings, 14);
  assert.equal(snapshots.find((row) => row.centerId === 'p007').jumps, 4);
  assert.equal(snapshots.find((row) => row.centerId === 'p019').crossings, 18);
  assert.equal(snapshots.find((row) => row.centerId === 'p019').jumps, 5);
  assert.equal(snapshots.find((row) => row.centerId === 'p019').acceptedSwaps, 0);
  assert.ok(snapshots.every((row) => row.lanes <= 4));
});
