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
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
} from '../src/layout/layout-validators.js';
import { routingMetrics } from '../src/layout/link-routing.js';
import {
  assignParallelLanes,
  centeredSymmetricOffsets,
  findParallelGapConflicts,
  measureUnrelatedParallelGaps,
  MIN_PARALLEL_GAP,
} from '../src/layout/parallel-lanes.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function hardParallelGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0, `${label} missingPC`);
  assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0, `${label} missingSpouse`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(layout.meta.parallelGapViolations ?? 0, 0, `${label} parallelGapViolations`);
  assert.ok(
    (layout.meta.minUnrelatedParallelGap ?? 0) >= MIN_PARALLEL_GAP,
    `${label} minUnrelatedParallelGap=${layout.meta.minUnrelatedParallelGap}`,
  );
  const parity = assertCrossingJumpParity(layout);
  assert.equal(parity.missedJumps, 0, `${label} missedJumps`);
  assert.equal(parity.falseJumps, 0, `${label} falseJumps`);
}

test('centeredSymmetricOffsets keep adjacent lanes exactly MIN_PARALLEL_GAP apart', () => {
  assert.deepEqual(centeredSymmetricOffsets(2, 16), [-8, 8]);
  assert.deepEqual(centeredSymmetricOffsets(3, 16), [-16, 0, 16]);
  assert.deepEqual(centeredSymmetricOffsets(4, 16), [-24, -8, 8, 24]);
  const two = centeredSymmetricOffsets(2, MIN_PARALLEL_GAP);
  assert.equal(two[1] - two[0], MIN_PARALLEL_GAP);
});

test('near-parallel (not only coincident) verticals are conflicts', () => {
  const links = [
    {
      type: 'parent-child',
      familyKey: 'fam:a',
      source: 'a',
      target: 'b',
      points: [
        [0, 0],
        [0, 100],
      ],
    },
    {
      type: 'parent-child',
      familyKey: 'fam:c',
      source: 'c',
      target: 'd',
      points: [
        [10, 20],
        [10, 120],
      ],
    },
  ];
  const conflicts = findParallelGapConflicts(links, {
    minGap: MIN_PARALLEL_GAP,
    direction: 'vertical',
  });
  assert.ok(conflicts.length >= 1, '10px-apart verticals must conflict');
  const { offsetXByFamily } = assignParallelLanes(links, { gap: MIN_PARALLEL_GAP });
  assert.equal(offsetXByFamily.size, 2);
  const xs = [...offsetXByFamily.values()].sort((a, b) => a - b);
  assert.deepEqual(xs, [-MIN_PARALLEL_GAP / 2, MIN_PARALLEL_GAP / 2]);
});

test('near-parallel horizontal buses are conflicts and get symmetric Y offsets', () => {
  const links = [
    {
      type: 'parent-child',
      familyKey: 'fam:a',
      source: 'a',
      target: 'b',
      points: [
        [0, 0],
        [100, 0],
      ],
    },
    {
      type: 'parent-child',
      familyKey: 'fam:c',
      source: 'c',
      target: 'd',
      points: [
        [40, 8],
        [140, 8],
      ],
    },
    {
      type: 'parent-child',
      familyKey: 'fam:e',
      source: 'e',
      target: 'f',
      points: [
        [20, 4],
        [120, 4],
      ],
    },
  ];
  const before = measureUnrelatedParallelGaps(links);
  assert.ok(before.parallelGapViolations > 0);
  assert.ok(before.minUnrelatedParallelGap < MIN_PARALLEL_GAP);

  const { offsetYByFamily } = assignParallelLanes(links, { gap: MIN_PARALLEL_GAP });
  assert.equal(offsetYByFamily.size, 3);
  const ys = [...offsetYByFamily.values()].sort((a, b) => a - b);
  assert.deepEqual(ys, [-MIN_PARALLEL_GAP, 0, MIN_PARALLEL_GAP]);
});

