import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree, selectVisiblePeople } from '../src/layout/family-layout.js';
import {
  assertCrossingJumpParity,
  coldWarmSignatureMismatch,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  findLostVisiblePeople,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  layoutGeometrySignature,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import { findExteriorParentChildDetours } from '../src/layout/link-routing.js';
import { collectPlacementMetrics } from '../src/layout/placement-metrics.js';
import { loadStructuralPeople } from '../src/layout/structural-fixture.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadProduction() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree.topology.json'), 'utf8'),
  );
}

function hardGate(people, layout, label) {
  const expected = selectVisiblePeople(people, layout.meta.centerId).map((person) => person.id);
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findLostVisiblePeople(expected, layout).length, 0, `${label} lostNodes`);
  assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0, `${label} missingPC`);
  assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0, `${label} missingSpouse`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findExteriorParentChildDetours(layout).length, 0, `${label} exterior`);
  assert.equal(layout.meta.familySideViolations, 0, `${label} familySide`);
  assert.equal(layout.meta.branchIntegrityViolations, 0, `${label} branch`);
  assert.equal(
    layout.meta.parentSiblingBranchSideViolations,
    0,
    `${label} parentSiblingBranchSide`,
  );
  assert.equal(layout.meta.parallelLaneOverlap, 0, `${label} parallelLaneOverlap`);
  assert.equal(layout.meta.hardViolations, 0, `${label} hard`);
  const parity = assertCrossingJumpParity(layout);
  assert.equal(parity.missedJumps, 0, `${label} missedJumps`);
  assert.equal(parity.falseJumps, 0, `${label} falseJumps`);
}

function householdSide(layout, personId) {
  return layout.households.find((household) => household.memberIds.includes(personId))?.side;
}

test('cold === warm for identical topology (previousLayout ignored for geometry)', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const centerId = fixture.meta.defaultCenterId;

  const cold = layoutFamilyTree(people, { centerId });
  const warm = layoutFamilyTree(people, { centerId, previousLayout: cold });
  hardGate(people, cold, 'cold');
  hardGate(people, warm, 'warm');

  const mismatch = coldWarmSignatureMismatch(cold, warm);
  assert.equal(mismatch, 0, 'coldWarmSignatureMismatch');
  assert.equal(layoutGeometrySignature(cold), layoutGeometrySignature(warm));
  assert.equal(layoutRouteSignature(cold), layoutRouteSignature(warm));
  assert.equal(cold.meta.spouseSide, warm.meta.spouseSide);
  assert.deepEqual(cold.meta.generationOrders, warm.meta.generationOrders);

  console.log(
    '\nCOLD/WARM SIGNATURES\n',
    JSON.stringify(
      {
        spouseSide: cold.meta.spouseSide,
        coldSignatureHash: layoutGeometrySignature(cold).length,
        warmSignatureHash: layoutGeometrySignature(warm).length,
        mismatch,
        crossings: cold.meta.crossings,
        jumps: cold.meta.jumps,
        parallelLaneOverlap: cold.meta.parallelLaneOverlap,
      },
      null,
      2,
    ),
  );
});

test('determinism stress: 20 identical layouts share one signature', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const centerId = fixture.meta.defaultCenterId;
  const signatures = [];
  for (let i = 0; i < 20; i += 1) {
    const layout = layoutFamilyTree(people, { centerId });
    signatures.push(layoutGeometrySignature(layout));
  }
  assert.equal(new Set(signatures).size, 1);
});

