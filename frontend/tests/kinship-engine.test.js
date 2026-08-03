import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinshipIndex, computeAllKinships, computeKinship } from '../src/kinship-engine.js';
import { formatKinshipLabel } from '../src/kinship-formatter-ru.js';

class Family {
  constructor() {
    this.people = [];
  }

  person(id, gender = '') {
    const person = {
      id,
      data: { first_name: id, gender },
      rels: { parents: [], children: [], spouses: [] },
    };
    this.people.push(person);
    return this;
  }

  get(id) {
    return this.people.find((person) => person.id === id);
  }

  parent(parentId, childId, { reciprocal = true } = {}) {
    this.get(childId).rels.parents.push(parentId);
    if (reciprocal) this.get(parentId).rels.children.push(childId);
    return this;
  }

  childOnly(parentId, childId) {
    this.get(parentId).rels.children.push(childId);
    return this;
  }

  spouse(leftId, rightId, { reciprocal = true } = {}) {
    this.get(leftId).rels.spouses.push(rightId);
    if (reciprocal) this.get(rightId).rels.spouses.push(leftId);
    return this;
  }

  relation(centerId, targetId, options = {}) {
    return computeKinship({
      index: buildKinshipIndex(this.people),
      centerId,
      targetId,
      ...options,
    });
  }
}

function directFamily() {
  const family = new Family();
  for (const [id, gender] of [
    ['center', 'M'],
    ['father', 'M'],
    ['mother', 'F'],
    ['grandfather', 'M'],
    ['grandmother', 'F'],
    ['great-grandfather', 'M'],
    ['son', 'M'],
    ['daughter', 'F'],
    ['grandson', 'M'],
    ['granddaughter', 'F'],
    ['great-grandson', 'M'],
  ]) {
    family.person(id, gender);
  }
  family
    .parent('father', 'center')
    .parent('mother', 'center')
    .parent('grandfather', 'father')
    .parent('grandmother', 'father')
    .parent('great-grandfather', 'grandfather')
    .parent('center', 'son')
    .parent('center', 'daughter')
    .parent('son', 'grandson')
    .parent('daughter', 'granddaughter')
    .parent('grandson', 'great-grandson');
  return family;
}

test('formats self and direct ancestors and descendants', () => {
  const family = directFamily();
  const expected = {
    center: 'Центр дерева',
    father: 'отец',
    mother: 'мать',
    grandfather: 'дедушка',
    grandmother: 'бабушка',
    'great-grandfather': 'прадедушка',
    son: 'сын',
    daughter: 'дочь',
    grandson: 'внук',
    granddaughter: 'внучка',
    'great-grandson': 'правнук',
  };
  for (const [targetId, label] of Object.entries(expected)) {
    assert.equal(family.relation('center', targetId).label, label, targetId);
  }
});

function lateralFamily() {
  const family = new Family();
  for (const [id, gender] of [
    ['center', 'M'],
    ['sibling-m', 'M'],
    ['sibling-f', 'F'],
    ['parent', 'M'],
    ['uncle', 'M'],
    ['aunt', 'F'],
    ['grandparent', 'M'],
    ['nephew', 'M'],
    ['niece', 'F'],
    ['grand-nephew', 'M'],
    ['grand-niece', 'F'],
  ])
    family.person(id, gender);
  family
    .parent('parent', 'center')
    .parent('parent', 'sibling-m')
    .parent('parent', 'sibling-f')
    .parent('grandparent', 'parent')
    .parent('grandparent', 'uncle')
    .parent('grandparent', 'aunt')
    .parent('sibling-m', 'nephew')
    .parent('sibling-f', 'niece')
    .parent('nephew', 'grand-nephew')
    .parent('niece', 'grand-niece');
  return family;
}

test('formats sibling, uncle, aunt and nephew branches', () => {
  const family = lateralFamily();
  for (const [targetId, label] of Object.entries({
    'sibling-m': 'брат',
    'sibling-f': 'сестра',
    uncle: 'дядя',
    aunt: 'тётя',
    nephew: 'племянник',
    niece: 'племянница',
    'grand-nephew': 'внучатый племянник',
    'grand-niece': 'внучатая племянница',
  })) {
    assert.equal(family.relation('center', targetId).label, label, targetId);
  }
});

