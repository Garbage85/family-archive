import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBirthDate,
  formatPersonCardLines,
  formatPersonName,
  formatPersonNameLines,
} from '../src/person-card-formatters.js';

test('card formatter keeps surname and given-name groups separate', () => {
  assert.deepEqual(
    formatPersonCardLines({
      gender: 'F',
      last_name: 'Сапожникова',
      maiden_name: 'Печёркина',
      first_name: 'Елена',
      middle_name: 'Юрьевна',
    }),
    { surname: 'Сапожникова (Печёркина)', givenName: 'Елена Юрьевна' },
  );
});

test('woman with only maiden_name uses it as the displayed surname', () => {
  assert.equal(
    formatPersonName({
      gender: 'F',
      maiden_name: 'Сапожникова',
      first_name: 'Алиса',
      middle_name: 'Алексеевна',
    }),
    'Сапожникова Алиса Алексеевна',
  );
});

test('woman with changed surname displays current surname followed by maiden surname', () => {
  assert.equal(
    formatPersonName({
      gender: 'F',
      last_name: 'Сапожникова',
      maiden_name: 'Иванова',
      first_name: 'Александра',
      middle_name: 'Сергеевна',
    }),
    'Сапожникова (Иванова) Александра Сергеевна',
  );
});

test('equal current and maiden surnames are displayed once', () => {
  assert.equal(
    formatPersonName({
      gender: 'F',
      last_name: 'Сапожникова',
      maiden_name: 'Сапожникова',
      first_name: 'Александра',
      middle_name: 'Сергеевна',
    }),
    'Сапожникова Александра Сергеевна',
  );
});

test('legacy woman with only last_name remains compatible', () => {
  assert.equal(
    formatPersonName({
      gender: 'F',
      last_name: 'Сапожникова',
      first_name: 'Александра',
      middle_name: 'Сергеевна',
    }),
    'Сапожникова Александра Сергеевна',
  );
});

test('surname comparison trims whitespace and ignores case', () => {
  assert.equal(
    formatPersonName({
      gender: 'F',
      last_name: '  Сапожникова ',
      maiden_name: ' сапожникова  ',
      first_name: 'Александра',
    }),
    'Сапожникова Александра',
  );
});

test('missing surnames do not create empty parentheses', () => {
  assert.equal(
    formatPersonName({ gender: 'F', first_name: 'Алиса', middle_name: 'Алексеевна' }),
    'Алиса Алексеевна',
  );
});

test('displayed female name contains every searchable name component', () => {
  const label = formatPersonName({
    gender: 'F',
    last_name: 'Сапожникова',
    maiden_name: 'Иванова',
    first_name: 'Александра',
    middle_name: 'Сергеевна',
  }).toLocaleLowerCase('ru-RU');
  for (const query of ['сапожникова', 'иванова', 'александра', 'сергеевна']) {
    assert.ok(label.includes(query));
  }
});

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

test('male name formatting remains unchanged even when maiden_name is present', () => {
  assert.equal(
    formatPersonName({
      gender: 'M',
      last_name: 'Сапожников',
      maiden_name: 'Иванов',
      first_name: 'Алексей',
      middle_name: 'Сергеевич',
    }),
    'Сапожников Алексей Сергеевич',
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
