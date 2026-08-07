export const STALE_PROPOSAL_CODE = 'STALE_PROPOSAL';

export function isProposalCurrent(proposal, treeRevision) {
  return Number(proposal?.base_revision) === Number(treeRevision);
}

export function getProposalApprovalBlockReason(proposal, treeRevision) {
  if (isProposalCurrent(proposal, treeRevision)) return null;

  const baseRevision = Number(proposal?.base_revision);
  const currentRevision = Number(treeRevision);
  return (
    `Нельзя принять предложение: дерево уже изменено (ревизия ${currentRevision}). ` +
    `Предложение основано на ревизии ${baseRevision}. ` +
    'Отклоните его или попросите автора отправить новое предложение на актуальной версии.'
  );
}

export function assertProposalCanBeApproved(proposal, treeRevision) {
  const reason = getProposalApprovalBlockReason(proposal, treeRevision);
  if (!reason) return;

  const error = new Error(reason);
  error.code = STALE_PROPOSAL_CODE;
  throw error;
}