function cousins(a, b, targetGender = 'M') {
  const family = new Family();
  family.person('center', 'F').person('target', targetGender).person('ancestor', 'M');
  let previous = 'center';
  for (let distance = 1; distance < a; distance += 1) {
    const id = `center-up-${distance}`;
    family.person(id, 'M').parent(id, previous);
    previous = id;
  }
  family.parent('ancestor', previous);
  previous = 'target';
  for (let distance = 1; distance < b; distance += 1) {
    const id = `target-up-${distance}`;
    family.person(id, 'F').parent(id, previous);
    previous = id;
  }
  family.parent('ancestor', previous);
  return family.relation('center', 'target');
}

test('formats cousin degrees and lateral generation gaps', () => {
  assert.equal(cousins(2, 2, 'M').label, 'двоюродный брат');
  assert.equal(cousins(2, 2, 'F').label, 'двоюродная сестра');
  assert.equal(cousins(3, 3, 'M').label, 'троюродный брат');
  assert.equal(cousins(3, 2, 'M').label, 'двоюродный дядя');
  assert.equal(cousins(3, 2, 'F').label, 'двоюродная тётя');
  assert.equal(cousins(3, 1, 'M').label, 'двоюродный дед');
  assert.equal(cousins(3, 1, 'F').label, 'двоюродная бабушка');
  assert.equal(cousins(10, 9, 'M').label, 'девятиюродный дядя');
  assert.equal(cousins(10, 9, 'F').label, 'девятиюродная тётя');
  assert.equal(cousins(2, 3, 'M').label, 'двоюродный племянник');
  assert.equal(cousins(2, 3, 'F').label, 'двоюродная племянница');
});

test('uses word cousin prefixes through ten and one numeric fallback', () => {
  const prefixes = {
    2: 'двоюродный',
    3: 'троюродный',
    4: 'четвероюродный',
    5: 'пятиюродный',
    6: 'шестиюродный',
    7: 'семиюродный',
    8: 'восьмиюродный',
    9: 'девятиюродный',
    10: 'десятиюродный',
  };
  for (const [degree, prefix] of Object.entries(prefixes)) {
    assert.equal(
      formatKinshipLabel({
        kind: 'blood',
        relationType: 'lateral',
        gender: 'M',
        a: Number(degree),
        b: Number(degree),
      }),
      `${prefix} брат`,
    );
  }
  assert.equal(
    formatKinshipLabel({ kind: 'blood', relationType: 'lateral', gender: 'F', a: 11, b: 11 }),
    '11-юродная сестра',
  );
});

test('formats direct spouses and prioritizes a blood relationship', () => {
  const family = new Family();
  family
    .person('center', 'F')
    .person('husband', 'M')
    .person('wife', 'F')
    .person('unknown')
    .person('sibling', 'M')
    .person('parent', 'F');
  family
    .spouse('center', 'husband')
    .spouse('center', 'wife')
    .spouse('center', 'unknown')
    .parent('parent', 'center')
    .parent('parent', 'sibling')
    .spouse('center', 'sibling');
  assert.equal(family.relation('center', 'husband').label, 'супруг');
  assert.equal(family.relation('center', 'wife').label, 'супруга');
  assert.equal(family.relation('center', 'unknown').label, 'супруг(а)');
  const sibling = family.relation('center', 'sibling');
  assert.equal(sibling.kind, 'blood');
  assert.equal(sibling.label, 'брат');
  assert.deepEqual(sibling.additionalRelations, [{ kind: 'spouse', label: 'супруг' }]);
});

test('two common parents collapse into one semantic relationship', () => {
  const family = new Family();
  family.person('center').person('sibling', 'F').person('p1').person('p2');
  family
    .parent('p1', 'center')
    .parent('p1', 'sibling')
    .parent('p2', 'center')
    .parent('p2', 'sibling');
  const relation = family.relation('center', 'sibling');
  assert.equal(relation.label, 'сестра');
  assert.deepEqual(relation.commonAncestorIds, ['p1', 'p2']);
  assert.equal(relation.alternativePaths.length, 0);
});

