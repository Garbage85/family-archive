import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_PROPOSAL_CODE,
  assertProposalCanBeApproved,
  getProposalApprovalBlockReason,
  isProposalCurrent,
} from '../src/proposal-revision.js';
import { renderProposals } from '../src/ui.js';

function proposal(baseRevision, overrides = {}) {
  return {
    id: 'proposal-1',
    base_revision: baseRevision,
    data: [{ id: '1', data: { first_name: 'Иван', gender: 'M' }, rels: {} }],
    comment: 'Добавил родственника',
    created: '2026-08-07T10:00:00.000Z',
    expand: { author: { name: 'Участник' } },
    ...overrides,
  };
}

function tree(revision, data = [{ id: '1', data: { first_name: 'Иван', gender: 'M' }, rels: {} }]) {
  return { id: 'tree-1', revision, data };
}

test('current proposal matches the tree revision and can be approved', () => {
  const item = proposal(3);
  assert.equal(isProposalCurrent(item, 3), true);
  assert.equal(getProposalApprovalBlockReason(item, 3), null);
  assert.doesNotThrow(() => assertProposalCanBeApproved(item, 3));
});

test('stale proposal cannot be approved', () => {
  const item = proposal(2);
  assert.equal(isProposalCurrent(item, 4), false);
  const reason = getProposalApprovalBlockReason(item, 4);
  assert.match(reason, /ревизия 4/);
  assert.match(reason, /ревизии 2/);
  assert.match(reason, /Нельзя принять предложение/);

  assert.throws(
    () => assertProposalCanBeApproved(item, 4),
    (error) => {
      assert.equal(error.code, STALE_PROPOSAL_CODE);
      assert.match(error.message, /Нельзя принять предложение/);
      return true;
    },
  );
});

test('admin tree save after proposal creation makes the proposal stale', () => {
  const memberProposal = proposal(5, {
    data: [
      { id: '1', data: { first_name: 'Иван', gender: 'M', occupation: 'Врач' }, rels: {} },
      { id: '2', data: { first_name: 'Мария', gender: 'F' }, rels: {} },
    ],
  });
  const treeAfterAdminSave = tree(6, [
    {
      id: '1',
      data: { first_name: 'Иван', gender: 'M', notes: 'Правка администратора' },
      rels: {},
    },
  ]);

  assert.equal(isProposalCurrent(memberProposal, treeAfterAdminSave.revision), false);
  assert.throws(
    () => assertProposalCanBeApproved(memberProposal, treeAfterAdminSave.revision),
    (error) => error.code === STALE_PROPOSAL_CODE,
  );

  const list = { innerHTML: '', onclick: null };
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      return selector === '#proposals-list' ? list : null;
    },
  };

  try {
    renderProposals([memberProposal], treeAfterAdminSave, {
      diff: () => ({ added: 1, changed: 1, removed: 0 }),
      onAction: () => assert.fail('stale approve must stay disabled'),
    });
    assert.match(list.innerHTML, /warning-badge/);
    assert.match(list.innerHTML, /Старая версия/);
    assert.match(list.innerHTML, /proposal-stale-hint/);
    assert.match(list.innerHTML, /disabled/);
    assert.match(list.innerHTML, /дерево уже изменено \(ревизия 6\)/);
    assert.match(list.innerHTML, /ревизии 5/);
    assert.doesNotMatch(list.innerHTML, /ok-badge/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('current proposal keeps an enabled approve action in the moderation UI', () => {
  const item = proposal(7);
  const currentTree = tree(7);
  const list = { innerHTML: '', onclick: null };
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      return selector === '#proposals-list' ? list : null;
    },
  };

  try {
    renderProposals([item], currentTree, {
      diff: () => ({ added: 0, changed: 1, removed: 0 }),
      onAction() {},
    });
    assert.match(list.innerHTML, /ok-badge/);
    assert.match(list.innerHTML, /Актуально/);
    assert.doesNotMatch(list.innerHTML, /proposal-stale-hint/);
    assert.doesNotMatch(list.innerHTML, /disabled/);
    assert.match(list.innerHTML, /data-action="approve"/);
  } finally {
    globalThis.document = originalDocument;
  }
});
