import PocketBase from 'pocketbase';
import { assertProposalCanBeApproved } from './proposal-revision.js';
import { isoNow } from './tree-utils.js';

export const pb = new PocketBase(window.location.origin);
pb.autoCancellation(false);

export async function restoreSession() {
  if (!pb.authStore.isValid) return null;
  try {
    const result = await pb.collection('users').authRefresh();
    return result.record;
  } catch {
    pb.authStore.clear();
    return null;
  }
}

export async function login(identity, password) {
  const result = await pb.collection('users').authWithPassword(identity, password);
  return result.record;
}

export function logout() {
  pb.authStore.clear();
}

export async function loadMainTree() {
  return pb.collection('trees').getFirstListItem('', { sort: 'created' });
}

export async function reloadTree(id) {
  return pb.collection('trees').getOne(id);
}

export async function saveTree(record, data, userId) {
  const current = await reloadTree(record.id);
  if (Number(current.revision) !== Number(record.revision)) {
    const error = new Error(
      'Древо уже изменил другой пользователь. Обновите страницу перед сохранением.',
    );
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  return pb.collection('trees').update(record.id, {
    data,
    revision: Number(record.revision) + 1,
    updated_by: userId,
  });
}

export async function createProposal(tree, data, userId, comment) {
  return pb.collection('proposals').create({
    tree: tree.id,
    author: userId,
    base_revision: Number(tree.revision),
    data,
    comment: comment || '',
    status: 'pending',
  });
}

export async function listPendingProposals() {
  return pb.collection('proposals').getFullList({
    filter: 'status = "pending"',
    sort: '-created',
    expand: 'author',
  });
}

export async function approveProposal(proposal, tree, reviewerId, note = '') {
  const latestTree = await reloadTree(tree.id);
  assertProposalCanBeApproved(proposal, latestTree.revision);
  const updatedTree = await pb.collection('trees').update(tree.id, {
    data: proposal.data,
    revision: Number(latestTree.revision) + 1,
    updated_by: reviewerId,
  });
  await pb.collection('proposals').update(proposal.id, {
    status: 'approved',
    reviewed_by: reviewerId,
    reviewed_at: isoNow(),
    review_note: note,
  });
  return updatedTree;
}

export async function rejectProposal(proposalId, reviewerId, note = '') {
  return pb.collection('proposals').update(proposalId, {
    status: 'rejected',
    reviewed_by: reviewerId,
    reviewed_at: isoNow(),
    review_note: note,
  });
}

export async function uploadPhoto(personId, file, userId) {
  const form = new FormData();
  form.set('person_id', personId);
  form.set('author', userId);
  form.set('file', file);
  const record = await pb.collection('media').create(form);
  return pb.files.getURL(record, record.file, { thumb: '320x320' });
}
