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
      ['siblings', []],
      ['spouses', ['Неизвестный человек']],
      ['children', ['Маша']],
    ],
  );
  assert.equal(result.relationGroups[0].people[0].roleLabel, 'Отец');
  assert.equal(result.relationGroups[0].people[0].relationType, 'biological');
  assert.equal(result.relationGroups[2].label, 'Супруг(а)');
  assert.equal(result.relationGroups[2].people[0].roleLabel, '');
  assert.equal(result.relationGroups[2].people[0].isResolved, false);
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
      ['Братья и сёстры', []],
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
  assert.deepEqual(
    woman.fields.slice(0, 2).map((field) => [field.key, field.label]),
    [
      ['maiden_name', 'Девичья фамилия'],
      ['last_name', 'Фамилия'],
    ],
  );
  assert.equal(woman.fullName, 'Иванова (Петрова)');
  assert.equal(
    man.fields.some((field) => field.key === 'maiden_name'),
    false,
  );
  assert.equal(man.values.maiden_name, 'Петров');
});

test('woman with only maiden_name is displayed and remains editable without a current surname', () => {
  const result = preparePersonSidebarData(
    [
      {
        id: 'woman',
        data: {
          gender: 'F',
          maiden_name: 'Сапожникова',
          last_name: '',
          first_name: 'Алиса',
          middle_name: 'Алексеевна',
        },
        rels: {},
      },
    ],
    'woman',
  );

  assert.equal(result.fullName, 'Сапожникова Алиса Алексеевна');
  assert.equal(result.values.maiden_name, 'Сапожникова');
  assert.equal(result.values.last_name, '');
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
    ['', '', ''],
  );
  assert.deepEqual(source, snapshot);
});

test('single wife uses one section title and unified current-and-maiden surname format', () => {
  const result = preparePersonSidebarData(
    [
      {
        id: 'husband',
        data: { first_name: 'Алексей', gender: 'M' },
        rels: { spouses: ['wife'] },
      },
      {
        id: 'wife',
        data: {
          first_name: 'Елена',
          middle_name: 'Юрьевна',
          last_name: 'Сапожникова',
          maiden_name: 'Иванова',
          gender: 'F',
        },
        rels: { spouses: ['husband'] },
      },
    ],
    'husband',
  );
  const spouses = result.relationGroups.find((group) => group.key === 'spouses');

  assert.equal(spouses.label, 'Супруга');
  assert.equal(spouses.people[0].roleLabel, '');
  assert.equal(spouses.people[0].name, 'Сапожникова (Иванова) Елена Юрьевна');
});

test('single husband has no repeated role while parents retain father and mother labels', () => {
  const result = preparePersonSidebarData(
    [
      {
        id: 'wife',
        data: { first_name: 'Елена', gender: 'F' },
        rels: { spouses: ['husband'], parents: ['father', 'mother'] },
      },
      { id: 'husband', data: { first_name: 'Алексей', gender: 'M' }, rels: {} },
      { id: 'father', data: { first_name: 'Иван', gender: 'M' }, rels: {} },
      { id: 'mother', data: { first_name: 'Анна', gender: 'F' }, rels: {} },
    ],
    'wife',
  );
  const spouses = result.relationGroups.find((group) => group.key === 'spouses');
  const parents = result.relationGroups.find((group) => group.key === 'parents');

  assert.equal(spouses.label, 'Супруг');
  assert.equal(spouses.people[0].roleLabel, '');
  assert.deepEqual(
    parents.people.map((person) => person.roleLabel),
    ['Отец', 'Мать'],
  );
});

test('preparePersonSidebarData returns null for an unknown selection', () => {
  assert.equal(preparePersonSidebarData(tree, 'missing'), null);
  assert.equal(preparePersonSidebarData(null, 'person-1'), null);
});

test('empty and exact legacy notes are hidden while a real note is preserved', () => {
  const legacy = 'Нажмите на карточку, чтобы изменить данные и добавить родственников.';
  for (const notes of ['', legacy]) {
    const result = preparePersonSidebarData(
      [{ id: 'person', data: { first_name: 'Анна', notes }, rels: {} }],
      'person',
    );
    assert.equal(
      result.fields.some((field) => field.key === 'notes'),
      false,
    );
    assert.equal(result.values.notes, '');
  }

  const result = preparePersonSidebarData(
    [{ id: 'person', data: { first_name: 'Анна', notes: 'Настоящая заметка' }, rels: {} }],
    'person',
  );
  assert.equal(result.fields.find((field) => field.key === 'notes').value, 'Настоящая заметка');
  assert.equal(result.values.notes, 'Настоящая заметка');
});

