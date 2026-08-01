import './styles.css';
import {
  approveProposal, createProposal, listPendingProposals, loadMainTree, login, logout,
  rejectProposal, restoreSession, saveTree, uploadPhoto,
} from './api.js';
import { FamilyTreeChart } from './chart.js';
import {
  addRelative, cloneTree, deletePerson, diffTrees, downloadJson, personName,
  updatePerson, validateTree,
} from './tree-utils.js';
import {
  closePersonDrawer, openPersonDrawer, renderProposals, renderShell, setSaveState,
  setStatus, showApp, showLogin,
} from './ui.js';

const root = document.querySelector('#app');
renderShell(root);
const chart = new FamilyTreeChart('#FamilyChart');
let user = null, tree = null, workingData = [], selectedPerson = null;
let dirty = false, busy = false, pendingProposals = [], previewMode = false;

const canEdit = () => ['member', 'admin'].includes(user?.role) && !previewMode;
function updateSaveButton() { setSaveState({ dirty, role: user?.role || 'viewer', busy }); }
function setDirty(value) { dirty = value; updateSaveButton(); setStatus(value ? 'Есть несохранённые изменения.' : 'Все изменения сохранены.', value ? 'warning' : 'normal'); }
function updateMeta() { document.querySelector('#tree-meta').textContent = `Версия ${tree.revision} · ${workingData.length} ${workingData.length === 1 ? 'человек' : 'человек'}`; }
function configureRoleUi() { document.querySelector('#proposals-button').classList.toggle('hidden', user.role !== 'admin'); document.querySelector('#save-button').classList.toggle('hidden', !['member', 'admin'].includes(user.role)); }

function mountTree(data = workingData, { fit = true } = {}) {
  selectedPerson = null; closePersonDrawer(); workingData = cloneTree(data);
  chart.mount(workingData, { onSelect: (person) => { selectedPerson = person; if (person) openPersonDrawer(person, canEdit()); } });
  if (fit) chart.fit(); updateMeta();
}

async function applyKnownProfile() {
  if (user.role !== 'admin') return;
  const alexey = workingData.find((p) => p.id === 'root-person' || (p.data.first_name === 'Алексей' && workingData.length === 1));
  if (!alexey || alexey.data.birth_date) return;
  alexey.data.birth_date = '1985-12-08';
  tree = await saveTree(tree, workingData, user.id);
  workingData = cloneTree(tree.data);
}

async function enterApplication(authUser) {
  user = authUser; tree = await loadMainTree(); workingData = cloneTree(tree.data); dirty = false; previewMode = false;
  await applyKnownProfile();
  showApp(user, tree); configureRoleUi(); mountTree(); updateSaveButton();
  setStatus(user.role === 'viewer' ? 'Режим просмотра.' : user.role === 'member' ? 'Изменения отправляются администратору.' : 'Нажмите на человека, чтобы открыть карточку.');
  if (user.role === 'admin') await refreshProposals();
}

async function refreshProposals() { pendingProposals = await listPendingProposals(); document.querySelector('#proposal-count').textContent = pendingProposals.length ? `(${pendingProposals.length})` : ''; }
async function handleSave() {
  if (!dirty || busy) return;
  const errors = validateTree(workingData); if (errors.length) return alert(`Нельзя сохранить древо:\n\n${errors.slice(0, 10).join('\n')}`);
  if (user.role === 'member') { document.querySelector('#proposal-comment').value = ''; return document.querySelector('#comment-dialog').showModal(); }
  busy = true; updateSaveButton();
  try { tree = await saveTree(tree, workingData, user.id); workingData = cloneTree(tree.data); setDirty(false); updateMeta(); }
  catch (error) { setStatus(error.message || 'Не удалось сохранить древо.', 'error'); alert(error.message || error); }
  finally { busy = false; updateSaveButton(); }
}
async function submitProposal(comment) { busy = true; updateSaveButton(); try { await createProposal(tree, workingData, user.id, comment); workingData = cloneTree(tree.data); mountTree(); setDirty(false); setStatus('Предложение отправлено.', 'success'); } catch (error) { alert(error.message || error); } finally { busy = false; updateSaveButton(); } }
async function handlePhotoUpload(file) {
  if (!selectedPerson || !file) return; if (file.size > 10 * 1024 * 1024) return alert('Файл больше 10 МБ.');
  try { const url = await uploadPhoto(selectedPerson.id, file, user.id); selectedPerson.data.avatar = url; workingData = updatePerson(workingData, selectedPerson.id, selectedPerson.data); chart.updateData(workingData); setDirty(true); openPersonDrawer(workingData.find((p) => p.id === selectedPerson.id), true); } catch (error) { alert(error.message || error); }
}

