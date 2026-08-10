import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  applyHouseholdMemberOrder,
  householdCenters,
  memberOrderFromPositions,
  optimizeHouseholdOrientations,
  scoreHouseholdOrientation,
} from '../src/layout/household-orientation.js';
import {
  coldWarmSignatureMismatch,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import {
  coldWarmOrientationMismatch,
  collectPlacementMetrics,
  countInvalidHouseholdOrientations,
} from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function hardOrientationGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(layout.meta.familySideViolations ?? 0, 0, `${label} familySide`);
  assert.equal(layout.meta.branchIntegrityViolations ?? 0, 0, `${label} branch`);
  assert.equal(layout.meta.hardViolations ?? 0, 0, `${label} hard`);
  assert.equal(layout.meta.orientationOscillations ?? 0, 0, `${label} osc`);
  assert.equal(layout.meta.invalidHouseholdOrientation ?? 0, 0, `${label} invalidOrient`);
  assert.equal(countInvalidHouseholdOrientations(layout), 0, `${label} countInvalid`);
  const metrics = collectPlacementMetrics(people, layout, {
    expectedVisibleIds: layout.nodes.map((node) => node.id),
    households: layout.households,
    spouseSide: layout.meta.spouseSide,
  });
  assert.equal(metrics.hardViolations, 0, `${label} metrics.hard`);
  assert.equal(metrics.invalidHouseholdOrientation, 0, `${label} metrics.invalidOrient`);
  return metrics;
}

function householdByMembers(layout, memberIds) {
  const want = new Set(memberIds.map(String));
  return layout.households.find((household) => {
    const have = new Set((household.memberIds || []).map(String));
    if (have.size !== want.size) return false;
    for (const id of want) if (!have.has(id)) return false;
    return true;
  });
}

test('local mirror keeps household [x0,x1] fixed (no pin)', () => {
  const household = {
    id: 'hh:a+b',
    memberIds: ['a', 'b'],
    x0: -92,
    x1: 328,
    generation: 0,
    size: 2,
  };
  const positions = new Map([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 236, y: 0 }],
  ]);
  const peopleById = new Map([
    [
      'a',
      { id: 'a', data: { gender: 'M' }, rels: { spouses: ['b'], children: ['c'], parents: [] } },
    ],
    [
      'b',
      { id: 'b', data: { gender: 'F' }, rels: { spouses: ['a'], children: ['c'], parents: ['p'] } },
    ],
    [
      'c',
      { id: 'c', data: { gender: 'M' }, rels: { parents: ['a', 'b'], spouses: [], children: [] } },
    ],
    ['p', { id: 'p', data: { gender: 'F' }, rels: { children: ['b'], spouses: [], parents: [] } }],
  ]);
  positions.set('c', { x: -200, y: 200 });
  positions.set('p', { x: 400, y: -200 });

  const beforeCenter = (household.x0 + household.x1) / 2;
  const result = optimizeHouseholdOrientations({
    nodePositions: positions,
    households: [household],
    peopleById,
    centerId: null,
  });
  assert.equal(result.households[0].x0, household.x0);
  assert.equal(result.households[0].x1, household.x1);
  const afterCenter = (result.households[0].x0 + result.households[0].x1) / 2;
  assert.equal(afterCenter, beforeCenter);
});

