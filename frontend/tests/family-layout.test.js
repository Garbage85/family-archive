import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anonymizeTreeTopology,
  assertNoPiiInFixture,
  loadStructuralPeople,
} from '../src/layout/structural-fixture.js';
import {
  buildHouseholds,
  layoutFamilyTree,
  selectVisiblePeople,
} from '../src/layout/family-layout.js';
import {
  analyzeParentChildEdges,
  assertParentChildGenerationOrder,
  assertSpousesNearby,
  findCardOverlaps,
  findLinksThroughForeignCards,
  findMissingRelationEndpoints,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
} from '../src/layout/layout-validators.js';
import { compareLayouts, scanPrototypeCenters } from './helpers/compare-layouts.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/structural-tree.topology.json',
);

async function loadFixture() {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assertNoPiiInFixture(fixture);
  return fixture;
}

test('structural fixture has no PII and preserves topology counts', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.kind, 'structural-topology');
  assert.ok(Array.isArray(fixture.people));
  assert.ok(fixture.people.length > 0, 'fixture must contain people');
  assert.ok(fixture.personCount > 0);
  assert.equal(fixture.personCount, fixture.people.length);
  assert.match(fixture.people[0].id, /^p\d{3}$/);
  assert.equal(Object.keys(fixture.people[0].data).join(','), 'gender');
  assert.ok(fixture.meta.spouseEdgeCount > 0, 'fixture must include at least one spouse edge');
  assert.ok(
    fixture.meta.parentChildEdgeCount > 0,
    'fixture must include at least one parent-child edge',
  );
});

test('anonymizeTreeTopology remaps ids and strips PII', () => {
  const fixture = anonymizeTreeTopology([
    {
      id: 'real-1',
      data: {
        gender: 'M',
        first_name: 'Secret',
        last_name: 'Name',
        notes: 'private',
      },
      rels: { parents: [], spouses: ['real-2'], children: [] },
    },
    {
      id: 'real-2',
      data: { gender: 'F', first_name: 'Other' },
      rels: { parents: [], spouses: ['real-1'], children: [] },
    },
  ]);
  assertNoPiiInFixture(fixture);
  assert.deepEqual(
    fixture.people.map((person) => person.id),
    ['p001', 'p002'],
  );
  assert.deepEqual(fixture.people[0].rels.spouses, ['p002']);
});

test('household model groups spouses before placement', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const visible = selectVisiblePeople(people, fixture.meta.defaultCenterId);
  const households = buildHouseholds(visible);
  const multi = households.filter((household) => household.size > 1);
  assert.ok(multi.length >= 3, 'expected several spouse households');
  const seen = new Set();
  for (const household of households) {
    for (const id of household.memberIds) {
      assert.equal(seen.has(id), false, `person ${id} in multiple households`);
      seen.add(id);
    }
  }
});

test('prototype layout: no overlaps, spouses present, deterministic, generations ordered', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const centerId = fixture.meta.defaultCenterId;
  const expectedVisible = selectVisiblePeople(people, centerId).map((person) => person.id);

  const first = layoutFamilyTree(people, { centerId, orientation: 'vertical' });
  const second = layoutFamilyTree(people, { centerId, orientation: 'vertical' });

  assert.deepEqual(
    first.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    second.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
  );

  assert.deepEqual(first.nodes.map((node) => node.id).sort(), expectedVisible.slice().sort());
  assert.equal(findCardOverlaps(first.nodes).length, 0);
  assert.deepEqual(assertSpousesNearby(first), []);
  assert.deepEqual(assertParentChildGenerationOrder(first), []);
  assert.deepEqual(findMissingRelationEndpoints(people, first), []);

  // Sibling spouses must be present whenever a sibling is visible.
  for (const person of selectVisiblePeople(people, centerId)) {
    const parents = person.rels.parents || [];
    const isSibling = parents.some((parentId) => {
      const parent = people.find((item) => item.id === parentId);
      return (parent?.rels.children || []).includes(centerId) && person.id !== centerId;
    });
    if (!isSibling) continue;
    for (const spouseId of person.rels.spouses || []) {
      assert.ok(
        first.nodes.some((node) => node.id === spouseId),
        `sibling ${person.id} missing spouse ${spouseId}`,
      );
    }
  }

  const horizontal = layoutFamilyTree(people, { centerId, orientation: 'horizontal' });
  assert.equal(findCardOverlaps(horizontal.nodes).length, 0);
  assert.deepEqual(assertParentChildGenerationOrder(horizontal), []);
});

test('center switches keep topology endpoints intact', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const centers = people.slice(0, 8).map((person) => person.id);
  for (const centerId of centers) {
    const layout = layoutFamilyTree(people, { centerId });
    assert.equal(findCardOverlaps(layout.nodes).length, 0);
    for (const link of layout.links) {
      assert.ok(layout.nodes.some((node) => node.id === link.source));
      assert.ok(layout.nodes.some((node) => node.id === link.target));
    }
    assert.deepEqual(findMissingRelationEndpoints(people, layout), []);
  }
});

