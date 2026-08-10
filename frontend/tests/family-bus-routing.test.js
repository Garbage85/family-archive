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
  uniqueRenderedJumpPoints,
  routingMetrics,
} from '../src/layout/link-routing.js';

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
  assert.equal(routingMetrics(layout.links).totalParentChildLength, 14412.405);
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
    });
    assert.equal(findCardOverlaps(layout.nodes).length, 0);
    assert.equal(findMissingVisibleParentChildLinks(fixture.people, layout).length, 0);
    assert.equal(findMissingVisibleSpouseLinks(fixture.people, layout).length, 0);
    assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0);
    assert.equal(findAmbiguousSharedSegments(layout).length, 0);
    const repeat = layoutFamilyTree(fixture.people, { centerId, orientation: 'vertical' });
    assert.deepEqual(
      layout.nodes.map(({ id, x, y }) => ({ id, x, y })),
      repeat.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
  }
  assert.equal(snapshots.find((row) => row.centerId === 'p001').crossings, 40);
  assert.equal(snapshots.find((row) => row.centerId === 'p001').jumps, 8);
  assert.equal(snapshots.find((row) => row.centerId === 'p004').crossings, 44);
  assert.equal(snapshots.find((row) => row.centerId === 'p004').jumps, 9);
  assert.ok(snapshots.every((row) => row.lanes <= 4));
});
