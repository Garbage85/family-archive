import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  coldWarmSignatureMismatch,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  layoutGeometrySignature,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import {
  countAnchoredStemViolations,
  coupleSpouseJunction,
  findExteriorParentChildDetours,
  findFamilyJunctionMismatch,
  findFamilyStemLaneShiftViolations,
  findMultipleStemsPerParentPair,
  findSingleParentStemAnchorViolations,
  findTwoParentStemAnchorViolations,
  routingMetrics,
  visibleSpouseLinkEndpoints,
} from '../src/layout/link-routing.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

async function loadGrowth() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree-growth.json'), 'utf8'),
  );
}

function hardStemGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findExteriorParentChildDetours(layout).length, 0, `${label} exterior`);
  assert.equal(findTwoParentStemAnchorViolations(layout).length, 0, `${label} twoParentStem`);
  assert.equal(findSingleParentStemAnchorViolations(layout).length, 0, `${label} singleParentStem`);
  assert.equal(findFamilyStemLaneShiftViolations(layout).length, 0, `${label} stemShift`);
  assert.equal(findMultipleStemsPerParentPair(layout).length, 0, `${label} multiStem`);
  assert.equal(findFamilyJunctionMismatch(layout).length, 0, `${label} junctionMismatch`);
  assert.equal(layout.meta.parallelGapViolations ?? 0, 0, `${label} parallelGap`);
  const metrics = collectPlacementMetrics(people, layout, {
    expectedVisibleIds: layout.nodes.map((node) => node.id),
    households: layout.households,
    spouseSide: layout.meta.spouseSide,
  });
  assert.equal(metrics.twoParentStemAnchoredToSpouseMidpoint, 0, `${label} metric twoParent`);
  assert.equal(metrics.familyStemLaneShiftViolations, 0, `${label} metric shift`);
}

function coupleStemReport(layout) {
  const rows = [];
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child' || !link.familyKey?.includes('+')) continue;
    if (rows.some((row) => row.familyKey === link.familyKey)) continue;
    const spouse = (layout.links || []).find(
      (item) => item.type === 'spouse' && item.familyKey === link.familyKey,
    );
    const mid =
      spouse?.points?.length >= 2
        ? {
            x: (spouse.points[0][0] + spouse.points[spouse.points.length - 1][0]) / 2,
            y: (spouse.points[0][1] + spouse.points[spouse.points.length - 1][1]) / 2,
          }
        : null;
    const stemX = link.points?.[1]?.[0];
    rows.push({
      familyKey: link.familyKey,
      spouseMidX: mid?.x ?? null,
      stemX: stemX ?? null,
      junctionX: link.junction?.x ?? null,
      delta: mid && stemX != null ? stemX - mid.x : null,
      laneOffsetX: link.laneOffsetX || 0,
    });
  }
  return rows;
}

test('visible spouse midpoint matches coupleSpouseJunction', () => {
  const a = { id: 'a', x: -100, y: 0, width: 184, height: 170 };
  const b = { id: 'b', x: 100, y: 0, width: 184, height: 170 };
  const { start, end } = visibleSpouseLinkEndpoints(a, b, false);
  const midX = (start[0] + end[0]) / 2;
  const midY = (start[1] + end[1]) / 2;
  const junction = coupleSpouseJunction({ parents: [a, b], parentMidX: 0, parentMidY: 0 }, false);
  assert.equal(junction.x, midX);
  assert.equal(junction.y, midY);
  assert.equal(junction.kind, 'spouse-junction');
});

test('PRODUCTION regression: p010 couple stems stay on spouse midpoint (BEFORE→AFTER)', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010' });
  hardStemGate(people, layout, 'p010');

  const after = coupleStemReport(layout);
  const shifted = after.filter((row) => Math.abs(row.delta || 0) > 1e-6 || row.laneOffsetX);
  assert.equal(shifted.length, 0, `shifted stems: ${JSON.stringify(shifted)}`);

  // Live regression family that previously received stemOffset=16.
  const grandparents = after.find((row) => row.familyKey === 'fam:p014+p015');
  assert.ok(grandparents, 'grandparents couple must be visible');
  assert.equal(grandparents.delta, 0);
  assert.equal(grandparents.laneOffsetX, 0);
  assert.equal(grandparents.stemX, grandparents.spouseMidX);

  const route = routingMetrics(layout.links);
  const report = {
    centerId: 'p010',
    before: {
      note: 'lane allocator shifted anchored stem of fam:p014+p015',
      example: { familyKey: 'fam:p014+p015', spouseMidX: 0, stemX: 16, delta: 16 },
      shiftedFamilyStems: 1,
    },
    after: {
      couples: after,
      shiftedFamilyStems: shifted.length,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      maxLaneCount: layout.meta.maxLaneCount,
      routingGapHeightByGap: layout.meta.routingGapHeightByGap,
      routeLength: route.totalParentChildLength,
      hardViolations: layout.meta.hardViolations,
      anchored: countAnchoredStemViolations(layout),
    },
  };
  console.log('\nSTEM ANCHOR BEFORE→AFTER (p010)\n', JSON.stringify(report, null, 2));
});

