import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeLocalBusInterval,
  findChildrenBlockInterleavingViolations,
  findFamilyBusLocalityViolations,
  findUnrelatedFamiliesSharingBusSegment,
  measureFamilyBuses,
  ROUTING_BUS_PADDING,
} from '../src/layout/family-bus.js';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  coldWarmSignatureMismatch,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import { findTwoParentStemAnchorViolations } from '../src/layout/link-routing.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { enforceExtendedBranchesOuter } from '../src/layout/placement-optimizer.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function hardLocalBusGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findTwoParentStemAnchorViolations(layout).length, 0, `${label} stemAnchor`);
  assert.equal(layout.meta.parallelGapViolations ?? 0, 0, `${label} parallelGap`);
  assert.equal(layout.meta.familyBusLocalityViolations ?? 0, 0, `${label} busLocality`);
  assert.equal(layout.meta.unrelatedFamiliesSharingBusSegment ?? 0, 0, `${label} sharedBusSegment`);
  assert.equal(
    layout.meta.childrenBlockInterleavingViolations ?? 0,
    0,
    `${label} childrenInterleave`,
  );
  assert.equal(layout.meta.hardViolations ?? 0, 0, `${label} hard`);
  const metrics = collectPlacementMetrics(people, layout, {
    expectedVisibleIds: layout.nodes.map((node) => node.id),
    households: layout.households,
    spouseSide: layout.meta.spouseSide,
  });
  assert.equal(metrics.familyBusLocalityViolations, 0, `${label} metric locality`);
  assert.equal(metrics.unrelatedFamiliesSharingBusSegment, 0, `${label} metric shared`);
  assert.equal(metrics.childrenBlockInterleavingViolations, 0, `${label} metric interleave`);
}

test('computeLocalBusInterval covers children + stem only', () => {
  assert.equal(ROUTING_BUS_PADDING, 0);
  const multi = computeLocalBusInterval({ childCross: [0, 100, 200], stemCross: 50 });
  assert.equal(multi.busStart, 0);
  assert.equal(multi.busEnd, 200);
  assert.equal(multi.naturalSpan, 200);
  assert.equal(multi.stemOverhang, 0);

  const overhang = computeLocalBusInterval({ childCross: [100, 200], stemCross: 0 });
  assert.equal(overhang.busStart, 0);
  assert.equal(overhang.busEnd, 200);
  assert.equal(overhang.stemOverhang, 100);

  const single = computeLocalBusInterval({ childCross: [40], stemCross: 40 });
  assert.equal(single.busStart, 40);
  assert.equal(single.busEnd, 40);
  assert.equal(single.naturalSpan, 0);
});

test('enforceExtendedBranchesOuter keeps parents toward core', () => {
  const branches = [
    { id: 'ps', kind: 'parent-sibling' },
    { id: 'par', kind: 'parents' },
    { id: 'sib', kind: 'sibling' },
  ];
  const right = enforceExtendedBranchesOuter(branches, 'center', 'left').map((b) => b.id);
  assert.deepEqual(right, ['par', 'ps', 'sib']);
  const left = enforceExtendedBranchesOuter(branches, 'center', 'right').map((b) => b.id);
  assert.deepEqual(left, ['ps', 'sib', 'par']);
});

test('PRODUCTION p010: local buses BEFORE→AFTER report', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010' });
  hardLocalBusGate(people, layout, 'p010');

  const buses = measureFamilyBuses(layout, { orientation: 'vertical', people });
  // Non-overlapping local buses may share one lane in a gap.
  assert.ok(layout.meta.maxLaneCount <= 2, 'local buses should not demand a generation rail');
  assert.equal(findUnrelatedFamiliesSharingBusSegment(layout).length, 0);
  assert.equal(findFamilyBusLocalityViolations(layout, { people }).length, 0);
  assert.equal(findChildrenBlockInterleavingViolations(layout, { people }).length, 0);

  // Same lane + non-overlapping X ⇒ distinct local segments, not one magistral.
  const gapBuses = buses.filter((row) => row.busAxis != null);
  for (let i = 0; i < gapBuses.length; i += 1) {
    for (let j = i + 1; j < gapBuses.length; j += 1) {
      const a = gapBuses[i];
      const b = gapBuses[j];
      if (a.busAxis !== b.busAxis) continue;
      const overlap = Math.min(a.busEnd, b.busEnd) - Math.max(a.busStart, b.busStart);
      assert.ok(overlap <= 0, `same-lane buses must not overlap: ${a.familyKey} vs ${b.familyKey}`);
    }
  }

  const report = {
    centerId: 'p010',
    before: {
      note: 'wide demand spans + JOIN_PAD forced multi-lane generation rails',
      maxLaneCount: 2,
      requiredLaneCountByGap: { '-1->0': 2, '-2->-1': 1 },
      maxBusLength: 472,
      foreignHouseholdsUnderBus: 4,
      model: 'parent+child span conflict / parallel generation buses',
    },
    after: {
      maxLaneCount: layout.meta.maxLaneCount,
      requiredLaneCountByGap: layout.meta.requiredLaneCountByGap,
      maxBusLength: layout.meta.maxBusLength,
      foreignHouseholdsUnderBus: layout.meta.foreignHouseholdsUnderBus,
      busExcessLength: layout.meta.busExcessLength,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      totalRoutingGapHeight: layout.meta.totalRoutingGapHeight,
      hardViolations: layout.meta.hardViolations,
      families: buses.map((row) => ({
        familyKey: row.familyKey,
        parentIds: row.parentIds,
        childIds: row.childIds,
        busStart: row.busStart,
        busEnd: row.busEnd,
        busLength: row.busLength,
        naturalChildSpan: row.naturalChildSpan,
        excess: row.excess,
        lane: row.laneIndex,
        foreignHouseholdsUnderBus: row.foreignHouseholdsUnderBus,
      })),
    },
  };
  console.log('\nLOCAL BUS BEFORE→AFTER (p010)\n', JSON.stringify(report, null, 2));
});

test('all production centers: local-bus hard gates', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const rows = [];
  for (const person of fixture.people) {
    const layout = layoutFamilyTree(people, { centerId: person.id });
    hardLocalBusGate(people, layout, person.id);
    rows.push({
      centerId: person.id,
      maxLaneCount: layout.meta.maxLaneCount,
      maxBusLength: layout.meta.maxBusLength,
      foreignHouseholdsUnderBus: layout.meta.foreignHouseholdsUnderBus,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      hard: layout.meta.hardViolations,
    });
  }
  console.log('\nALL-CENTERS LOCAL BUS GATE\n', JSON.stringify(rows, null, 2));
});

test('determinism: local bus plan stable cold/warm/20x', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const cold = layoutFamilyTree(people, { centerId: 'p010' });
  const warm = layoutFamilyTree(people, { centerId: 'p010', previousLayout: cold });
  assert.equal(coldWarmSignatureMismatch(cold, warm), 0);
  assert.deepEqual(measureFamilyBuses(cold, { people }), measureFamilyBuses(warm, { people }));
  const sig = layoutRouteSignature(cold);
  for (let i = 0; i < 20; i += 1) {
    const again = layoutFamilyTree(people, { centerId: 'p010' });
    assert.equal(layoutRouteSignature(again), sig, `repeat ${i}`);
  }
});
