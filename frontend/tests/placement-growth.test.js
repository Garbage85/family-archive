import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFamilyTree } from '../src/layout/family-layout.js';
import {
  assertCrossingJumpParity,
  findAmbiguousSharedSegments,
  findCardOverlaps,
  findFalseJunctionsBetweenUnrelatedFamilies,
  findLinksThroughForeignCards,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  layoutRouteSignature,
} from '../src/layout/layout-validators.js';
import { findExteriorParentChildDetours } from '../src/layout/link-routing.js';
import {
  countBranchIntegrityViolations,
  countFamilySideViolations,
  extractPlacementSnapshot,
} from '../src/layout/placement-optimizer.js';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadGrowth() {
  return JSON.parse(
    await readFile(path.join(root, 'fixtures/structural-tree-growth.json'), 'utf8'),
  );
}

function hardGate(people, layout, label) {
  assert.equal(findCardOverlaps(layout.nodes).length, 0, `${label} overlaps`);
  assert.equal(findMissingVisibleParentChildLinks(people, layout).length, 0, `${label} missingPC`);
  assert.equal(findMissingVisibleSpouseLinks(people, layout).length, 0, `${label} missingSpouse`);
  assert.equal(findLinksThroughForeignCards(layout).length, 0, `${label} through`);
  assert.equal(findAmbiguousSharedSegments(layout).length, 0, `${label} ambiguous`);
  assert.equal(findFalseJunctionsBetweenUnrelatedFamilies(layout).length, 0, `${label} falseJ`);
  assert.equal(findExteriorParentChildDetours(layout).length, 0, `${label} exterior`);
  assert.equal(layout.meta.familySideViolations, 0, `${label} familySide`);
  assert.equal(layout.meta.branchIntegrityViolations, 0, `${label} branch`);
  assert.equal(layout.meta.hardViolations, 0, `${label} hard`);
  const parity = assertCrossingJumpParity(layout);
  assert.equal(parity.missedJumps, 0, `${label} missedJumps`);
  assert.equal(parity.falseJumps, 0, `${label} falseJumps`);
}

function householdSide(layout, personId) {
  return layout.households.find((household) => household.memberIds.includes(personId))?.side;
}

test('BEFORE_ADD keeps spouse sister on spouse-family side', async () => {
  const growth = await loadGrowth();
  const people = growth.BEFORE_ADD.people;
  const layout = layoutFamilyTree(people, { centerId: 'p010', returnCandidates: true });
  hardGate(people, layout, 'BEFORE_ADD');
  assert.equal(householdSide(layout, 'p011'), 'spouse');
  assert.equal(householdSide(layout, 'p006'), 'center');
  assert.equal(householdSide(layout, 'p007'), 'center');
  assert.ok(layout.nodes.some((node) => node.id === 'p011'));

  console.log(
    '\nBEFORE_ADD FAMILY BLOCKS\n',
    JSON.stringify(
      {
        spouseSide: layout.meta.spouseSide,
        crossings: layout.meta.crossings,
        jumps: layout.meta.jumps,
        householdOrdering: layout.meta.householdOrdering,
        branches: layout.meta.branches,
      },
      null,
      2,
    ),
  );
});

test('AFTER_ADD expands spouse sister branch without flipping existing sides', async () => {
  const growth = await loadGrowth();
  const beforePeople = growth.BEFORE_ADD.people;
  const afterPeople = growth.AFTER_ADD.people;
  const before = layoutFamilyTree(beforePeople, { centerId: 'p010' });
  const after = layoutFamilyTree(afterPeople, {
    centerId: 'p010',
    previousLayout: before,
    returnCandidates: true,
  });

  hardGate(afterPeople, after, 'AFTER_ADD');
  assert.equal(after.meta.existingHouseholdsSideChanges, 0);
  assert.equal(after.meta.existingBranchOrderInversions, 0);
  assert.equal(after.meta.unexpectedCoupleFlip, 0);

  assert.equal(householdSide(after, 'p011'), 'spouse');
  assert.equal(householdSide(after, 'p012'), 'spouse');
  assert.equal(householdSide(after, 'p013'), 'spouse');
  assert.equal(householdSide(after, 'p006'), 'center');
  assert.equal(householdSide(after, 'p007'), 'center');

  // New people land in the sister branch block.
  const sisterBranch = after.meta.branches.find((branch) => branch.anchorId === 'p011');
  assert.ok(sisterBranch, 'sister branch exists');
  assert.ok(sisterBranch.householdIds.some((id) => id.includes('p011')));
  assert.ok(sisterBranch.householdIds.some((id) => id.includes('p013') || id.includes('p012')));

  // Sister must not cross the couple core toward center siblings.
  const gen0 = after.meta.householdOrdering.find((row) => row.generation === 0);
  const sides = gen0.households.map((household) => household.side);
  const coreIndex = sides.indexOf('core');
  const sisterIndex = gen0.households.findIndex((household) =>
    household.memberIds.includes('p011'),
  );
  assert.ok(coreIndex >= 0 && sisterIndex >= 0);
  if (after.meta.spouseSide === 'left') {
    assert.ok(sisterIndex < coreIndex, 'sister stays left of core when spouse-left');
  } else {
    assert.ok(sisterIndex > coreIndex, 'sister stays right of core when spouse-right');
  }

  console.log(
    '\nAFTER_ADD FAMILY BLOCKS\n',
    JSON.stringify(
      {
        beforeSpouseSide: before.meta.spouseSide,
        afterSpouseSide: after.meta.spouseSide,
        newPersonIds: growth.AFTER_ADD.meta.newPersonIds,
        insertedIntoBranchAnchor: growth.AFTER_ADD.meta.insertedIntoBranchAnchor,
        beforeOrdering: before.meta.householdOrdering,
        afterOrdering: after.meta.householdOrdering,
        familySideViolations: after.meta.familySideViolations,
        branchOrderInversions: after.meta.existingBranchOrderInversions,
        sideChanges: after.meta.existingHouseholdsSideChanges,
        unexpectedCoupleFlip: after.meta.unexpectedCoupleFlip,
        crossingsBefore: before.meta.crossings,
        crossingsAfter: after.meta.crossings,
        jumpsBefore: before.meta.jumps,
        jumpsAfter: after.meta.jumps,
        candidates: after.meta.candidates,
      },
      null,
      2,
    ),
  );
});