test('live 3-gen: ORIGINAL vs MIRRORED parent pair — optimizer picks lower cost', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const layout = layoutFamilyTree(people, { centerId: 'p010', returnCandidates: true });
  const metrics = hardOrientationGate(people, layout, 'p010');

  const gens = [...new Set(layout.households.map((household) => household.generation))].sort(
    (a, b) => a - b,
  );
  assert.ok(gens.length >= 3, `expected ≥3 generations, got ${gens.join(',')}`);

  const parentHh = householdByMembers(layout, ['p001', 'p002']);
  assert.ok(parentHh, 'parent household p001+p002 visible');

  const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
  const nodePositions = new Map(layout.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const peopleById = new Map(people.map((person) => [String(person.id), person]));

  // Reconstruct ORIGINAL = reverse of chosen order (the live QA flip candidate).
  const chosen = parentHh.memberIds.map(String);
  const original = [...chosen].reverse();
  assert.notEqual(chosen.join('|'), original.join('|'));

  // Score both orientations inside the SAME fixed household extent.
  const hh = {
    ...parentHh,
    x0: parentHh.x0,
    x1: parentHh.x1,
    memberIds: [...chosen],
  };
  // Reset slots to chosen, then score original vs mirrored without moving x0/x1.
  applyHouseholdMemberOrder(nodePositions, hh, chosen, {});
  const scoreChosen = scoreHouseholdOrientation({
    order: chosen,
    household: hh,
    nodePositions,
    peopleById,
    households: layout.households,
  });
  const scoreOriginal = scoreHouseholdOrientation({
    order: original,
    household: hh,
    nodePositions,
    peopleById,
    households: layout.households,
  });

  assert.ok(
    scoreChosen.total + 1e-6 < scoreOriginal.total,
    `optimizer order ${chosen.join('|')} cost=${scoreChosen.total} should beat ORIGINAL ${original.join('|')} cost=${scoreOriginal.total}`,
  );

  // Live regression: the historically bad order was mother|father (p002|p001)
  // when maternal ancestry sits on one side — mirrored father|mother is better.
  const badOrder = ['p002', 'p001'];
  const goodOrder = ['p001', 'p002'];
  applyHouseholdMemberOrder(nodePositions, hh, goodOrder, {});
  const bad = scoreHouseholdOrientation({
    order: badOrder,
    household: hh,
    nodePositions,
    peopleById,
    households: layout.households,
  });
  const good = scoreHouseholdOrientation({
    order: goodOrder,
    household: hh,
    nodePositions,
    peopleById,
    households: layout.households,
  });
  assert.ok(
    good.total + 1e-6 < bad.total,
    `MIRRORED ${goodOrder.join('|')} (${good.total}) must beat ORIGINAL ${badOrder.join('|')} (${bad.total})`,
  );
  assert.deepEqual(chosen, goodOrder, 'layout must select MIRRORED parent orientation');

  // Household block did not relocate relative to siblings: center matches extent midpoint.
  const memberXs = chosen.map((id) => nodesById.get(id).x);
  const memberCenter = (Math.min(...memberXs) + Math.max(...memberXs)) / 2;
  const extentCenter = (parentHh.x0 + parentHh.x1) / 2;
  assert.ok(
    Math.abs(memberCenter - extentCenter) < 1e-3,
    `household center moved: member=${memberCenter} extent=${extentCenter}`,
  );

  assert.ok(layout.meta.mirroredHouseholds >= 1, 'expected at least one mirrored household');
  assert.ok(
    layout.meta.orientationCostAfter <= layout.meta.orientationCostBefore + 1e-6,
    'orientation cost should not worsen',
  );

  console.log(
    JSON.stringify(
      {
        liveBeforeAfter: {
          householdId: parentHh.id,
          ORIGINAL: badOrder,
          MIRRORED: goodOrder,
          chosen,
          householdCenter: memberCenter,
          extentCenter,
          originalUpstream: bad.upstream,
          mirroredUpstream: good.upstream,
          originalDownstream: bad.downstream,
          mirroredDownstream: good.downstream,
          originalTotal: bad.total,
          mirroredTotal: good.total,
          orientationCostBefore: layout.meta.orientationCostBefore,
          orientationCostAfter: layout.meta.orientationCostAfter,
          mirroredHouseholds: layout.meta.mirroredHouseholds,
          familyAlignmentErrorTotal: metrics.familyAlignmentErrorTotal,
          crossings: metrics.crossings,
          jumps: metrics.jumps,
          bends: metrics.bends,
          routeLength: metrics.routeLength,
        },
      },
      null,
      2,
    ),
  );
});

test('all-centers orientation gate + mirrored counts', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const centerIds = Array.from(
    { length: fixture.personCount },
    (_, index) => `p${String(index + 1).padStart(3, '0')}`,
  );

  const rows = [];
  for (const centerId of centerIds) {
    const layout = layoutFamilyTree(people, { centerId });
    hardOrientationGate(people, layout, centerId);
    const cold = layoutFamilyTree(people, { centerId });
    const warm = layoutFamilyTree(people, { centerId, previousLayout: cold });
    assert.equal(coldWarmSignatureMismatch(cold, warm), 0, `${centerId} sig`);
    assert.equal(coldWarmOrientationMismatch(cold, warm), 0, `${centerId} orient`);
    assert.equal(layoutRouteSignature(cold), layoutRouteSignature(warm), `${centerId} routes`);

    const again = layoutFamilyTree(people, { centerId });
    assert.deepEqual(
      cold.households.map((household) => household.memberIds),
      again.households.map((household) => household.memberIds),
      `${centerId} deterministic orientation`,
    );

    rows.push({
      centerId,
      mirroredHouseholds: layout.meta.mirroredHouseholds || 0,
      orientationCostBefore: Math.round(layout.meta.orientationCostBefore || 0),
      orientationCostAfter: Math.round(layout.meta.orientationCostAfter || 0),
      hardViolations: layout.meta.hardViolations || 0,
    });
  }

  console.log(JSON.stringify({ allCentersOrientation: rows }, null, 2));
  assert.ok(rows.every((row) => row.hardViolations === 0));
  assert.ok(
    rows.some((row) => row.mirroredHouseholds > 0),
    'some centers mirror households',
  );
});

test('orientation cold/warm + perf sanity', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const cold = layoutFamilyTree(people, { centerId: 'p010' });
  const warm = layoutFamilyTree(people, { centerId: 'p010', previousLayout: cold });
  assert.equal(coldWarmOrientationMismatch(cold, warm), 0);
  assert.equal(cold.meta.orientationOscillations, 0);
  assert.equal(warm.meta.orientationOscillations, 0);

  const started = Date.now();
  for (let i = 0; i < 25; i += 1) layoutFamilyTree(people, { centerId: 'p010' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `25× p010 layout took ${elapsed}ms`);
});

test('memberOrderFromPositions + householdCenters helpers', () => {
  const household = { id: 'h', memberIds: ['b', 'a'], x0: 0, x1: 420 };
  const positions = new Map([
    ['a', { x: 92, y: 0 }],
    ['b', { x: 328, y: 0 }],
  ]);
  assert.deepEqual(memberOrderFromPositions(household, positions), ['a', 'b']);
  assert.equal(householdCenters([household], positions).h, 210);
});
