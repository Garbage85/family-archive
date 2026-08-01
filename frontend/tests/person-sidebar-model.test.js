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
      ['Супруги', []],
      ['Дети', []],
    ],
  );
});

test('preparePersonSidebarData returns null for an unknown selection', () => {
  assert.equal(preparePersonSidebarData(tree, 'missing'), null);
  assert.equal(preparePersonSidebarData(null, 'person-1'), null);
});
