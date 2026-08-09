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
  findAmbiguousSharedLanes,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findLinksThroughForeignCards,
  findMissingRelationEndpoints,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  findOverlappingCollinearUnrelatedSegments,
  findUnrelatedLinkIntersections,
  findZeroLengthSegments,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import {
  CROSSING_STYLE,
  findExteriorParentChildDetours,
  findInvalidJunctions,
  routingMetrics,
} from '../src/layout/link-routing.js';
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
  // Prototype counts unique topology edges among its own displayed people.
  assert.equal(comparison.prototype.parentChildLinks, comparison.prototype.parentChildLinksUnique);
  // Family Chart raw count includes reverse ancestry.parent pointers and is higher
  // than unique topology edges among FC's (smaller) displayed set.
  assert.ok(
    comparison.familyChart.parentChildLinksRaw > comparison.familyChart.parentChildLinksUnique,
    'expected FC raw parentChildLinks to overcount vs unique topology edges',
  );
  assert.ok(
    comparison.prototype.parentChildLinksUnique >= comparison.familyChart.parentChildLinksUnique,
    'prototype spouse-symmetric area should cover at least FC unique parent-child edges',
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

test('regression: spouse-symmetric visible set is identical for p010 and spouse p003', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const ids = (centerId) => selectVisiblePeople(people, centerId).map((person) => person.id);
  const fromHusband = ids('p010');
  const fromWife = ids('p003');
  assert.deepEqual(fromHusband, fromWife);
  assert.deepEqual(fromHusband, [
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
  ]);
  // Sibling-spouse direct parent (p009 father of p008) is included — one level only.
  assert.equal(fromHusband.includes('p009'), true);

  for (const centerId of ['p010', 'p003']) {
    const layout = layoutFamilyTree(people, { centerId });
    assert.deepEqual(layout.nodes.map((node) => node.id).sort(), fromHusband);
    assert.equal(findCardOverlaps(layout.nodes).length, 0);
    assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0);
    assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0);
  }

  console.log(
    '\nSPOUSE-SYMMETRIC VISIBLE IDS\n',
    JSON.stringify({ p010: fromHusband, p003: fromWife }, null, 2),
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

  console.log(
    '\nPROTOTYPE CENTER SCAN p001..p010\n',
    JSON.stringify(
      {
        rows,
        visibleIds: {
          p003: selectVisiblePeople(people, 'p003').map((person) => person.id),
          p010: selectVisiblePeople(people, 'p010').map((person) => person.id),
        },
      },
      null,
      2,
    ),
  );
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

  for (const centerId of centerIds) {
    const layout = layoutFamilyTree(people, { centerId });
    const layoutAgain = layoutFamilyTree(people, { centerId });
    assert.equal(findLinksThroughForeignCards(layout).length, 0, `${centerId} linksThroughCards`);
    assert.equal(
      findOverlappingCollinearUnrelatedSegments(layout).length,
      0,
      `${centerId} collinear unrelated`,
    );
    assert.equal(findAmbiguousSharedLanes(layout).length, 0, `${centerId} ambiguous lanes`);
    assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${centerId} ambiguous segments`);
    assert.equal(findZeroLengthSegments(layout).length, 0, `${centerId} zero-length segments`);
    assert.equal(findInvalidJunctions(layout).length, 0, `${centerId} invalid junctions`);
    assert.equal(
      findExteriorParentChildDetours(layout).length,
      0,
      `${centerId} exterior parent-child detours`,
    );
    assert.equal(
      layoutRouteSignature(layout),
      layoutRouteSignature(layoutAgain),
      `${centerId} deterministic route signatures`,
    );
    // Crossings are informational and may be > 0.
    assert.ok(
      findUnrelatedLinkIntersections(layout).length >= 0,
      `${centerId} crossings metric available`,
    );
  }
});

test('family-junction routing keeps short gap buses; crossings allowed with line-jumps', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010', orientation: 'vertical' });
  const spouseLinks = layout.links.filter((link) => link.type === 'spouse');
  const parentLinks = layout.links.filter((link) => link.type === 'parent-child');

  assert.ok(spouseLinks.length >= 4);
  for (const link of spouseLinks) {
    assert.equal(link.points.length, 2, 'spouse link is a single segment');
    assert.match(link.familyKey, /^spouse:/);
  }

  const familyKeys = new Set(parentLinks.map((link) => link.familyKey));
  assert.ok(familyKeys.has('pc:p001+p002'));
  assert.ok(familyKeys.has('pc:p004+p005'));
  assert.ok(familyKeys.has('pc:p009'));
  assert.equal(findLinksThroughForeignCards(layout).length, 0);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0);
  assert.equal(findOverlappingCollinearUnrelatedSegments(layout).length, 0);
  assert.equal(findZeroLengthSegments(layout).length, 0);
  assert.equal(findInvalidJunctions(layout).length, 0);
  assert.equal(findExteriorParentChildDetours(layout).length, 0);
  assert.equal(CROSSING_STYLE, 'line-jump');

  for (const link of parentLinks) {
    assert.equal(link.busMode, 'gap', `${link.source}->${link.target} stays in generation gap`);
  }

  const crossings = findUnrelatedLinkIntersections(layout);
  const metrics = routingMetrics(layout.links);
  assert.ok(crossings.length > 0, 'full p010 graph is expected to have unrelated crossings');
  assert.ok(metrics.lineJumpCount > 0, 'horizontal buses receive line-jumps at crossings');

  const centerIds = Array.from(
    { length: 10 },
    (_, index) => `p${String(index + 1).padStart(3, '0')}`,
  );
  const crossingReport = centerIds.map((centerId) => {
    const centered = layoutFamilyTree(people, { centerId });
    const centeredMetrics = routingMetrics(centered.links);
    return {
      centerId,
      crossings: findUnrelatedLinkIntersections(centered).length,
      ambiguousSharedSegments: findAmbiguousSharedSegments(centered).length,
      exteriorDetours: findExteriorParentChildDetours(centered).length,
      maxBends: centeredMetrics.maxBendsPerParentChild,
      maxRouteLength: centeredMetrics.maxParentChildLength,
      lineJumps: centeredMetrics.lineJumpCount,
      routingBounds: centeredMetrics.routingBounds,
    };
  });

  console.log(
    '\nP010 ROUTING METRICS\n',
    JSON.stringify(
      {
        crossingStyle: CROSSING_STYLE,
        junctionVsCrossing: {
          junction: 'shared family stem/bus (familyKey) + explicit junction point',
          crossing: 'unrelated H×V intersection; horizontal bus uses SVG line-jump',
        },
        nodes: layout.nodes.length,
        links: layout.links.length,
        parentChildLinks: parentLinks.length,
        spouseLinks: spouseLinks.length,
        visibleIds: layout.nodes.map((node) => node.id),
        hasP009: layout.nodes.some((node) => node.id === 'p009'),
        linksThroughCards: 0,
        ambiguousSharedSegments: 0,
        unrelatedLinkIntersections: crossings.length,
        lineJumpCount: metrics.lineJumpCount,
        maxBendsPerParentChild: metrics.maxBendsPerParentChild,
        maxParentChildLength: metrics.maxParentChildLength,
        routingBounds: metrics.routingBounds,
        familyKeys: [...familyKeys].sort(),
        crossingReport,
      },
      null,
      2,
    ),
  );
});

test('after sibling spouse is visible, routing stays in generation gap (no exterior bus)', async () => {
  const fixture = await loadFixture();
  const people = loadStructuralPeople(fixture);
  // Production topology already includes sibling p007 with spouse p008 (+ parent p009).
  const layout = layoutFamilyTree(people, { centerId: 'p010' });
  assert.ok(
    layout.nodes.some((node) => node.id === 'p008'),
    'sibling spouse visible',
  );
  assert.ok(
    layout.nodes.some((node) => node.id === 'p009'),
    'sibling-spouse parent visible',
  );

  const exterior = findExteriorParentChildDetours(layout);
  assert.deepEqual(exterior, [], `exterior detours: ${JSON.stringify(exterior)}`);
  assert.equal(findInvalidJunctions(layout).length, 0);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0);
  assert.equal(findLinksThroughForeignCards(layout).length, 0);

  const childRowBottom = Math.max(
    ...layout.nodes.filter((node) => node.generation === 0).map((node) => node.y + node.height / 2),
  );
  for (const link of layout.links.filter((item) => item.type === 'parent-child')) {
    assert.equal(link.busMode, 'gap');
    for (const point of link.points) {
      assert.ok(
        point[1] <= childRowBottom + 0.51,
        `${link.source}->${link.target} y=${point[1]} must not go under sibling/child row (${childRowBottom})`,
      );
    }
  }
});
