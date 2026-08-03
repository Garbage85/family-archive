import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPerson,
  diffTrees,
  normaliseTree,
  updatePerson,
  validateTree,
} from '../src/tree-utils.js';

test('normaliseTree creates required arrays', () => {
  const result = normaliseTree([{ id: '1', data: { gender: 'M' }, rels: {} }]);
  assert.deepEqual(result[0].rels.parents, []);
  assert.deepEqual(result[0].rels.spouses, []);
  assert.deepEqual(result[0].rels.children, []);
});

test('maiden_name remains optional during normalisation', () => {
  const [person] = normaliseTree([{ id: '1', data: { gender: 'F' }, rels: {} }]);
  assert.equal(Object.hasOwn(person.data, 'maiden_name'), false);
});

test('normalisation preserves an explicitly unknown gender', () => {
  const [person] = normaliseTree([{ id: '1', data: { gender: '' }, rels: {} }]);
  assert.equal(person.data.gender, '');
  assert.deepEqual(validateTree([person]), []);
});

test('normalisation keeps the existing male default when gender is absent', () => {
  const [person] = normaliseTree([{ id: '1', data: {}, rels: {} }]);
  assert.equal(person.data.gender, 'M');
});

test('changing a woman to male preserves an existing maiden_name', () => {
  const result = updatePerson(
    [
      {
        id: '1',
        data: { gender: 'F', last_name: 'Иванова', maiden_name: 'Петрова' },
        rels: {},
      },
    ],
    '1',
    { gender: 'M' },
  );

  assert.equal(result[0].data.gender, 'M');
  assert.equal(result[0].data.maiden_name, 'Петрова');
});

test('saving equal female surnames preserves both legacy values without data movement', () => {
  const result = updatePerson(
    [
      {
        id: '1',
        data: { gender: 'F', last_name: 'Иванова', maiden_name: 'Иванова' },
        rels: {},
      },
    ],
    '1',
    { gender: 'F', last_name: 'Иванова', maiden_name: 'Иванова' },
  );

  assert.equal(result[0].data.last_name, 'Иванова');
  assert.equal(result[0].data.maiden_name, 'Иванова');
});

test('saving a legacy woman with only last_name does not invent maiden_name', () => {
  const result = updatePerson(
    [{ id: '1', data: { gender: 'F', last_name: 'Иванова' }, rels: {} }],
    '1',
    { gender: 'F', last_name: 'Иванова', maiden_name: '' },
  );

  assert.equal(result[0].data.last_name, 'Иванова');
  assert.equal(Object.hasOwn(result[0].data, 'maiden_name'), false);
});

test('new people have empty notes and the exact legacy instruction normalises to empty', () => {
  assert.equal(createPerson({ first_name: 'Новый' }).data.notes, '');
  const legacy = 'Нажмите на карточку, чтобы изменить данные и добавить родственников.';
  const normalised = normaliseTree([
    { id: 'legacy', data: { first_name: 'Анна', notes: legacy }, rels: {} },
  ]);
  assert.equal(normalised[0].data.notes, '');
  assert.equal(updatePerson(normalised, 'legacy', { first_name: 'Анна' })[0].data.notes, '');
});

test('notes placeholder is not data and arbitrary user notes survive normalisation', () => {
  const person = createPerson({ first_name: 'Анна', notes: 'Настоящая заметка' });
  assert.equal(person.data.notes, 'Настоящая заметка');
  assert.notEqual(person.data.notes, 'Добавьте заметку о человеке');
  assert.equal(normaliseTree([person])[0].data.notes, 'Настоящая заметка');
});

test('validateTree catches missing relation targets', () => {
  const errors = validateTree([{ id: '1', data: { gender: 'M' }, rels: { children: ['2'] } }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /отсутствующему ID 2/);
});

test('diffTrees counts added, removed and changed people', () => {
  const before = [
    { id: '1', data: { gender: 'M', first_name: 'A' }, rels: {} },
    { id: '2', data: { gender: 'F' }, rels: {} },
  ];
  const after = [
    { id: '1', data: { gender: 'M', first_name: 'B' }, rels: {} },
    { id: '3', data: { gender: 'M' }, rels: {} },
  ];
  assert.deepEqual(diffTrees(before, after), { added: 1, removed: 1, changed: 1 });
});
