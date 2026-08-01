import './styles.css';
import {
  approveProposal,
  createProposal,
  listPendingProposals,
  loadMainTree,
  login,
  logout,
  rejectProposal,
  restoreSession,
  saveTree,
  uploadPhoto,
} from './api.js';
import { FamilyTreeChart } from './adapters/family-chart-adapter.js';
import { applyPersonAction, canEditPeople, persistTreeChanges } from './person-editor.js';
import { preparePersonSidebarData } from './person-sidebar-model.js';
import { PersonSidebar } from './person-sidebar.js';
import { SidebarZoomGuard } from './sidebar-zoom-guard.js';
import { cloneTree, diffTrees, downloadJson, validateTree } from './tree-utils.js';
import { renderProposals, renderShell, setSaveState, setStatus, showApp, showLogin } from './ui.js';

const root = document.querySelector('#app');
renderShell(root);
const chart = new FamilyTreeChart('#FamilyChart');
const personSidebar = new PersonSidebar(document.querySelector('#person-sidebar-host'));
const chromeZoomGuards = [...document.querySelectorAll('[data-ui-chrome]')].map(
  (element) => new SidebarZoomGuard(element),
);
let user = null,
  tree = null,
  workingData = [];
let dirty = false,
  busy = false,
  pendingProposals = [],
  previewMode = false;

function setChromeZoomGuardActive(active) {
  for (const guard of chromeZoomGuards) {
    if (active) guard.activate();
    else guard.deactivate();
  }
}

function updateSaveButton() {
  setSaveState({ dirty, role: user?.role || 'viewer', busy, previewMode });
}
function setDirty(value) {
  dirty = value;
  updateSaveButton();
  setStatus(
    value ? 'Есть несохранённые изменения.' : 'Все изменения сохранены.',
    value ? 'warning' : 'normal',
  );
}
function updateMeta() {
  document.querySelector('#tree-meta').textContent =
    `Версия ${tree.revision} · ${workingData.length} ${workingData.length === 1 ? 'человек' : 'человек'}`;
}
function configureRoleUi() {
  document.querySelector('#proposals-button').classList.toggle('hidden', user.role !== 'admin');
  document
    .querySelector('#save-button')
    .classList.toggle('hidden', !canEditPeople(user.role, previewMode));
}

function getSidebarView(personId) {
  return preparePersonSidebarData(workingData, personId);
}

function applySidebarAction(action, options = {}) {
  const result = applyPersonAction(
    { data: workingData, dirty, role: user?.role, previewMode },
    action,
  );
  workingData = result.data;
  chart.updateData(workingData, options);
  setDirty(result.dirty);
  updateMeta();
  return getSidebarView(action.personId);
}

const sidebarHandlers = {
  onUpdate: (personId, values) => applySidebarAction({ type: 'update', personId, values }),
  onAddRelative: (personId, relation, values) =>
    applySidebarAction(
      { type: 'add-relative', personId, relation, values },
      { fit: true, focusId: personId },
    ),
  onDelete: (personId) => {
    applySidebarAction({ type: 'delete', personId }, { fit: true });
    return null;
  },
  onUploadPhoto: async (personId, file) => {
    const photoUrl = await uploadPhoto(personId, file, user.id);
    return applySidebarAction({ type: 'set-photo', personId, photoUrl });
  },
  onRemovePhoto: (personId) => applySidebarAction({ type: 'set-photo', personId, photoUrl: '' }),
};

function openSidebar(personId) {
  personSidebar.open(getSidebarView(personId), {
    editable: canEditPeople(user?.role, previewMode),
    handlers: sidebarHandlers,
  });
}

function mountTree(data = workingData, { fit = true } = {}) {
  personSidebar.close();
  workingData = cloneTree(data);
  chart.mount(workingData, {
    onSelect: openSidebar,
  });
  if (fit) chart.fit();
  updateMeta();
}

async function applyKnownProfile() {
  if (user.role !== 'admin') return;
  const alexey = workingData.find(
    (p) => p.id === 'root-person' || (p.data.first_name === 'Алексей' && workingData.length === 1),
  );
  if (!alexey || alexey.data.birth_date) return;
  alexey.data.birth_date = '1985-12-08';
  tree = await saveTree(tree, workingData, user.id);
  workingData = cloneTree(tree.data);
}

async function enterApplication(authUser) {
  user = authUser;
  tree = await loadMainTree();
  workingData = cloneTree(tree.data);
  dirty = false;
  previewMode = false;
  await applyKnownProfile();
  showApp(user, tree);
  setChromeZoomGuardActive(true);
  configureRoleUi();
  mountTree();
  updateSaveButton();
  setStatus(
    user.role === 'viewer'
      ? 'Режим просмотра.'
      : user.role === 'member'
        ? 'Изменения отправляются администратору.'
        : 'Нажмите на человека, чтобы открыть карточку.',
  );
  if (user.role === 'admin') await refreshProposals();
}