test('all production centers keep anchored family stems', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const rows = [];
  for (const person of fixture.people) {
    const layout = layoutFamilyTree(people, { centerId: person.id });
    hardStemGate(people, layout, person.id);
    const shifted = coupleStemReport(layout).filter(
      (row) => Math.abs(row.delta || 0) > 1e-6 || row.laneOffsetX,
    );
    rows.push({
      centerId: person.id,
      couples: coupleStemReport(layout).length,
      shifted: shifted.length,
      hard: layout.meta.hardViolations,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
    });
  }
  console.log('\nALL-CENTERS STEM ANCHOR GATE\n', JSON.stringify(rows, null, 2));
});

test('growth: existing couple stems stay midpoint-anchored after add', async () => {
  const growth = await loadGrowth();
  const beforePeople = growth.BEFORE_ADD.people;
  const afterPeople = growth.AFTER_ADD.people;
  const before = layoutFamilyTree(beforePeople, { centerId: 'p010' });
  const after = layoutFamilyTree(afterPeople, { centerId: 'p010' });
  hardStemGate(beforePeople, before, 'BEFORE_ADD');
  hardStemGate(afterPeople, after, 'AFTER_ADD');

  const beforeCouples = new Map(coupleStemReport(before).map((row) => [row.familyKey, row]));
  for (const row of coupleStemReport(after)) {
    if (!beforeCouples.has(row.familyKey)) continue;
    assert.equal(row.delta, 0, `${row.familyKey} delta after growth`);
    assert.equal(row.laneOffsetX, 0, `${row.familyKey} offset after growth`);
  }
});

test('determinism: anchored stem geometry identical cold/warm/20x', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const cold = layoutFamilyTree(people, { centerId: 'p010' });
  const warm = layoutFamilyTree(people, { centerId: 'p010', previousLayout: cold });
  assert.equal(coldWarmSignatureMismatch(cold, warm), 0);
  assert.equal(layoutGeometrySignature(cold), layoutGeometrySignature(warm));
  assert.deepEqual(coupleStemReport(cold), coupleStemReport(warm));

  const sig = layoutRouteSignature(cold);
  for (let i = 0; i < 20; i += 1) {
    const again = layoutFamilyTree(people, { centerId: 'p010' });
    assert.equal(layoutRouteSignature(again), sig, `repeat ${i}`);
    assert.deepEqual(coupleStemReport(again), coupleStemReport(cold));
  }
});

test('horizontal orientation keeps stem on spouse-link midpoint', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010', orientation: 'horizontal' });
  hardStemGate(people, layout, 'p010-horizontal');
  for (const row of coupleStemReport(layout)) {
    // In horizontal trees stem runs at constant Y = spouse midpoint Y.
    const link = layout.links.find(
      (item) => item.type === 'parent-child' && item.familyKey === row.familyKey,
    );
    const spouse = layout.links.find(
      (item) => item.type === 'spouse' && item.familyKey === row.familyKey,
    );
    const midY = (spouse.points[0][1] + spouse.points[spouse.points.length - 1][1]) / 2;
    assert.ok(
      link.points.some((point, index, arr) => {
        if (index === arr.length - 1) return false;
        const next = arr[index + 1];
        return (
          Math.abs(point[1] - midY) < 1e-6 &&
          Math.abs(next[1] - midY) < 1e-6 &&
          Math.abs(point[0] - next[0]) > 1
        );
      }),
      `${row.familyKey} missing horizontal stem on midpoint Y`,
    );
    assert.equal(link.laneOffsetX || 0, 0);
  }
});