test('an ancestor above the nearest common ancestor is not a duplicate path', () => {
  const family = new Family();
  for (const id of ['center', 'target', 'cp', 'tp', 'ancestor', 'older-ancestor'])
    family.person(id);
  family
    .parent('cp', 'center')
    .parent('tp', 'target')
    .parent('ancestor', 'cp')
    .parent('ancestor', 'tp')
    .parent('older-ancestor', 'ancestor');
  const relation = family.relation('center', 'target');
  assert.equal(relation.label, 'двоюродный сиблинг');
  assert.equal(relation.alternativePaths.length, 0);
});

test('different blood lines produce deterministic alternative paths', () => {
  const family = new Family();
  for (const id of ['center', 'target', 'cp1', 'cp2', 'tp1', 'tp2', 'a1', 'a2']) {
    family.person(id);
  }
  family
    .parent('cp1', 'center')
    .parent('cp2', 'center')
    .parent('tp1', 'target')
    .parent('tp2', 'target')
    .parent('a1', 'cp1')
    .parent('a1', 'tp1')
    .parent('a2', 'cp2')
    .parent('a2', 'tp2');
  const relation = family.relation('center', 'target');
  assert.equal(relation.label, 'двоюродный сиблинг');
  assert.equal(relation.alternativePaths.length, 1);
  assert.notDeepEqual(relation.primaryPath.personIds, relation.alternativePaths[0].personIds);
});

test('normalizes one-sided and duplicate links without mutating input', () => {
  const family = new Family();
  family.person('parent', 'M').person('child', 'F').person('spouse', 'M');
  family.childOnly('parent', 'child').spouse('child', 'spouse', { reciprocal: false });
  family.get('parent').rels.children.push('child');
  family.get('child').rels.spouses.push('spouse');
  const before = structuredClone(family.people);
  const index = buildKinshipIndex(family.people);
  assert.deepEqual([...index.parents.get('child')], ['parent']);
  assert.deepEqual([...index.spouses.get('spouse')], ['child']);
  assert.deepEqual(family.people, before);
});

test('missing people, cycles and disconnected components do not break traversal', () => {
  const family = new Family();
  family.person('a').person('b').person('disconnected');
  family.parent('a', 'b').parent('b', 'a');
  family.get('a').rels.parents.push('missing');
  const index = buildKinshipIndex(family.people);
  assert.ok(index.warnings.some((warning) => warning.includes('missing')));
  assert.ok(index.warnings.some((warning) => warning.includes('цикл')));
  assert.equal(
    computeKinship({ index, centerId: 'a', targetId: 'disconnected' }).kind,
    'unrelated',
  );
  assert.equal(computeKinship({ index, centerId: 'missing', targetId: 'a' }).kind, 'unrelated');
});

test('self-parent and more than two parents are handled without recursion failures', () => {
  const family = new Family();
  family.person('child').person('p1').person('p2').person('p3');
  family.parent('p1', 'child').parent('p2', 'child').parent('p3', 'child');
  family.get('child').rels.parents.push('child');
  const index = buildKinshipIndex(family.people);
  assert.equal(index.parents.get('child').size, 3);
  assert.ok(index.warnings.some((warning) => warning.includes('Самоссылка')));
  assert.equal(computeKinship({ index, centerId: 'child', targetId: 'p3' }).label, 'родитель');
});

test('computeAllKinships returns documented map and reuses one index', () => {
  const family = directFamily();
  const result = computeAllKinships({ people: family.people, centerId: 'center' });
  assert.equal(result.kinships.size, family.people.length);
  const father = result.kinships.get('father');
  assert.deepEqual(Object.keys(father), [
    'centerId',
    'targetId',
    'kind',
    'label',
    'shortLabel',
    'gender',
    'degree',
    'generationDelta',
    'distanceFromCenter',
    'distanceFromTarget',
    'commonAncestorIds',
    'primaryPath',
    'alternativePaths',
    'additionalRelations',
    'warnings',
  ]);
  assert.equal(father.distanceFromCenter, 1);
  assert.deepEqual(father.primaryPath.steps, [
    { fromId: 'center', toId: 'father', type: 'parent' },
  ]);
});