async function refreshProposals() {
  pendingProposals = await listPendingProposals();
  document.querySelector('#proposal-count').textContent = pendingProposals.length
    ? `(${pendingProposals.length})`
    : '';
}
async function handleSave() {
  if (!dirty || busy || !canEditPeople(user?.role, previewMode)) return;
  const errors = validateTree(workingData);
  if (errors.length) return alert(`Нельзя сохранить древо:\n\n${errors.slice(0, 10).join('\n')}`);
  if (user.role === 'member') {
    document.querySelector('#proposal-comment').value = '';
    return document.querySelector('#comment-dialog').showModal();
  }
  busy = true;
  updateSaveButton();
  try {
    const result = await persistTreeChanges({
      role: user.role,
      previewMode,
      tree,
      data: workingData,
      userId: user.id,
      save: saveTree,
      propose: createProposal,
    });
    tree = result.tree;
    workingData = cloneTree(result.tree.data);
    setDirty(false);
    updateMeta();
  } catch (error) {
    setStatus(error.message || 'Не удалось сохранить древо.', 'error');
    alert(error.message || error);
  } finally {
    busy = false;
    updateSaveButton();
  }
}
async function submitProposal(comment) {
  if (!dirty || busy || user?.role !== 'member' || previewMode) return;
  busy = true;
  updateSaveButton();
  try {
    await persistTreeChanges({
      role: user.role,
      previewMode,
      tree,
      data: workingData,
      userId: user.id,
      comment,
      save: saveTree,
      propose: createProposal,
    });
    workingData = cloneTree(tree.data);
    mountTree();
    setDirty(false);
    setStatus('Предложение отправлено.', 'success');
  } catch (error) {
    alert(error.message || error);
  } finally {
    busy = false;
    updateSaveButton();
  }
}
async function openProposals() {
  await refreshProposals();
  renderProposals(pendingProposals, tree, { diff: diffTrees, onAction: handleProposalAction });
  const d = document.querySelector('#proposals-dialog');
  if (!d.open) d.showModal();
}
async function handleProposalAction(action, id) {
  const proposal = pendingProposals.find((item) => item.id === id);
  if (!proposal) return;
  if (action === 'preview') {
    previewMode = true;
    dirty = false;
    document.querySelector('#proposals-dialog').close();
    mountTree(proposal.data);
    configureRoleUi();
    updateSaveButton();
    setStatus('Предпросмотр предложения. Обновите страницу для возврата.', 'warning');
    return;
  }
  if (action === 'reject') {
    await rejectProposal(proposal.id, user.id, prompt('Причина отклонения:', '') || '');
    return openProposals();
  }
  if (action === 'approve') {
    if (!confirm('Принять предложение?')) return;
    tree = await approveProposal(proposal, tree, user.id);
    workingData = cloneTree(tree.data);
    dirty = false;
    previewMode = false;
    mountTree();
    configureRoleUi();
    updateSaveButton();
    return openProposals();
  }
}

for (const button of document.querySelectorAll('[data-close-dialog]'))
  button.addEventListener('click', () =>
    document.querySelector(`#${button.dataset.closeDialog}`)?.close(),
  );
document.querySelector('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.querySelector('#login-error').textContent = '';
  try {
    await enterApplication(
      await login(
        document.querySelector('#login-email').value.trim(),
        document.querySelector('#login-password').value,
      ),
    );
  } catch {
    document.querySelector('#login-error').textContent =
      'Не удалось войти. Проверьте адрес и пароль.';
  }
});
document.querySelector('#logout-button').addEventListener('click', () => {
  logout();
  chart.destroy();
  personSidebar.close();
  setChromeZoomGuardActive(false);
  user = tree = null;
  previewMode = false;
  showLogin();
});
document.querySelector('#save-button').addEventListener('click', handleSave);
document.querySelector('#fit-button').addEventListener('click', () => chart.fit());
document.querySelector('#orientation-button').addEventListener('click', (e) => {
  const o = chart.toggleOrientation();
  e.currentTarget.textContent = o === 'vertical' ? 'Горизонтально' : 'Вертикально';
});
document
  .querySelector('#export-button')
  .addEventListener('click', () => downloadJson(`family-tree-v${tree.revision}.json`, workingData));
document.querySelector('#proposals-button').addEventListener('click', openProposals);
document.querySelector('#comment-form').addEventListener('submit', (e) => {
  e.preventDefault();
  document.querySelector('#comment-dialog').close();
  submitProposal(document.querySelector('#proposal-comment').value.trim());
});
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

(async () => {
  const existing = await restoreSession();
  if (existing) {
    try {
      await enterApplication(existing);
      return;
    } catch (e) {
      console.error(e);
      logout();
    }
  }
  showLogin();
})();
