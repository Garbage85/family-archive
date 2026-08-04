import test from 'node:test';
import assert from 'node:assert/strict';
import { findPotentialPersonDuplicates } from '../src/person-duplicates.js';

function person(id, data, rels = {}) {
  return {
    id,
    data,
    rels: { parents: [], spouses: [], children: [], ...rels },
  };
}

const people = [
  person(
    'alexey',
    {
      first_name: 'Алексей',
      last_name: 'Сапожников',
      middle_name: 'Сергеевич',
      birth_date: '1985-12-08',
      birth_place: 'Чита',
    },
    { spouses: ['alexandra'] },
  ),
  person('namesake', {
    first_name: 'Алексей',
    last_name: 'Сапожников',
    middle_name: 'Иванович',
    birth_date: '1995-01-01',
  }),
  person('alexandra', {
    first_name: 'Александра',
    last_name: 'Сапожникова',
    maiden_name: 'Хусаинова',
    birth_date: '1990-05-18',
  }),
];

test('probable duplicate matching is case-insensitive and ranks exact details first', () => {
  const matches = findPotentialPersonDuplicates(
    people,
    {
      first_name: ' алексей ',
      last_name: 'САПОЖНИКОВ',
      middle_name: 'Сергеевич',
      birth_date: '1985-12-08',
      birth_place: 'чита',
    },
    { relationshipPersonIds: ['alexandra'] },
  );

  assert.deepEqual(
    matches.map((match) => match.id),
    ['alexey', 'namesake'],
  );
  assert.ok(matches[0].score > matches[1].score);
  assert.match(matches[0].reasons.join(' '), /дата рождения/);
  assert.match(matches[0].reasons.join(' '), /существующие связи/);
});

test('maiden surname participates in duplicate matching', () => {
  const matches = findPotentialPersonDuplicates(people, {
    first_name: 'Александра',
    last_name: 'Хусаинова',
  });

  assert.deepEqual(
    matches.map((match) => match.id),
    ['alexandra'],
  );
});

test('a first-name-only coincidence does not block creation', () => {
  assert.deepEqual(findPotentialPersonDuplicates(people, { first_name: 'Алексей' }), []);
});

test('selected person can be excluded without mutating source people', () => {
  const snapshot = structuredClone(people);
  const matches = findPotentialPersonDuplicates(
    people,
    { first_name: 'Алексей', last_name: 'Сапожников' },
    { excludeIds: ['alexey'] },
  );

  assert.deepEqual(
    matches.map((match) => match.id),
    ['namesake'],
  );
  assert.deepEqual(people, snapshot);
});