test('add/remove temporary unrelated node restores original signature', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const centerId = fixture.meta.defaultCenterId;
  const baseline = layoutFamilyTree(people, { centerId });
  const baselineSig = layoutGeometrySignature(baseline);

  const tempId = 'p999';
  const withTemp = [
    ...people,
    {
      id: tempId,
      data: { gender: 'M' },
      rels: { parents: [], spouses: [], children: [] },
    },
  ];
  // Unrelated isolate is invisible from center — topology for visible set unchanged.
  const withTempLayout = layoutFamilyTree(withTemp, { centerId, previousLayout: baseline });
  assert.equal(layoutGeometrySignature(withTempLayout), baselineSig);

  // Attach temp as child of couple-core center so it enters the visible set.
  const attached = structuredClone(people);
  const host = attached.find((person) => person.id === centerId);
  host.rels.children = [...(host.rels.children || []), tempId];
  const spouseId = (host.rels.spouses || [])[0];
  if (spouseId) {
    const spouse = attached.find((person) => person.id === spouseId);
    spouse.rels.children = [...(spouse.rels.children || []), tempId];
  }
  attached.push({
    id: tempId,
    data: { gender: 'M' },
    rels: { parents: [centerId, spouseId].filter(Boolean), spouses: [], children: [] },
  });
  const grown = layoutFamilyTree(attached, { centerId, previousLayout: baseline });
  hardGate(attached, grown, 'with-temp-child');
  assert.ok(
    grown.nodes.some((node) => node.id === tempId),
    'temp child visible',
  );
  assert.notEqual(layoutGeometrySignature(grown), baselineSig);

  const restored = layoutFamilyTree(people, { centerId, previousLayout: grown });
  hardGate(people, restored, 'restored');
  assert.equal(coldWarmSignatureMismatch(baseline, restored), 0);
  assert.equal(layoutGeometrySignature(restored), baselineSig);
});

test('maternal aunt (sister of mother) is visible and stays on center-family side', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const auntId = fixture.meta.parentSiblingBranch.maternalAuntId;
  const auntSpouseId = fixture.meta.parentSiblingBranch.maternalAuntSpouseId;
  const motherId = fixture.meta.parentSiblingBranch.motherId;

  for (const centerId of ['p010', 'p003']) {
    // Relative to couple core: mother's sister stays on the side of p010's mother.
    // From p010 that is center-side; from spouse p003 that is spouse-side.
    const expectedFamilySide = centerId === 'p010' ? 'center' : 'spouse';
    const visible = selectVisiblePeople(people, centerId).map((person) => person.id);
    assert.ok(visible.includes(auntId), `${centerId}: aunt visible`);
    assert.ok(visible.includes(auntSpouseId), `${centerId}: aunt spouse via closure`);
    assert.ok(visible.includes(motherId), `${centerId}: mother visible`);

    // Scope limit: do not pull cousins / children of aunt (none) or parents of aunt spouse.
    assert.equal(visible.includes('p999'), false);

    const layout = layoutFamilyTree(people, { centerId, returnCandidates: true });
    hardGate(people, layout, `aunt:${centerId}`);

    const auntSide = householdSide(layout, auntId);
    const motherSide = householdSide(layout, motherId);
    assert.equal(auntSide, expectedFamilySide, `${centerId}: aunt on ${expectedFamilySide} side`);
    assert.equal(
      motherSide,
      expectedFamilySide,
      `${centerId}: mother on ${expectedFamilySide} side`,
    );
    assert.equal(householdSide(layout, auntSpouseId), expectedFamilySide);

    const auntBranch = layout.meta.branches.find(
      (branch) => branch.kind === 'parent-sibling' && branch.anchorId === auntId,
    );
    assert.ok(auntBranch, `${centerId}: parent-sibling branch for aunt`);
    assert.equal(auntBranch.side, expectedFamilySide);

    // Aunt shares the parent generation with mother; no couple-core on that row.
    // Hard: family-side blocks contiguous; aunt stays with mother.
    const auntRow = layout.meta.householdOrdering.find((row) =>
      row.households.some((household) => household.memberIds.includes(auntId)),
    );
    assert.ok(auntRow, `${centerId}: aunt generation row`);
    const sides = auntRow.households.map((household) => household.side);
    const auntIndex = auntRow.households.findIndex((household) =>
      household.memberIds.includes(auntId),
    );
    const motherIndex = auntRow.households.findIndex((household) =>
      household.memberIds.includes(motherId),
    );
    assert.ok(auntIndex >= 0 && motherIndex >= 0);
    const nonNeutral = sides.filter((side) => side === 'spouse' || side === 'center');
    let flips = 0;
    let last = null;
    for (const side of nonNeutral) {
      if (last && last !== side) flips += 1;
      last = side;
    }
    assert.ok(flips <= 1, `${centerId}: aunt row family sides contiguous`);
    if (layout.meta.spouseSide === 'left') {
      const firstCenter = sides.indexOf('center');
      const lastSpouse = sides.lastIndexOf('spouse');
      if (firstCenter >= 0 && lastSpouse >= 0) {
        assert.ok(lastSpouse < firstCenter, 'spouse left of center on aunt row');
      }
    } else {
      const firstSpouse = sides.indexOf('spouse');
      const lastCenter = sides.lastIndexOf('center');
      if (firstSpouse >= 0 && lastCenter >= 0) {
        assert.ok(lastCenter < firstSpouse, 'center left of spouse on aunt row');
      }
    }
    assert.equal(sides[auntIndex], expectedFamilySide);
    assert.equal(layout.meta.parentSiblingBranchSideViolations, 0);

    console.log(
      `\nPARENT-SIBLING BRANCH (${centerId})\n`,
      JSON.stringify(
        {
          visibleIds: visible,
          auntId,
          auntSpouseId,
          auntSide,
          auntBranch,
          spouseSide: layout.meta.spouseSide,
          parentSiblingBranchSideViolations: layout.meta.parentSiblingBranchSideViolations,
          crossings: layout.meta.crossings,
          jumps: layout.meta.jumps,
        },
        null,
        2,
      ),
    );
  }
});

