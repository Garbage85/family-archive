import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePersonSidebarData } from '../src/person-sidebar-model.js';

const tree = [
  {
    id: 'person-1',
    data: {
      first_name: 'Анна',
      last_name: 'Петрова',
      middle_name: null,
      gender: 'F',
      birth_date: '1988-04-09',
      death_date: '',
      birth_place: 'Чита',
      occupation: 'Архитектор',
      notes: 'Любит семейные фотографии.',
      avatar: '/api/files/people/person-1/photo.webp',
    },
    rels: {
      parents: ['person-2'],
      spouses: ['missing-person'],
      children: ['person-3'],
    },
  },
  {
    id: 'person-2',
    data: { first_name: 'Иван', last_name: 'Петров', gender: 'M' },
    rels: {},
  },
  {
    id: 'person-3',
    data: { first_name: 'Маша', gender: 'F' },
    rels: {},
  },
];

test('preparePersonSidebarData prepares facts and resolves relatives', () => {
  const result = preparePersonSidebarData(tree, 'person-1');
  const facts = Object.fromEntries(result.fields.map((field) => [field.key, field.value]));

  assert.equal(result.fullName, 'Петрова Анна');
  assert.equal(result.initials, 'АП');
  assert.equal(result.photoUrl, '/api/files/people/person-1/photo.webp');
  assert.equal(result.values.birth_date, '1988-04-09');
  assert.equal(result.values.gender, 'F');
  assert.equal(facts.first_name, 'Анна');
  assert.equal(facts.last_name, 'Петрова');
  assert.equal(facts.gender, 'Женщина');
  assert.equal(facts.birth_date, '09.04.1988');
  assert.equal(facts.middle_name, undefined);
  assert.equal(facts.death_date, undefined);
  assert.deepEqual(
    result.relationGroups.map((group) => [group.key, group.people.map((person) => person.name)]),
    [
      ['parents', ['Петров Иван']],
      ['spouses', ['Неизвестный человек']],
      ['children', ['Маша']],
    ],
  );
  assert.equal(result.relationGroups[0].people[0].roleLabel, 'Отец');
  assert.equal(result.relationGroups[0].people[0].relationType, 'biological');
  assert.equal(result.relationGroups[1].label, 'Супруг');
  assert.equal(result.relationGroups[1].people[0].roleLabel, 'Супруг(а)');
});

test('preparePersonSidebarData removes empty and null-like labels', () => {
  const result = preparePersonSidebarData(
    [
      {
        id: 'empty',
        data: {
          first_name: '  ',
          last_name: 'undefined',
          middle_name: null,
          gender: undefined,
          notes: 'null',
        },
        rels: {},
      },
    ],
    'empty',
  );

  assert.equal(result.fullName, 'Без имени');
  assert.equal(result.initials, '—');
  assert.equal(result.photoUrl, '');
  assert.deepEqual(result.fields, []);
  assert.deepEqual(
    result.relationGroups.map((group) => [group.label, group.people]),
    [
      ['Родители', []],
      ['Супруг(а)', []],
      ['Дети', []],
    ],
  );
});

test('preparePersonSidebarData shows maiden name only for a woman', () => {
  const woman = preparePersonSidebarData(
    [
      {
        id: 'woman',
        data: { gender: 'F', last_name: 'Иванова', maiden_name: 'Петрова' },
        rels: {},
      },
    ],
    'woman',
  );
  const man = preparePersonSidebarData(
    [
      {
        id: 'man',
        data: { gender: 'M', last_name: 'Иванов', maiden_name: 'Петров' },
        rels: {},
      },
    ],
    'man',
  );

  assert.equal(woman.fields.find((field) => field.key === 'maiden_name').value, 'Петрова');
  assert.equal(
    man.fields.some((field) => field.key === 'maiden_name'),
    false,
  );
  assert.equal(man.values.maiden_name, 'Петров');
});

test('preparePersonSidebarData keeps same-gender parents and labels every relationship', () => {
  const source = [
    {
      id: 'selected',
      data: { first_name: 'Иван', gender: 'M' },
      rels: {
        parents: ['mother-1', 'mother-2', 'parent-3'],
        spouses: ['wife', 'husband', 'partner'],
      },
    },
    { id: 'mother-1', data: { first_name: 'Анна', gender: 'F' }, rels: {} },
    { id: 'mother-2', data: { first_name: 'Мария', gender: 'female' }, rels: {} },
    { id: 'parent-3', data: { first_name: 'Саша' }, rels: {} },
    { id: 'wife', data: { first_name: 'Ольга', gender: 'F' }, rels: {} },
    { id: 'husband', data: { first_name: 'Пётр', gender: 'M' }, rels: {} },
    { id: 'partner', data: { first_name: 'Женя' }, rels: {} },
  ];
  const snapshot = structuredClone(source);

  const result = preparePersonSidebarData(source, 'selected');
  const parents = result.relationGroups.find((group) => group.key === 'parents');
  const spouses = result.relationGroups.find((group) => group.key === 'spouses');

  assert.deepEqual(
    parents.people.map((person) => [person.name, person.roleLabel, person.relationType]),
    [
      ['Анна', 'Мать', 'biological'],
      ['Мария', 'Мать', 'biological'],
      ['Саша', 'Родитель', 'biological'],
    ],
  );
  assert.equal(spouses.label, 'Супруги');
  assert.deepEqual(
    spouses.people.map((person) => person.roleLabel),
    ['Супруга', 'Супруг', 'Супруг(а)'],
  );
  assert.deepEqual(source, snapshot);
});

test('preparePersonSidebarData returns null for an unknown selection', () => {
  assert.equal(preparePersonSidebarData(tree, 'missing'), null);
  assert.equal(preparePersonSidebarData(null, 'person-1'), null);
});