test('same familyKey may share a corridor', () => {
  const links = [
    {
      type: 'parent-child',
      familyKey: 'fam:x',
      source: 'a',
      target: 'b',
      points: [
        [5, 0],
        [5, 50],
      ],
    },
    {
      type: 'parent-child',
      familyKey: 'fam:x',
      source: 'a',
      target: 'c',
      points: [
        [5, 0],
        [5, 80],
      ],
    },
  ];
  const { offsetXByFamily, offsetYByFamily } = assignParallelLanes(links);
  assert.equal(offsetXByFamily.size, 0);
  assert.equal(offsetYByFamily.size, 0);
});

test('production regression: local buses keep MIN_PARALLEL_GAP (p010/p003)', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const report = {};

  for (const centerId of ['p010', 'p003']) {
    const layout = layoutFamilyTree(people, { centerId, orientation: 'vertical' });
    const nodesById = new Map(layout.nodes.map((node) => [String(node.id), node]));
    const afterGaps = measureUnrelatedParallelGaps(layout.links, { nodesById });
    const afterRoute = routingMetrics(layout.links);

    hardParallelGate(people, layout, centerId);
    assert.equal(afterGaps.parallelGapViolations, 0, `${centerId} after violations`);
    assert.ok(
      afterGaps.minUnrelatedParallelGap >= MIN_PARALLEL_GAP - 1e-6,
      `${centerId} after min gap`,
    );
    // Local-bus model: non-overlapping family segments may share a lane.
    assert.equal(layout.meta.unrelatedFamiliesSharingBusSegment ?? 0, 0, `${centerId} shared bus`);
    assert.equal(layout.meta.familyBusLocalityViolations ?? 0, 0, `${centerId} bus locality`);

    const warm = layoutFamilyTree(people, { centerId, previousLayout: layout });
    assert.equal(coldWarmSignatureMismatch(layout, warm), 0);

    report[centerId] = {
      maxLaneCount: layout.meta.maxLaneCount,
      requiredLaneCountByGap: layout.meta.requiredLaneCountByGap,
      minUnrelatedParallelGap: afterGaps.minUnrelatedParallelGap,
      parallelGapViolations: afterGaps.parallelGapViolations,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      maxBends: afterRoute.maxBendsPerParentChild,
      routeLength: afterRoute.totalParentChildLength,
      routingBounds: afterRoute.routingBounds,
    };

    // Mobile-scale readability: at 0.95 scale, layout gap 16 → ~15.2 CSS px.
    const mobileScaledGap = afterGaps.minUnrelatedParallelGap * 0.95;
    assert.ok(mobileScaledGap >= 15, `${centerId} mobile scaled gap ${mobileScaledGap}`);
  }

  console.log('\nPARALLEL GAP LOCAL-BUS REPORT\n', JSON.stringify(report, null, 2));
});

test('all-centers parallel gap gate', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const rows = [];
  for (const person of people) {
    const centerId = person.id;
    const layout = layoutFamilyTree(people, { centerId });
    hardParallelGate(people, layout, centerId);
    const metrics = collectPlacementMetrics(people, layout, {
      households: layout.households,
      spouseSide: layout.meta.spouseSide,
    });
    rows.push({
      centerId,
      parallelGapViolations: metrics.parallelGapViolations,
      minUnrelatedParallelGap: metrics.minUnrelatedParallelGap,
      overlaps: metrics.overlaps,
      missingPC: metrics.missingPC,
      missingSpouse: metrics.missingSpouse,
      linksThroughCards: metrics.linksThroughCards,
      falseJunctions: metrics.falseJunctions,
      ambiguousSharedSegments: metrics.ambiguousSharedSegments,
      crossings: metrics.crossings,
      jumps: metrics.jumps,
    });
    assert.equal(metrics.parallelGapViolations, 0, `${centerId} violations`);
    assert.ok(metrics.minUnrelatedParallelGap >= MIN_PARALLEL_GAP, `${centerId} min gap`);
  }
  console.log('\nALL-CENTERS PARALLEL GAP\n', JSON.stringify(rows, null, 2));
});
