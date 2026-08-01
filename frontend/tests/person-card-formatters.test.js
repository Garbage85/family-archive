import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBirthDate, formatPersonNameLines } from '../src/person-card-formatters.js';

test('formatPersonNameLines returns full name in surname, name, patronymic order', () => {
  assert.deepEqual(
    formatPersonNameLines({
      first_name: 'Анна',
      last_name: 'Петрова',
      middle_name: 'Сергеевна',
    }),
    ['Петрова', 'Анна', 'Сергеевна'],
  );
});

test('formatPersonNameLines omits a missing patronymic', () => {
  assert.deepEqual(
    formatPersonNameLines({ first_name: 'Анна', last_name: 'Петрова', middle_name: null }),
    ['Петрова', 'Анна'],
  );
});

test('formatPersonNameLines handles a person with only a name', () => {
  assert.deepEqual(
    formatPersonNameLines({ first_name: '  Анна  ', last_name: undefined, middle_name: 'null' }),
    ['Анна'],
  );
});

test('formatBirthDate formats a valid ISO calendar date', () => {
  assert.equal(formatBirthDate('1985-12-08'), '08.12.1985');
});

test('formatBirthDate omits an empty date', () => {
  assert.equal(formatBirthDate(''), '');
});

test('formatBirthDate omits incomplete and invalid dates', () => {
  assert.equal(formatBirthDate('1985-12'), '');
  assert.equal(formatBirthDate('2023-02-29'), '');
  assert.equal(formatBirthDate('not-a-date'), '');
});