test('all-centers gate includes parent-sibling + cold/warm + lane overlap', async () => {
  const fixture = await loadProduction();
  const people = loadStructuralPeople(fixture);
  const centerIds = people.map((person) => person.id);
  const rows = [];

  for (const centerId of centerIds) {
    const cold = layoutFamilyTree(people, { centerId });
    const warm = layoutFamilyTree(people, { centerId, previousLayout: cold });
    hardGate(people, cold, centerId);
    const mismatch = coldWarmSignatureMismatch(cold, warm);
    assert.equal(mismatch, 0, `${centerId} coldWarmSignatureMismatch`);

    const metrics = collectPlacementMetrics(people, cold, {
      expectedVisibleIds: selectVisiblePeople(people, centerId).map((person) => person.id),
      households: cold.households,
      spouseSide: cold.meta.spouseSide,
      householdToBranch: new Map(
        (cold.meta.branches || []).flatMap((branch) =>
          (branch.householdIds || []).map((id) => [id, branch]),
        ),
      ),
    });

    rows.push({
      centerId,
      displayedCount: cold.nodes.length,
      overlaps: metrics.overlaps,
      lostNodes: metrics.lostNodes,
      missingPC: metrics.missingPC,
      missingSpouse: metrics.missingSpouse,
      familySideViolations: metrics.familySideViolations,
      branchIntegrityViolations: metrics.branchIntegrityViolations,
      parentSiblingBranchSideViolations: metrics.parentSiblingBranchSideViolations,
      linksThroughCards: metrics.linksThroughCards,
      ambiguousSharedSegments: metrics.ambiguousSharedSegments,
      falseJunctions: metrics.falseJunctions,
      parallelLaneOverlap: metrics.parallelLaneOverlap,
      coldWarmSignatureMismatch: mismatch,
      crossings: metrics.crossings,
      jumps: metrics.jumps,
      routeLength: metrics.routeLength,
      bends: metrics.bends,
      hardViolations: metrics.hardViolations,
    });

    assert.equal(metrics.hardViolations, 0, `${centerId} hard`);
    assert.equal(metrics.parentSiblingBranchSideViolations, 0, `${centerId} parentSibling`);
    assert.equal(metrics.parallelLaneOverlap, 0, `${centerId} lanes`);
  }

  console.log('\nALL-CENTERS GATE (parent-sibling / cold-warm)\n', JSON.stringify(rows, null, 2));
});
