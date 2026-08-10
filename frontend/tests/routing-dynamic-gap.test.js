import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  assertCrossingJumpParity,
  coldWarmSignatureMismatch,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  findZeroLengthSegments,
  layoutGeometrySignature,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import {
  findExteriorParentChildDetours,
  routeLayoutLinks,
  routingMetrics,
} from '../src/layout/link-routing.js';
import { measureUnrelatedParallelGaps } from '../src/layout/parallel-lanes.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';
import {
  adjacentLaneAxisGap,
  countLaneConflicts,
  findRoutingOutsideGenerationGap,
  planDynamicGenerationGaps,
  ROUTING_EDGE_PADDING,
  ROUTING_LANE_GAP,
  routingCorridorHeight,
} from '../src/layout/routing-demand.js';
import { buildOverlappingRouteFixture } from '../src/layout/routing-stress-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const OLD_FIXED_LEVEL_SEPARATION = 224;
const OLD_CARD_HEIGHT = 170;
const OLD_OPEN_GAP = OLD_FIXED_LEVEL_SEPARATION - OLD_CARD_HEIGHT;

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function busAxesFromLinks(links, orientation = 'vertical') {
  const byFamily = new Map();
  for (const link of links || []) {
    if (link.type !== 'parent-child' || !link.familyKey) continue;
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const isBus =
        orientation === 'horizontal'
          ? Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > 20
          : Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 20;
      if (!isBus) continue;
      const axis = orientation === 'horizontal' ? a[0] : a[1];
      byFamily.set(link.familyKey, axis);
    }
  }
  return byFamily;
}

function hardRoutingGate(layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findExteriorParentChildDetours(layout).length, 0, `${label} exterior`);
  assert.equal(findZeroLengthSegments(layout).length, 0, `${label} zeroLen`);
  assert.equal(layout.meta?.laneConflicts ?? 0, 0, `${label} laneConflicts`);
  assert.equal(
    layout.meta?.routingOutsideGenerationGap ?? 0,
    0,
    `${label} routingOutsideGenerationGap`,
  );
  assert.equal(layout.meta?.parallelGapViolations ?? 0, 0, `${label} parallelGapViolations`);
  const parity = assertCrossingJumpParity(layout);
  assert.equal(parity.missedJumps, 0, `${label} missedJumps`);
  assert.equal(parity.falseJumps, 0, `${label} falseJumps`);
}

function runStressPipeline(routeCount, orientation = 'vertical') {
  const fixture = buildOverlappingRouteFixture(routeCount, { orientation });
  const planned = planDynamicGenerationGaps({
    nodes: fixture.nodes,
    links: fixture.links,
    orientation,
    cardWidth: fixture.cardWidth,
    cardHeight: fixture.cardHeight,
  });
  const links = routeLayoutLinks(
    { nodes: planned.nodes, links: planned.links, households: [] },
    { orientation, routingPlan: planned.routingPlan },
  );
  const nodesById = new Map(planned.nodes.map((node) => [String(node.id), node]));
  const gaps = measureUnrelatedParallelGaps(links, { nodesById });
  const layout = {
    nodes: planned.nodes,
    links,
    meta: {
      orientation,
      requiredLaneCountByGap: planned.routingPlan.requiredLaneCountByGap,
      routingGapHeightByGap: planned.routingPlan.routingGapHeightByGap,
      maxLaneCount: planned.routingPlan.maxLaneCount,
      totalLaneCount: planned.routingPlan.totalLaneCount,
      totalRoutingGapHeight: planned.routingPlan.totalRoutingGapHeight,
      generationBaselines: Object.fromEntries(planned.baselines),
      laneConflicts: countLaneConflicts(links, { orientation }),
      routingOutsideGenerationGap: findRoutingOutsideGenerationGap(
        { nodes: planned.nodes, links },
        { orientation },
      ).length,
      parallelGapViolations: gaps.parallelGapViolations,
      minUnrelatedParallelGap: gaps.minUnrelatedParallelGap,
    },
  };
  return { fixture, planned, layout, busAxes: busAxesFromLinks(links, orientation) };
}

test('routingCorridorHeight formula is explicit and never shrinks lane pitch', () => {
  assert.equal(ROUTING_LANE_GAP, 20);
  assert.equal(ROUTING_EDGE_PADDING, 24);
  assert.equal(routingCorridorHeight(0), 48);
  assert.equal(routingCorridorHeight(1), 48);
  assert.equal(routingCorridorHeight(2), 68);
  assert.equal(routingCorridorHeight(10), 228);
  assert.equal(routingCorridorHeight(20), 428);
  // Adjacent lane pitch is constant for every K.
  for (const k of [2, 10, 20]) {
    assert.equal((routingCorridorHeight(k) - 2 * ROUTING_EDGE_PADDING) / (k - 1), ROUTING_LANE_GAP);
  }
});

