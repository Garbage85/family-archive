import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTrees, normaliseTree, validateTree } from '../src/tree-utils.js';

test('normaliseTree creates required arrays', () => {
  const result = normaliseTree([{ id: '1', data: { gender: 'M' }, rels: {} }]);
  assert.deepEqual(result[0].rels.parents, []);
  assert.deepEqual(result[0].rels.spouses, []);
  assert.deepEqual(result[0].rels.children, []);
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
