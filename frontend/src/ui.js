import { ROLE_LABELS } from './tree-utils.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderShell(root) {
  root.innerHTML = `
    <main class="page-shell">
      <section id="login-view" class="auth-view">
        <form id="login-form" class="auth-card">
          <div class="brand-mark">ДЖ</div><p class="eyebrow">Семейный архив</p>
          <h1>Древо жизни</h1><p class="muted">Закрытый семейный сайт на вашем сервере.</p>
          <label>Электронная почта<input id="login-email" type="email" autocomplete="username" required /></label>
          <label>Пароль<input id="login-password" type="password" autocomplete="current-password" minlength="8" required /></label>
          <button class="primary wide" type="submit">Войти</button><p id="login-error" class="form-error" role="alert"></p>
        </form>
      </section>

      <section id="app-view" class="app-view hidden">
        <header class="topbar">
          <div class="brand-row"><div class="brand-mark small">ДЖ</div><div><strong id="tree-title">Древо жизни</strong><div id="tree-meta" class="muted compact"></div></div></div>
          <div class="user-row"><span id="user-name"></span><span id="user-role" class="role-badge"></span><button id="logout-button" class="ghost">Выйти</button></div>
        </header>
        <nav class="toolbar">
          <div id="search-host" class="search-host"></div>
          <button id="fit-button" class="ghost">Показать всё</button>
          <button id="orientation-button" class="ghost">Горизонтально</button>
          <button id="export-button" class="ghost">Экспорт</button>
          <button id="proposals-button" class="ghost hidden">Предложения <span id="proposal-count"></span></button>
          <button id="save-button" class="primary" disabled>Сохранено</button>
        </nav>
        <div id="status-line" class="status-line" role="status"></div>
        <div id="FamilyChart" class="f3 chart-surface"></div>
        <div id="person-sidebar-host"></div>
      </section>
    </main>

    <dialog id="comment-dialog" class="dialog-card"><form id="comment-form"><h2>Предложить изменение</h2><label>Комментарий<textarea id="proposal-comment" rows="4" maxlength="500"></textarea></label><div class="dialog-actions"><button type="button" data-close-dialog="comment-dialog" class="ghost">Отмена</button><button class="primary">Отправить</button></div></form></dialog>
    <dialog id="proposals-dialog" class="dialog-card proposals-dialog"><form method="dialog"><div class="dialog-heading"><div><p class="eyebrow">Модерация</p><h2>Предложения родственников</h2></div><button type="button" data-close-dialog="proposals-dialog" class="ghost">Закрыть</button></div><div id="proposals-list" class="proposal-list"></div></form></dialog>
  `;
}

export function showLogin() {
  document.querySelector('#login-view').classList.remove('hidden');
  document.querySelector('#app-view').classList.add('hidden');
}
export function showApp(user, tree) {
  document.querySelector('#login-view').classList.add('hidden');
  document.querySelector('#app-view').classList.remove('hidden');
  document.querySelector('#user-name').textContent = user.name || user.email;
  document.querySelector('#user-role').textContent = ROLE_LABELS[user.role] || user.role;
  document.querySelector('#tree-title').textContent = tree.name;
}
export function setStatus(message, tone = 'normal') {
  const el = document.querySelector('#status-line');
  el.textContent = message || '';
  el.dataset.tone = tone;
}
export function setSaveState({ dirty, role, busy = false, previewMode = false }) {
  const b = document.querySelector('#save-button');
  if (role === 'viewer' || previewMode) return b.classList.add('hidden');
  b.classList.remove('hidden');
  b.disabled = !dirty || busy;
  b.textContent = busy
    ? 'Сохраняю…'
    : !dirty
      ? 'Сохранено'
      : role === 'admin'
        ? 'Сохранить'
        : 'Предложить';
}

export function renderProposals(proposals, currentTree, handlers) {
  const list = document.querySelector('#proposals-list');
  if (!proposals.length) {
    list.innerHTML = '<div class="empty-state">Новых предложений нет.</div>';
    return;
  }
  list.innerHTML = proposals
    .map((item) => {
      const author = item.expand?.author;
      const diff = handlers.diff(currentTree.data, item.data);
      const conflict = Number(item.base_revision) !== Number(currentTree.revision);
      return `<article class="proposal-card" data-id="${escapeHtml(item.id)}"><div class="proposal-card-head"><div><strong>${escapeHtml(author?.name || author?.email || 'Пользователь')}</strong><p class="muted compact">${new Date(item.created).toLocaleString('ru-RU')}</p></div>${conflict ? '<span class="warning-badge">Старая версия</span>' : '<span class="ok-badge">Актуально</span>'}</div><p>${escapeHtml(item.comment || 'Комментарий не указан.')}</p><div class="diff-row"><span>Добавлено: ${diff.added}</span><span>Изменено: ${diff.changed}</span><span>Удалено: ${diff.removed}</span></div><div class="proposal-actions"><button type="button" class="ghost" data-action="preview">Посмотреть</button><button type="button" class="danger" data-action="reject">Отклонить</button><button type="button" class="primary" data-action="approve">Принять</button></div></article>`;
    })
    .join('');
  list.onclick = (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    handlers.onAction(button.dataset.action, button.closest('[data-id]').dataset.id);
  };
}