test('STRESS 10 overlapping routes: dynamic gap, fixed lane pitch, no exterior', () => {
  const { planned, layout, busAxes } = runStressPipeline(10);
  const gapKey = '-1->0';
  const required = planned.routingPlan.requiredLaneCountByGap[gapKey];
  assert.ok(required >= 10, `requiredLaneCount=${required}`);
  assert.equal(planned.routingPlan.routingGapHeightByGap[gapKey], routingCorridorHeight(required));

  const parentY = planned.baselines.get(-1);
  const childY = planned.baselines.get(0);
  const openGap = childY - parentY - 170;
  assert.equal(openGap, routingCorridorHeight(required));

  const axes = [...busAxes.values()];
  assert.equal(new Set(axes).size, required);
  const { gaps } = adjacentLaneAxisGap(axes);
  for (const gap of gaps) assert.equal(gap, ROUTING_LANE_GAP);

  hardRoutingGate(layout, 'stress-10');
  assert.equal(findLinksThroughForeignCards(layout).length, 0);
  console.log(
    '\nSTRESS 10 PARALLEL ROUTES\n',
    JSON.stringify(
      {
        requiredLaneCount: required,
        routingGapHeight: planned.routingPlan.routingGapHeightByGap[gapKey],
        openGap,
        laneAxes: [...new Set(axes)].sort((a, b) => a - b),
        parallelGapViolations: layout.meta.parallelGapViolations,
        laneConflicts: layout.meta.laneConflicts,
        routingOutsideGenerationGap: layout.meta.routingOutsideGenerationGap,
      },
      null,
      2,
    ),
  );
});

test('STRESS 20 competing routes: linear gap growth, interactive runtime', () => {
  const t0 = performance.now();
  const { planned, layout, busAxes } = runStressPipeline(20);
  const ms = performance.now() - t0;
  const gapKey = '-1->0';
  const required = planned.routingPlan.requiredLaneCountByGap[gapKey];
  assert.ok(required >= 20, `requiredLaneCount=${required}`);
  assert.equal(planned.routingPlan.routingGapHeightByGap[gapKey], routingCorridorHeight(required));
  assert.ok(ms < 500, `runtime ${ms}ms should stay interactive`);

  const { gaps } = adjacentLaneAxisGap([...busAxes.values()]);
  for (const gap of gaps) assert.equal(gap, ROUTING_LANE_GAP);
  hardRoutingGate(layout, 'stress-20');

  // Linear / predictable: height(K) = 48 + (K-1)*20
  assert.equal(routingCorridorHeight(required), 48 + (required - 1) * ROUTING_LANE_GAP);

  console.log(
    '\nSTRESS 20 COMPETING ROUTES\n',
    JSON.stringify(
      {
        requiredLaneCount: required,
        routingGapHeight: planned.routingPlan.routingGapHeightByGap[gapKey],
        runtimeMs: +ms.toFixed(2),
        maxLaneCount: layout.meta.maxLaneCount,
        parallelGapViolations: layout.meta.parallelGapViolations,
      },
      null,
      2,
    ),
  );
});

test('horizontal orientation uses the same corridor formula on generation-axis X', () => {
  const { planned, layout, busAxes } = runStressPipeline(10, 'horizontal');
  const required = planned.routingPlan.requiredLaneCountByGap['-1->0'];
  assert.ok(required >= 10);
  const parentX = planned.baselines.get(-1);
  const childX = planned.baselines.get(0);
  assert.equal(childX - parentX - 184, routingCorridorHeight(required));
  const { gaps } = adjacentLaneAxisGap([...busAxes.values()]);
  for (const gap of gaps) assert.equal(gap, ROUTING_LANE_GAP);
  hardRoutingGate(layout, 'stress-10-horizontal');
});