test('brother with two shared parents is listed exactly once and self is excluded', () => {
  const source = [
    {
      id: 'selected',
      data: { first_name: 'Анна', gender: 'F' },
      rels: { parents: ['father', 'mother'] },
    },
    {
      id: 'brother',
      data: { first_name: 'Иван', gender: 'M' },
      rels: { parents: ['father', 'mother'] },
    },
    {
      id: 'father',
      data: { first_name: 'Пётр', gender: 'M' },
      rels: { children: ['selected', 'brother'] },
    },
    {
      id: 'mother',
      data: { first_name: 'Мария', gender: 'F' },
      rels: { children: ['selected', 'brother'] },
    },
  ];

  const result = preparePersonSidebarData(source, 'selected');
  const siblings = result.relationGroups.find((group) => group.key === 'siblings');

  assert.equal(siblings.label, 'Братья и сёстры');
  assert.deepEqual(
    siblings.people.map((person) => [person.id, person.roleLabel]),
    [['brother', 'Брат']],
  );
  assert.equal(
    siblings.people.some((person) => person.id === 'selected'),
    false,
  );
});

test('sister with one shared parent is listed while an unrelated person is ignored', () => {
  const source = [
    {
      id: 'selected',
      data: { first_name: 'Иван', gender: 'M' },
      rels: { parents: ['mother'] },
    },
    {
      id: 'sister',
      data: { first_name: 'Анна', gender: 'F' },
      rels: { parents: ['mother', 'other-father'] },
    },
    {
      id: 'unrelated',
      data: { first_name: 'Ольга', gender: 'F' },
      rels: { parents: ['unrelated-parent'] },
    },
    { id: 'mother', data: { first_name: 'Мария' }, rels: {} },
    { id: 'other-father', data: { first_name: 'Пётр' }, rels: {} },
    { id: 'unrelated-parent', data: { first_name: 'Сергей' }, rels: {} },
  ];

  const siblings = preparePersonSidebarData(source, 'selected').relationGroups.find(
    (group) => group.key === 'siblings',
  );

  assert.deepEqual(
    siblings.people.map((person) => [person.id, person.roleLabel]),
    [['sister', 'Сестра']],
  );
});

test('missing parent targets are ignored without creating false siblings', () => {
  const source = [
    {
      id: 'selected',
      data: { first_name: 'Иван' },
      rels: { parents: ['missing-parent'] },
    },
    {
      id: 'candidate',
      data: { first_name: 'Анна', gender: 'F' },
      rels: { parents: ['missing-parent'] },
    },
  ];

  const result = preparePersonSidebarData(source, 'selected');
  const siblings = result.relationGroups.find((group) => group.key === 'siblings');

  assert.deepEqual(siblings.people, []);
});

test('one-sided legacy child links produce a neutral sibling without mutating the tree', () => {
  const source = [
    { id: 'selected', data: { first_name: 'Иван' }, rels: {} },
    { id: 'sibling', data: { first_name: 'Саша' }, rels: {} },
    {
      id: 'parent',
      data: { first_name: 'Мария', gender: 'F' },
      rels: { children: ['selected', 'sibling', 'missing-child'] },
    },
  ];
  const snapshot = structuredClone(source);

  const result = preparePersonSidebarData(source, 'selected');
  const siblings = result.relationGroups.find((group) => group.key === 'siblings');

  assert.deepEqual(
    siblings.people.map((person) => [person.id, person.roleLabel]),
    [['sibling', 'Брат или сестра']],
  );
  assert.deepEqual(source, snapshot);
});

test('parent-child reverse links are indexed once instead of rescanning for every candidate', () => {
  const peopleCount = 80;
  let childrenReads = 0;
  const source = Array.from({ length: peopleCount }, (_, index) => {
    const rels = { parents: index > 1 ? ['parent'] : [] };
    Object.defineProperty(rels, 'children', {
      enumerable: true,
      get() {
        childrenReads += 1;
        return index === 0
          ? Array.from({ length: peopleCount - 1 }, (_, child) => String(child + 1))
          : [];
      },
    });
    return {
      id: index === 0 ? 'parent' : String(index),
      data: { first_name: `Человек ${index}` },
      rels,
    };
  });

  preparePersonSidebarData(source, '1');

  assert.ok(childrenReads <= peopleCount + 1, `children прочитан ${childrenReads} раз`);
});
