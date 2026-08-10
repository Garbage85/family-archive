import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHouseholds,
  layoutFamilyTree,
  selectVisiblePeople,
} from '../src/layout/family-layout.js';
import {
  assertCrossingJumpParity,
  assertParentChildGenerationOrder,
  assertSpousesNearby,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  findOverlappingCollinearUnrelatedSegments,
  findZeroLengthSegments,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import {
  findExteriorParentChildDetours,
  findInvalidJunctions,
  routeSignature,
} from '../src/layout/link-routing.js';
import {
  assignParallelVerticalLanes,
  findVerticalLaneConflicts,
  VERTICAL_LANE_GAP,
} from '../src/layout/parallel-lanes.js';
import {
  classifyHouseholdSides,
  orderCoreHouseholdMembers,
  orderHouseholdsFamilySide,
} from '../src/layout/placement-optimizer.js';
import { collectPlacementMetrics, summarizeCandidateRow } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople, assertNoPiiInFixture } from '../src/layout/structural-fixture.js';
import beforeMetrics from './fixtures/placement-before-metrics.json' with { type: 'json' };

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProductionFixture() {
  const fixture = JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
  assertNoPiiInFixture(fixture);
  return fixture;
}

async function loadSyntheticCases() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/synthetic-placement-cases.json'), 'utf8'),
  );
}

function hardGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.deepEqual(assertSpousesNearby(layout), [], `${label} spousesNearby`);
  assert.deepEqual(assertParentChildGenerationOrder(layout), [], `${label} generationOrder`);
  assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0, `${label} missingPC`);
  assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0, `${label} missingSpouse`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} throughCards`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findOverlappingCollinearUnrelatedSegments(layout).length, 0, `${label} collinear`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findInvalidJunctions(layout).length, 0, `${label} invalidJ`);
  assert.equal(findExteriorParentChildDetours(layout).length, 0, `${label} exterior`);
  assert.equal(findZeroLengthSegments(layout).length, 0, `${label} zeroLen`);
  assert.equal(layout.meta.familySideViolations ?? 0, 0, `${label} familySide`);
  assert.equal(layout.meta.branchIntegrityViolations ?? 0, 0, `${label} branch`);
  assert.equal(
    layout.meta.parentSiblingBranchSideViolations ?? 0,
    0,
    `${label} parentSiblingBranchSide`,
  );
  assert.equal(layout.meta.parallelLaneOverlap ?? 0, 0, `${label} parallelLaneOverlap`);
  assert.equal(layout.meta.parallelGapViolations ?? 0, 0, `${label} parallelGapViolations`);
  assert.equal(layout.meta.hardViolations ?? 0, 0, `${label} hard`);
  const parity = assertCrossingJumpParity(layout);
  assert.equal(parity.missedJumps, 0, `${label} missedJumps`);
  assert.equal(parity.falseJumps, 0, `${label} falseJumps`);
  assert.equal(parity.unrelatedGeometricCrossings, parity.renderedLineJumps, `${label} parity`);
}

test('family-side ordering prefers spouse block outside when spouse is left', () => {
  const households = [
    { id: 'hh:core', side: 'core', memberIds: ['c', 's'] },
    { id: 'hh:spouse-sib', side: 'spouse', memberIds: ['ss'] },
    { id: 'hh:center-sib', side: 'center', memberIds: ['cs'] },
  ];
  const left = orderHouseholdsFamilySide(households, 'left').map((h) => h.id);
  assert.deepEqual(left, ['hh:spouse-sib', 'hh:core', 'hh:center-sib']);
  const right = orderHouseholdsFamilySide(households, 'right').map((h) => h.id);
  assert.deepEqual(right, ['hh:center-sib', 'hh:core', 'hh:spouse-sib']);
});

test('core household member order mirrors spouse side without gender hardcoding', () => {
  const single = { memberIds: ['c010', 'c003'] };
  assert.deepEqual(orderCoreHouseholdMembers(single, 'c010', 'left'), ['c003', 'c010']);
  assert.deepEqual(orderCoreHouseholdMembers(single, 'c010', 'right'), ['c010', 'c003']);

  // Multiple spouses keep center in the middle so spouse links stay adjacent.
  const household = { memberIds: ['c010', 'c003', 'c099'] };
  assert.deepEqual(orderCoreHouseholdMembers(household, 'c010', 'left'), ['c003', 'c010', 'c099']);
  const right = orderCoreHouseholdMembers(household, 'c010', 'right');
  assert.equal(right[1], 'c010');
  assert.ok(right.includes('c003') && right.includes('c099'));
});

test('parallel lanes separate coincident unrelated verticals', () => {
  const links = [
    {
      type: 'parent-child',
      source: 'a',
      target: 'b',
      familyKey: 'fam:a',
      points: [
        [0, 0],
        [0, 100],
      ],
    },
    {
      type: 'parent-child',
      source: 'c',
      target: 'd',
      familyKey: 'fam:c',
      points: [
        [0, 20],
        [0, 120],
      ],
    },
    {
      type: 'parent-child',
      source: 'e',
      target: 'f',
      familyKey: 'fam:e',
      points: [
        [0, 40],
        [0, 140],
      ],
    },
  ];
  assert.ok(findVerticalLaneConflicts(links).length >= 2);
  const offsets = assignParallelVerticalLanes(links, { gap: VERTICAL_LANE_GAP });
  assert.equal(offsets.size, 3);
  const values = [...offsets.values()].sort((a, b) => a - b);
  // Centered symmetric lanes: N=3 → -gap, 0, +gap
  assert.deepEqual(values, [-VERTICAL_LANE_GAP, 0, VERTICAL_LANE_GAP]);
  // same family may share
  const same = [
    {
      type: 'parent-child',
      source: 'a',
      target: 'b',
      familyKey: 'fam:x',
      points: [
        [5, 0],
        [5, 50],
      ],
    },
    {
      type: 'parent-child',
      source: 'a',
      target: 'c',
      familyKey: 'fam:x',
      points: [
        [5, 0],
        [5, 80],
      ],
    },
  ];
  assert.equal(assignParallelVerticalLanes(same).size, 0);
});

test('production all-centers placement gate + BEFORE/AFTER report', async () => {
  const fixture = await loadProductionFixture();
  const people = loadStructuralPeople(fixture);
  const centerIds = Array.from(
    { length: fixture.personCount },
    (_, index) => `p${String(index + 1).padStart(3, '0')}`,
  );

  const rows = [];
  for (const centerId of centerIds) {
    const layout = layoutFamilyTree(people, {
      centerId,
      orientation: 'vertical',
      returnCandidates: true,
    });
    hardGate(people, layout, centerId);
    const horizontal = layoutFamilyTree(people, { centerId, orientation: 'horizontal' });
    hardGate(people, horizontal, `${centerId}/horizontal`);

    const first = layoutFamilyTree(people, { centerId });
    const second = layoutFamilyTree(people, { centerId });
    assert.deepEqual(
      first.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
      second.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
      `${centerId} deterministic coords`,
    );
    assert.equal(layoutRouteSignature(first), layoutRouteSignature(second), `${centerId} routes`);
    assert.equal(first.meta.spouseSide, second.meta.spouseSide);

    const householdToBranch = new Map(
      (layout.meta.branches || []).flatMap((branch) =>
        (branch.householdIds || []).map((id) => [id, branch]),
      ),
    );
    const metrics = collectPlacementMetrics(people, layout, {
      expectedVisibleIds: selectVisiblePeople(people, centerId).map((person) => person.id),
      households: layout.households,
      spouseSide: layout.meta.spouseSide,
      householdToBranch,
    });
    rows.push({
      centerId,
      displayedCount: layout.nodes.length,
      householdCount: layout.households.length,
      spouseSide: layout.meta.spouseSide,
      candidateId: layout.meta.candidateId,
      overlaps: metrics.overlaps,
      lostNodes: metrics.lostNodes,
      missingPC: metrics.missingPC,
      missingSpouse: metrics.missingSpouse,
      missingSiblingSpouses: metrics.missingSiblingSpouses,
      linksThroughCards: metrics.linksThroughCards,
      falseJunctions: metrics.falseJunctions,
      ambiguousShared: metrics.ambiguousSharedSegments,
      familySideViolations: metrics.familySideViolations,
      branchIntegrityViolations: metrics.branchIntegrityViolations,
      parentSiblingBranchSideViolations: metrics.parentSiblingBranchSideViolations,
      parallelLaneOverlap: metrics.parallelLaneOverlap,
      parallelLanes: metrics.parallelLanes,
      crossings: metrics.crossings,
      jumps: metrics.jumps,
      bends: metrics.bends,
      routeLength: metrics.routeLength,
      boundingBox: metrics.boundingBox,
      hardViolations: metrics.hardViolations,
      totalCost: Math.round(metrics.totalCost),
      candidates: layout.meta.candidates,
      householdOrdering: layout.meta.householdOrdering,
    });
  }

  for (const row of rows) {
    assert.equal(row.hardViolations, 0, `${row.centerId} hardViolations`);
    assert.equal(row.familySideViolations, 0, `${row.centerId} familySide`);
    assert.equal(row.branchIntegrityViolations, 0, `${row.centerId} branch`);
    assert.equal(
      row.parentSiblingBranchSideViolations,
      0,
      `${row.centerId} parentSiblingBranchSide`,
    );
    assert.equal(row.parallelLaneOverlap, 0, `${row.centerId} parallelLaneOverlap`);
  }

  const p010 = rows.find((row) => row.centerId === 'p010');
  const p003 = rows.find((row) => row.centerId === 'p003');
  const before010 = beforeMetrics.rows.find((row) => row.centerId === 'p010');
  const before003 = beforeMetrics.rows.find((row) => row.centerId === 'p003');

  // Expanded topology may keep unavoidable crossings; family structure is hard.
  assert.equal(p010.hardViolations, 0);
  assert.equal(p003.hardViolations, 0);
  assert.equal(p010.familySideViolations, 0);
  assert.equal(p003.familySideViolations, 0);
  const sister010 = p010.householdOrdering
    .flatMap((row) => row.households)
    .find((household) => household.memberIds.includes('p011'));
  assert.equal(sister010?.side, 'spouse', 'from p010, sister of spouse stays spouse-side');
  const sister003 = p003.householdOrdering
    .flatMap((row) => row.households)
    .find((household) => household.memberIds.includes('p011'));
  assert.equal(sister003?.side, 'center', 'from p003, own sister stays center-side');

  // Couple symmetry: same people; sides may be mirrored.
  assert.deepEqual(
    selectVisiblePeople(people, 'p010').map((person) => person.id),
    selectVisiblePeople(people, 'p003').map((person) => person.id),
  );

  console.log(
    '\nPLACEMENT BEFORE/AFTER\n',
    JSON.stringify(
      {
        p010: {
          before: {
            crossings: before010.crossings,
            jumps: before010.jumps,
            routeLength: before010.routeLength,
            ordering: before010.ordering,
          },
          after: summarizeCandidateRow(p010.candidateId, p010),
          householdOrdering: p010.householdOrdering,
          candidates: p010.candidates,
        },
        p003: {
          before: {
            crossings: before003.crossings,
            jumps: before003.jumps,
            routeLength: before003.routeLength,
            ordering: before003.ordering,
          },
          after: summarizeCandidateRow(p003.candidateId, p003),
          householdOrdering: p003.householdOrdering,
          candidates: p003.candidates,
        },
        allCenters: rows.map((row) => ({
          centerId: row.centerId,
          displayedCount: row.displayedCount,
          householdCount: row.householdCount,
          spouseSide: row.spouseSide,
          overlaps: row.overlaps,
          lostNodes: row.lostNodes,
          missingPC: row.missingPC,
          missingSpouse: row.missingSpouse,
          missingSiblingSpouses: row.missingSiblingSpouses,
          linksThroughCards: row.linksThroughCards,
          falseJunctions: row.falseJunctions,
          ambiguousShared: row.ambiguousShared,
          parallelLanes: row.parallelLanes,
          crossings: row.crossings,
          jumps: row.jumps,
          bends: row.bends,
          routeLength: row.routeLength,
          boundingBox: row.boundingBox,
          totalCost: row.totalCost,
        })),
      },
      null,
      2,
    ),
  );
});

test('synthetic placement fixtures pass hard invariants', async () => {
  const bundle = await loadSyntheticCases();
  const timings = [];
  for (const testCase of bundle.cases) {
    const people = testCase.people;
    const started = performance.now();
    const layout = layoutFamilyTree(people, {
      centerId: testCase.centerId,
      orientation: 'vertical',
      returnCandidates: true,
    });
    const elapsed = performance.now() - started;
    timings.push({ id: testCase.id, ms: Number(elapsed.toFixed(2)), nodes: layout.nodes.length });
    hardGate(people, layout, testCase.id);
    const horizontal = layoutFamilyTree(people, {
      centerId: testCase.centerId,
      orientation: 'horizontal',
    });
    hardGate(people, horizontal, `${testCase.id}/horizontal`);

    // Determinism
    const again = layoutFamilyTree(people, { centerId: testCase.centerId });
    assert.equal(layoutRouteSignature(layout), layoutRouteSignature(again), `${testCase.id} det`);
  }

  const large = timings.find((item) => item.id === 'large-synthetic');
  assert.ok(large, 'large synthetic present');
  assert.ok(large.ms < 250, `large synthetic should stay interactive, got ${large.ms}ms`);
  console.log('\nSYNTHETIC PLACEMENT TIMINGS\n', JSON.stringify(timings, null, 2));
});

test('classifier keeps sibling-spouse parents on the sibling side', async () => {
  const fixture = await loadProductionFixture();
  const people = loadStructuralPeople(fixture);
  const visible = selectVisiblePeople(people, 'p010');
  const households = buildHouseholds(visible);
  const classified = classifyHouseholdSides(
    households,
    new Map(visible.map((person) => [person.id, person])),
    'p010',
  );
  const p009 = classified.find((household) => household.memberIds.includes('p009'));
  assert.equal(p009.side, 'center');
  const spouseParents = classified.find((household) => household.memberIds.includes('p004'));
  assert.equal(spouseParents.side, 'spouse');
});

test('route signatures include lane offsets when present', () => {
  const sig = routeSignature({
    type: 'parent-child',
    source: 'a',
    target: 'b',
    familyKey: 'fam:a',
    points: [
      [0, 0],
      [14, 0],
      [14, 40],
    ],
    jumps: [],
  });
  assert.match(sig, /14,0;14,40/);
});