test('production fixture: dynamic gaps BEFORE→AFTER and required lanes by gap', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010', returnCandidates: true });
  const metrics = collectPlacementMetrics(people, layout, {
    expectedVisibleIds: layout.nodes.map((node) => node.id),
    households: layout.households,
    spouseSide: layout.meta.spouseSide,
    routingPlan: {
      requiredLaneCountByGap: layout.meta.requiredLaneCountByGap,
      routingGapHeightByGap: layout.meta.routingGapHeightByGap,
      maxLaneCount: layout.meta.maxLaneCount,
      totalLaneCount: layout.meta.totalLaneCount,
      totalRoutingGapHeight: layout.meta.totalRoutingGapHeight,
    },
  });
  hardRoutingGate({ ...layout, meta: { ...layout.meta, ...metrics } }, 'production-p010');
  assert.equal(metrics.hardViolations, 0);
  assert.equal(metrics.laneConflicts, 0);
  assert.equal(metrics.routingOutsideGenerationGap, 0);

  const route = routingMetrics(layout.links);
  const report = {
    centerId: 'p010',
    requiredLaneCountByGap: layout.meta.requiredLaneCountByGap,
    routingGapHeightByGap: layout.meta.routingGapHeightByGap,
    generationBaselines: layout.meta.generationBaselines,
    before: {
      model: 'fixed levelSeparation',
      levelSeparation: OLD_FIXED_LEVEL_SEPARATION,
      openGapPerGeneration: OLD_OPEN_GAP,
      note: 'lanes were packed into a fixed ~54px open gap',
    },
    after: {
      model: 'dynamic routing corridor',
      constants: { ROUTING_LANE_GAP, ROUTING_EDGE_PADDING },
      gaps: Object.entries(layout.meta.requiredLaneCountByGap).map(([gap, lanes]) => ({
        generationPair: gap,
        requiredLanes: lanes,
        oldGapSize: OLD_OPEN_GAP,
        newGapSize: layout.meta.routingGapHeightByGap[gap],
      })),
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      routeLength: route.totalParentChildLength,
      treeHeight: metrics.height,
      treeWidth: metrics.width,
      maxLaneCount: layout.meta.maxLaneCount,
      totalRoutingGapHeight: layout.meta.totalRoutingGapHeight,
    },
  };

  for (const row of report.after.gaps) {
    assert.ok(
      row.newGapSize >= routingCorridorHeight(row.requiredLanes),
      `${row.generationPair} gap too small`,
    );
    if (row.requiredLanes >= 2) {
      assert.ok(
        row.newGapSize > OLD_OPEN_GAP,
        `${row.generationPair} should grow past fixed gap when lanes>=2`,
      );
    }
  }

  console.log('\nPRODUCTION BEFORE→AFTER (p010)\n', JSON.stringify(report, null, 2));
});

test('determinism: cold/warm/20x identical lane plan and geometry on production', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const cold = layoutFamilyTree(people, { centerId: 'p010' });
  const warm = layoutFamilyTree(people, { centerId: 'p010', previousLayout: cold });
  assert.equal(coldWarmSignatureMismatch(cold, warm), 0);
  assert.equal(layoutGeometrySignature(cold), layoutGeometrySignature(warm));
  assert.equal(layoutRouteSignature(cold), layoutRouteSignature(warm));
  assert.deepEqual(cold.meta.requiredLaneCountByGap, warm.meta.requiredLaneCountByGap);
  assert.deepEqual(cold.meta.generationBaselines, warm.meta.generationBaselines);

  const sig = layoutRouteSignature(cold);
  for (let i = 0; i < 20; i += 1) {
    const again = layoutFamilyTree(people, { centerId: 'p010' });
    assert.equal(layoutRouteSignature(again), sig, `repeat ${i}`);
    assert.deepEqual(again.meta.requiredLaneCountByGap, cold.meta.requiredLaneCountByGap);
    assert.deepEqual(again.meta.generationBaselines, cold.meta.generationBaselines);
  }
});

test('all production centers: hard routing validators stay green', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const rows = [];
  for (const person of fixture.people) {
    const layout = layoutFamilyTree(people, { centerId: person.id });
    const metrics = collectPlacementMetrics(people, layout, {
      expectedVisibleIds: layout.nodes.map((node) => node.id),
      households: layout.households,
      spouseSide: layout.meta.spouseSide,
      routingPlan: {
        requiredLaneCountByGap: layout.meta.requiredLaneCountByGap,
        routingGapHeightByGap: layout.meta.routingGapHeightByGap,
        maxLaneCount: layout.meta.maxLaneCount,
        totalLaneCount: layout.meta.totalLaneCount,
        totalRoutingGapHeight: layout.meta.totalRoutingGapHeight,
      },
    });
    assert.equal(metrics.hardViolations, 0, `${person.id} hard`);
    assert.equal(metrics.laneConflicts, 0, `${person.id} laneConflicts`);
    assert.equal(metrics.routingOutsideGenerationGap, 0, `${person.id} outside`);
    assert.equal(metrics.parallelGapViolations, 0, `${person.id} parallel`);
    rows.push({
      centerId: person.id,
      maxLaneCount: layout.meta.maxLaneCount,
      totalRoutingGapHeight: layout.meta.totalRoutingGapHeight,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
    });
  }
  console.log('\nALL-CENTERS DYNAMIC GAP GATE\n', JSON.stringify(rows, null, 2));
});
