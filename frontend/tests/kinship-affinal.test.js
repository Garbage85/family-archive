import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinshipDialogModel } from '../src/kinship-dialog.js';
import { buildKinshipIndex, computeAllKinships, computeKinship } from '../src/kinship-engine.js';

function person(id, gender, rels = {}) {
  return {
    id,
    data: { first_name: id, gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

function relation(people, centerId, targetId) {
  return computeKinship({ index: buildKinshipIndex(people), centerId, targetId });
}

function spouseParentsFamily(centerGender, spouseGender) {
  return [
    person('center', centerGender, { spouses: ['spouse'] }),
    person('spouse', spouseGender, {
      spouses: ['center'],
      parents: ['father', 'mother'],
    }),
    person('father', 'M', { children: ['spouse'] }),
    person('mother', 'F', { children: ['spouse'] }),
  ];
}

test('parents of a husband are свёкор and свекровь with one full spouse path', () => {
  const people = spouseParentsFamily('F', 'M');
  const father = relation(people, 'center', 'father');
  const mother = relation(people, 'center', 'mother');

  assert.deepEqual(
    [father.kind, father.label, father.description],
    ['affinal', 'свёкор', 'отец супруга'],
  );
  assert.deepEqual(
    [mother.kind, mother.label, mother.description],
    ['affinal', 'свекровь', 'мать супруга'],
  );
  assert.deepEqual(mother.primaryPath.personIds, ['center', 'spouse', 'mother']);
  assert.deepEqual(
    mother.primaryPath.steps.map((step) => step.type),
    ['spouse', 'parent'],
  );
});

test('Сапожникова Елена and Сапожникова Нина produce the required forward and reverse results', () => {
  const people = [
    {
      ...person('elena', 'F', { spouses: ['sergey'] }),
      data: { first_name: 'Елена', last_name: 'Сапожникова', gender: 'F' },
    },
    {
      ...person('sergey', 'M', { spouses: ['elena'], parents: ['nina'] }),
      data: { first_name: 'Сергей', last_name: 'Сапожников', gender: 'M' },
    },
    {
      ...person('nina', 'F', { children: ['sergey'] }),
      data: { first_name: 'Нина', last_name: 'Сапожникова', gender: 'F' },
    },
  ];
  const forward = relation(people, 'elena', 'nina');
  assert.deepEqual(
    [forward.kind, forward.label, forward.description],
    ['affinal', 'свекровь', 'мать супруга'],
  );
  assert.deepEqual(forward.primaryPath.personIds, ['elena', 'sergey', 'nina']);

  const reverse = relation(people, 'nina', 'elena');
  assert.deepEqual(
    [reverse.kind, reverse.label, reverse.description],
    ['affinal', 'невестка', 'супруга сына'],
  );
  assert.deepEqual(reverse.primaryPath.personIds, ['nina', 'sergey', 'elena']);
});

test('parents of a wife are тесть and тёща', () => {
  const people = spouseParentsFamily('M', 'F');
  assert.equal(relation(people, 'center', 'father').label, 'тесть');
  assert.equal(relation(people, 'center', 'father').description, 'отец супруги');
  assert.equal(relation(people, 'center', 'mother').label, 'тёща');
  assert.equal(relation(people, 'center', 'mother').description, 'мать супруги');
});

test('a wife is невестка relative to both parents of her husband', () => {
  const people = [
    person('father', 'M', { children: ['son'] }),
    person('mother', 'F', { children: ['son'] }),
    person('son', 'M', { parents: ['father', 'mother'], spouses: ['wife'] }),
    person('wife', 'F', { spouses: ['son'] }),
  ];
  for (const centerId of ['father', 'mother']) {
    const result = relation(people, centerId, 'wife');
    assert.deepEqual(
      [result.kind, result.label, result.description],
      ['affinal', 'невестка', 'супруга сына'],
    );
  }
});

test('a husband is зять relative to both parents of his wife', () => {
  const people = [
    person('father', 'M', { children: ['daughter'] }),
    person('mother', 'F', { children: ['daughter'] }),
    person('daughter', 'F', { parents: ['father', 'mother'], spouses: ['husband'] }),
    person('husband', 'M', { spouses: ['daughter'] }),
  ];
  for (const centerId of ['father', 'mother']) {
    const result = relation(people, centerId, 'husband');
    assert.deepEqual(
      [result.kind, result.label, result.description],
      ['affinal', 'зять', 'супруг дочери'],
    );
  }
});

test('spouses of parents are отчим and мачеха', () => {
  const people = [
    person('center', 'F', { parents: ['mother', 'father'] }),
    person('mother', 'F', { children: ['center'], spouses: ['stepfather'] }),
    person('father', 'M', { children: ['center'], spouses: ['stepmother'] }),
    person('stepfather', 'M', { spouses: ['mother'] }),
    person('stepmother', 'F', { spouses: ['father'] }),
  ];
  assert.deepEqual(
    [
      relation(people, 'center', 'stepfather').label,
      relation(people, 'center', 'stepmother').label,
    ],
    ['отчим', 'мачеха'],
  );
});

test('spouses of a sister and brother use only the supported close terms', () => {
  const people = [
    person('parent', 'F', { children: ['center', 'sister', 'brother'] }),
    person('center', 'F', { parents: ['parent'] }),
    person('sister', 'F', { parents: ['parent'], spouses: ['sister-husband'] }),
    person('brother', 'M', { parents: ['parent'], spouses: ['brother-wife'] }),
    person('sister-husband', 'M', { spouses: ['sister'] }),
    person('brother-wife', 'F', { spouses: ['brother'] }),
  ];
  assert.equal(relation(people, 'center', 'sister-husband').label, 'зять');
  assert.equal(relation(people, 'center', 'brother-wife').label, 'невестка');
});

test('a spouse who is already a parent remains a blood parent, not a stepparent', () => {
  const people = [
    person('center', 'F', { parents: ['mother', 'father'] }),
    person('mother', 'F', { children: ['center'], spouses: ['father'] }),
    person('father', 'M', { children: ['center'], spouses: ['mother'] }),
  ];
  const result = relation(people, 'center', 'father');
  assert.equal(result.kind, 'blood');
  assert.equal(result.label, 'отец');
});

test('blood and direct spouse relationships take priority over affinal candidates', () => {
  const bloodPeople = [
    person('parent', 'F', { children: ['center', 'sibling'] }),
    person('center', 'F', { parents: ['parent'], children: ['sibling-spouse'] }),
    person('sibling', 'M', { parents: ['parent'], spouses: ['sibling-spouse'] }),
    person('sibling-spouse', 'F', { parents: ['center'], spouses: ['sibling'] }),
  ];
  assert.equal(relation(bloodPeople, 'center', 'sibling-spouse').kind, 'blood');

  const spousePeople = [
    person('center', 'F', { children: ['child'], spouses: ['target'] }),
    person('child', 'M', { parents: ['center'], spouses: ['target'] }),
    person('target', 'F', { spouses: ['center', 'child'] }),
  ];
  assert.equal(relation(spousePeople, 'center', 'target').kind, 'spouse');
});

test('affinal paths contain exactly one spouse edge and dialog labels that edge by gender', () => {
  const people = spouseParentsFamily('F', 'M');
  const result = relation(people, 'center', 'mother');
  assert.equal(result.primaryPath.steps.filter((step) => step.type === 'spouse').length, 1);
  const dialog = buildKinshipDialogModel(people, result);
  assert.equal(dialog.label, 'Свекровь (мать супруга)');
  assert.deepEqual(
    dialog.primaryPath.steps.map((step) => step.label),
    ['супруг', 'мать'],
  );
});

test('two spouse edges, parents of a child spouse, and distant marriage remain unrelated', () => {
  const people = [
    person('center', 'F', { spouses: ['first-spouse'], children: ['child'] }),
    person('first-spouse', 'M', { spouses: ['center', 'second-spouse'] }),
    person('second-spouse', 'F', { spouses: ['first-spouse'] }),
    person('child', 'M', { parents: ['center'], spouses: ['child-spouse'] }),
    person('child-spouse', 'F', { spouses: ['child'], parents: ['child-spouse-parent'] }),
    person('child-spouse-parent', 'M', { children: ['child-spouse'] }),
    person('distant', 'M'),
  ];
  assert.equal(relation(people, 'center', 'second-spouse').kind, 'unrelated');
  assert.equal(relation(people, 'center', 'child-spouse-parent').kind, 'unrelated');
  assert.equal(relation(people, 'center', 'distant').kind, 'unrelated');
});

test('affinal computation does not mutate people or persist derived terms in trees.data', () => {
  const people = spouseParentsFamily('F', 'M');
  const before = structuredClone(people);
  const { kinships } = computeAllKinships({ people, centerId: 'center' });
  assert.equal(kinships.get('mother').kind, 'affinal');
  assert.deepEqual(people, before);
  const persisted = JSON.stringify(people);
  assert.equal(persisted.includes('affinal'), false);
  assert.equal(persisted.includes('свекровь'), false);
});