test('cold reload AFTER_ADD is deterministic and keeps family-side integrity', async () => {
  const growth = await loadGrowth();
  const people = growth.AFTER_ADD.people;
  const first = layoutFamilyTree(people, { centerId: 'p010' });
  const second = layoutFamilyTree(people, { centerId: 'p010' });
  hardGate(people, first, 'cold1');
  hardGate(people, second, 'cold2');
  assert.equal(layoutRouteSignature(first), layoutRouteSignature(second));
  assert.equal(first.meta.spouseSide, second.meta.spouseSide);
  assert.deepEqual(first.meta.generationOrders, second.meta.generationOrders);
  assert.equal(householdSide(first, 'p011'), 'spouse');
});

test('growth stress: add relatives one-by-one without reshuffling family sides', async () => {
  // Build progressively from a tiny couple core using AFTER_ADD as the final pool.
  const growth = await loadGrowth();
  const finalPeople = growth.AFTER_ADD.people;
  const byId = new Map(finalPeople.map((person) => [person.id, person]));

  const steps = [
    ['p010', 'p003'],
    ['p001', 'p002'],
    ['p004', 'p005'],
    ['p006'],
    ['p007', 'p008', 'p009'],
    ['p011'],
    ['p012', 'p013'],
  ];

  let activeIds = new Set();
  let previous = null;
  const reports = [];

  for (const step of steps) {
    for (const id of step) activeIds.add(id);
    // Keep topology edges consistent: include only active people and filter rels.
    const people = [...activeIds].sort().map((id) => {
      const person = byId.get(id);
      return {
        id: person.id,
        data: { gender: person.data.gender },
        rels: {
          parents: (person.rels.parents || []).filter((item) => activeIds.has(item)),
          spouses: (person.rels.spouses || []).filter((item) => activeIds.has(item)),
          children: (person.rels.children || []).filter((item) => activeIds.has(item)),
        },
      };
    });

    const layout = layoutFamilyTree(people, {
      centerId: 'p010',
      previousLayout: previous,
      returnCandidates: true,
    });
    hardGate(people, layout, `step:${[...activeIds].join(',')}`);

    if (activeIds.has('p011')) {
      assert.equal(
        householdSide(layout, 'p011'),
        'spouse',
        'sister stays spouse-side while growing',
      );
    }
    if (activeIds.has('p006')) {
      assert.equal(householdSide(layout, 'p006'), 'center');
    }
    if (previous) {
      assert.equal(layout.meta.existingHouseholdsSideChanges, 0, 'no side changes while growing');
      assert.equal(layout.meta.unexpectedCoupleFlip, 0, 'no couple flip while growing');
    }

    // Cold reload canonical check at this step.
    const cold = layoutFamilyTree(people, { centerId: 'p010' });
    assert.equal(
      layoutRouteSignature(cold),
      layoutRouteSignature(layoutFamilyTree(people, { centerId: 'p010' })),
    );
    assert.equal(cold.meta.familySideViolations, 0);
    assert.equal(cold.meta.branchIntegrityViolations, 0);

    reports.push({
      activeCount: activeIds.size,
      spouseSide: layout.meta.spouseSide,
      crossings: layout.meta.crossings,
      jumps: layout.meta.jumps,
      sideChanges: layout.meta.existingHouseholdsSideChanges,
      inversions: layout.meta.existingBranchOrderInversions,
      flip: layout.meta.unexpectedCoupleFlip,
      sisterSide: activeIds.has('p011') ? householdSide(layout, 'p011') : null,
    });
    previous = layout;
  }

  console.log('\nGROWTH STRESS\n', JSON.stringify(reports, null, 2));
});

test('family-side hard constraint rejects cross-core interleaving', () => {
  const ordered = [
    { id: 'a', side: 'spouse' },
    { id: 'b', side: 'center' },
    { id: 'c', side: 'core' },
    { id: 'd', side: 'spouse' },
  ];
  assert.ok(countFamilySideViolations(ordered, 'left') > 0);
  const ok = [
    { id: 'a', side: 'spouse' },
    { id: 'c', side: 'core' },
    { id: 'd', side: 'center' },
  ];
  assert.equal(countFamilySideViolations(ok, 'left'), 0);
  assert.equal(countBranchIntegrityViolations(ok, new Map()), 0);
});

test('snapshot extract does not persist coordinates', async () => {
  const growth = await loadGrowth();
  const layout = layoutFamilyTree(growth.BEFORE_ADD.people, { centerId: 'p010' });
  const snapshot = extractPlacementSnapshot(layout);
  assert.equal('nodes' in snapshot, false);
  assert.ok(snapshot.spouseSide);
  assert.ok(snapshot.householdOrderByGeneration);
});