async function openProposals() { await refreshProposals(); renderProposals(pendingProposals, tree, { diff: diffTrees, onAction: handleProposalAction }); const d = document.querySelector('#proposals-dialog'); if (!d.open) d.showModal(); }
async function handleProposalAction(action, id) {
  const proposal = pendingProposals.find((item) => item.id === id); if (!proposal) return;
  if (action === 'preview') { previewMode = true; document.querySelector('#proposals-dialog').close(); mountTree(proposal.data); setStatus('Предпросмотр предложения. Обновите страницу для возврата.', 'warning'); return; }
  if (action === 'reject') { await rejectProposal(proposal.id, user.id, prompt('Причина отклонения:', '') || ''); return openProposals(); }
  if (action === 'approve') { if (!confirm('Принять предложение?')) return; tree = await approveProposal(proposal, tree, user.id); workingData = cloneTree(tree.data); dirty = false; mountTree(); updateSaveButton(); return openProposals(); }
}

for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`)?.close());
document.querySelector('#login-form').addEventListener('submit', async (e) => { e.preventDefault(); document.querySelector('#login-error').textContent = ''; try { await enterApplication(await login(document.querySelector('#login-email').value.trim(), document.querySelector('#login-password').value)); } catch { document.querySelector('#login-error').textContent = 'Не удалось войти. Проверьте адрес и пароль.'; } });
document.querySelector('#logout-button').addEventListener('click', () => { logout(); chart.destroy(); user = tree = null; showLogin(); });
document.querySelector('#save-button').addEventListener('click', handleSave);
document.querySelector('#fit-button').addEventListener('click', () => chart.fit());
document.querySelector('#orientation-button').addEventListener('click', (e) => { const o = chart.toggleOrientation(); e.currentTarget.textContent = o === 'vertical' ? 'Горизонтально' : 'Вертикально'; });
document.querySelector('#export-button').addEventListener('click', () => downloadJson(`family-tree-v${tree.revision}.json`, workingData));
document.querySelector('#proposals-button').addEventListener('click', openProposals);
document.querySelector('#drawer-close').addEventListener('click', closePersonDrawer);
document.querySelector('#drawer-cancel').addEventListener('click', closePersonDrawer);
document.querySelector('#drawer-backdrop').addEventListener('click', closePersonDrawer);

document.querySelector('#person-form').addEventListener('submit', (e) => {
  e.preventDefault(); const form = e.currentTarget; const values = Object.fromEntries(new FormData(form));
  workingData = updatePerson(workingData, form.dataset.personId, values); selectedPerson = workingData.find((p) => p.id === form.dataset.personId); chart.updateData(workingData); setDirty(true); closePersonDrawer();
});
document.querySelector('#delete-person').addEventListener('click', () => { if (!selectedPerson || !confirm(`Удалить ${personName(selectedPerson)}?`)) return; try { workingData = deletePerson(workingData, selectedPerson.id); chart.updateData(workingData, { fit: true }); setDirty(true); closePersonDrawer(); updateMeta(); } catch (e) { alert(e.message); } });
for (const b of document.querySelectorAll('[data-relation]')) b.addEventListener('click', () => { const labels = { parent: 'родителя', spouse: 'супруга', child: 'ребёнка', sibling: 'брата или сестру' }; document.querySelector('#relative-type').value = b.dataset.relation; document.querySelector('#relative-title').textContent = `Добавить ${labels[b.dataset.relation]}`; document.querySelector('#relative-form').reset(); document.querySelector('#relative-type').value = b.dataset.relation; document.querySelector('#relative-dialog').showModal(); });
document.querySelector('#relative-form').addEventListener('submit', (e) => { e.preventDefault(); if (!selectedPerson) return; try { const values = Object.fromEntries(new FormData(e.currentTarget)); const result = addRelative(workingData, selectedPerson.id, values.relative_type || document.querySelector('#relative-type').value, values); workingData = result.data; chart.updateData(workingData, { fit: true, focusId: selectedPerson.id }); setDirty(true); document.querySelector('#relative-dialog').close(); updateMeta(); } catch (error) { alert(error.message); } });
document.querySelector('#photo-button').addEventListener('click', () => { if (!selectedPerson) return; document.querySelector('#photo-person-name').textContent = personName(selectedPerson); document.querySelector('#photo-file').value = ''; document.querySelector('#photo-dialog').showModal(); });
document.querySelector('#photo-form').addEventListener('submit', (e) => { e.preventDefault(); const file = document.querySelector('#photo-file').files?.[0]; document.querySelector('#photo-dialog').close(); handlePhotoUpload(file); });
document.querySelector('#comment-form').addEventListener('submit', (e) => { e.preventDefault(); document.querySelector('#comment-dialog').close(); submitProposal(document.querySelector('#proposal-comment').value.trim()); });
window.addEventListener('beforeunload', (e) => { if (!dirty) return; e.preventDefault(); e.returnValue = ''; });

(async () => { const existing = await restoreSession(); if (existing) { try { await enterApplication(existing); return; } catch (e) { console.error(e); logout(); } } showLogin(); })();
