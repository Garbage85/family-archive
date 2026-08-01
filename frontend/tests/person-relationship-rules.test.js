import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getInitialMaidenName,
  getParentRoleLabel,
  getSpouseRoleLabel,
  getSpouseSectionLabel,
  shouldShowMaidenName,
} from '../src/person-relationship-rules.js';

test('woman may have the same primary and maiden surname', () => {
  const person = { data: { gender: 'F', last_name: 'Петрова', maiden_name: 'Петрова' } };
  assert.equal(shouldShowMaidenName(person), true);
});

test('woman may have different primary and maiden surnames', () => {
  const person = { data: { gender: 'female', last_name: 'Иванова', maiden_name: 'Петрова' } };
  assert.equal(shouldShowMaidenName(person), true);
});

test('woman with an empty maiden_name does not show the field in view mode', () => {
  const person = { data: { gender: 'F', last_name: 'Иванова', maiden_name: '  ' } };
  assert.equal(shouldShowMaidenName(person), false);
});

test('man keeps but does not show maiden_name', () => {
  const person = { data: { gender: 'M', last_name: 'Петров', maiden_name: 'Иванов' } };
  assert.equal(shouldShowMaidenName(person), false);
  assert.equal(getInitialMaidenName(person), 'Иванов');
});

test('first switch to female uses the current surname for an empty maiden_name', () => {
  assert.equal(getInitialMaidenName({ last_name: 'Петрова', maiden_name: '' }), 'Петрова');
});

test('existing maiden_name is not overwritten', () => {
  assert.equal(getInitialMaidenName({ last_name: 'Иванова', maiden_name: 'Петрова' }), 'Петрова');
});

test('parent role label identifies a father', () => {
  assert.equal(getParentRoleLabel({ data: { gender: 'M' } }), 'Отец');
  assert.equal(getParentRoleLabel({ gender: 'male' }), 'Отец');
});

test('parent role label identifies a mother', () => {
  assert.equal(getParentRoleLabel({ data: { gender: 'F' } }), 'Мать');
  assert.equal(getParentRoleLabel({ gender: 'female' }), 'Мать');
});

test('parent with unknown gender remains a generic parent', () => {
  assert.equal(getParentRoleLabel({ data: {} }), 'Родитель');
});

test('two same-gender parents each retain their own role label', () => {
  const parents = [{ data: { gender: 'F' } }, { data: { gender: 'female' } }];
  assert.deepEqual(parents.map(getParentRoleLabel), ['Мать', 'Мать']);
});

test('spouse role label identifies a husband', () => {
  assert.equal(getSpouseRoleLabel({ data: { gender: 'M' } }), 'Супруг');
});

test('spouse role label identifies a wife', () => {
  assert.equal(getSpouseRoleLabel({ data: { gender: 'female' } }), 'Супруга');
});

test('spouse with unknown gender gets a neutral label', () => {
  assert.equal(getSpouseRoleLabel({ data: { gender: 'unknown' } }), 'Супруг(а)');
});

test('spouse section uses singular labels and a plural label for multiple spouses', () => {
  assert.equal(getSpouseSectionLabel({ data: { gender: 'M' } }, 1), 'Супруга');
  assert.equal(getSpouseSectionLabel({ data: { gender: 'F' } }, 1), 'Супруг');
  assert.equal(getSpouseSectionLabel({ data: {} }, 1), 'Супруг(а)');
  assert.equal(getSpouseSectionLabel({ data: { gender: 'M' } }, 2), 'Супруги');
  assert.equal(getSpouseSectionLabel({ data: { gender: 'F' } }, 2), 'Супруги и партнёры');
});