test('compare family-chart vs prototype on structural fixture', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const report = compareLayouts(people, fixture.meta.defaultCenterId);
  assert.equal(report.prototype.overlaps, 0);
  assert.equal(report.prototype.lostNodes, 0);
  assert.equal(report.prototype.missingSiblingSpouses, 0);
  assert.ok(report.prototype.spouseLinks > 0);
  assert.ok(report.prototype.parentChildLinks > 0);
  // Family Chart stock omits sibling spouses — that gap is why ADR-008 exists.
  assert.ok(
    report.familyChart.missingSiblingSpouses > 0,
    'expected stock Family Chart to miss sibling spouses on this fixture',
  );
  console.log('\nLAYOUT COMPARISON\n', JSON.stringify(report, null, 2));
});

test('line-through-card check runs (may warn but does not require zero for prototype v1)', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: fixture.meta.defaultCenterId });
  const hits = findLinksThroughForeignCards(layout);
  assert.ok(Array.isArray(hits));
});

test('regression: real fixture center p010 keeps every visible parent-child edge', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const centerId = 'p010';
  const layout = layoutFamilyTree(people, { centerId, orientation: 'vertical' });
  const edgeReport = analyzeParentChildEdges(people, layout);
  const required = edgeReport.filter((edge) => edge.shouldShow);
  const missing = findMissingVisibleParentChildLinks(people, layout);
  const missingSpouses = findMissingVisibleSpouseLinks(people, layout);

  assert.equal(findCardOverlaps(layout.nodes).length, 0);
  assert.equal(missing.length, 0, `missing visible parent-child: ${JSON.stringify(missing)}`);
  assert.equal(
    missingSpouses.length,
    0,
    `missing visible spouse: ${JSON.stringify(missingSpouses)}`,
  );
  assert.ok(required.length > 0, 'p010 must have at least one visible parent-child edge');
  for (const edge of required) {
    assert.equal(edge.shown, true, `${edge.parent}->${edge.child} should be drawn`);
  }

  const comparison = compareLayouts(people, centerId);
  assert.equal(comparison.prototype.lostNodes, 0);
  assert.equal(comparison.prototype.overlaps, 0);
  assert.equal(comparison.prototype.missingVisibleParentChildLinks, 0);
  assert.equal(comparison.prototype.missingVisibleSpouseLinks, 0);
  // Apples-to-apples: unique topology edges among displayed people match prototype.
  assert.equal(comparison.prototype.parentChildLinks, comparison.prototype.parentChildLinksUnique);
  assert.equal(
    comparison.familyChart.parentChildLinksUnique,
    comparison.prototype.parentChildLinksUnique,
  );
  // Family Chart raw count includes reverse ancestry.parent pointers and is higher.
  assert.ok(
    comparison.familyChart.parentChildLinksRaw > comparison.familyChart.parentChildLinksUnique,
    'expected FC raw parentChildLinks to overcount vs unique topology edges',
  );
  assert.equal(
    comparison.familyChart.parentChildLinksRaw,
    comparison.familyChart.parentChildFromParents +
      comparison.familyChart.parentChildFromAncestryParent,
  );

  console.log(
    '\nP010 PARENT-CHILD EDGE REPORT\n',
    JSON.stringify(
      {
        displayedCount: layout.nodes.length,
        visibleIds: layout.nodes.map((node) => node.id).sort(),
        spouseLinks: layout.links.filter((link) => link.type === 'spouse').length,
        parentChildLinks: layout.links.filter((link) => link.type === 'parent-child').length,
        familyChart: comparison.familyChart,
        requiredEdges: required,
        nonVisibleEdgesSample: edgeReport.filter((edge) => !edge.bothVisible).slice(0, 8),
      },
      null,
      2,
    ),
  );
});

test('gate: prototype centers p001..p010 have no lost nodes, overlaps, or missing visible links', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const centerIds = Array.from(
    { length: 10 },
    (_, index) => `p${String(index + 1).padStart(3, '0')}`,
  );
  const rows = scanPrototypeCenters(people, centerIds);
  const failures = rows.filter(
    (row) =>
      row.lostNodes > 0 ||
      row.overlaps > 0 ||
      row.missingVisibleParentChildLinks > 0 ||
      row.missingVisibleSpouseLinks > 0,
  );

  console.log('\nPROTOTYPE CENTER SCAN p001..p010\n', JSON.stringify(rows, null, 2));
  assert.deepEqual(failures, [], `centers failed gate: ${JSON.stringify(failures)}`);

  for (const row of rows) {
    assert.equal(row.lostNodes, 0, `${row.centerId} lostNodes`);
    assert.equal(row.overlaps, 0, `${row.centerId} overlaps`);
    assert.equal(row.missingSiblingSpouses, 0, `${row.centerId} missingSiblingSpouses`);
    assert.equal(
      row.missingVisibleParentChildLinks,
      0,
      `${row.centerId} missingVisibleParentChildLinks`,
    );
    assert.equal(row.missingVisibleSpouseLinks, 0, `${row.centerId} missingVisibleSpouseLinks`);
  }
});
