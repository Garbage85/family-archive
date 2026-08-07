import {
  getProposalApprovalBlockReason,
  isProposalCurrent,
} from './proposal-revision.js';
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
        <header class="topbar app-ui-chrome" data-ui-chrome>
          <div class="brand-row"><div class="brand-mark small">ДЖ</div><div><strong id="tree-title">Древо жизни</strong><div id="tree-meta" class="muted compact"></div></div></div>
          <div class="user-row"><span id="user-name"></span><span id="user-role" class="role-badge"></span><button id="logout-button" class="ghost">Выйти</button></div>
        </header>
        <nav class="toolbar app-ui-chrome" data-ui-chrome>
          <button id="center-person-button" class="center-person-button ghost" type="button" aria-label="Выбрать центрального человека"><span class="center-person-prefix">Центр:</span> <span id="center-person-name">—</span></button>
          <div id="search-host" class="search-host"></div>
          <div class="toolbar-menu-shell">
            <button id="toolbar-menu-button" class="ghost toolbar-icon-button" type="button" aria-label="Открыть меню инструментов" aria-haspopup="menu" aria-expanded="false" aria-controls="toolbar-menu">⋮</button>
            <div id="toolbar-menu" class="toolbar-menu" role="menu" aria-label="Инструменты дерева">
              <button id="fit-button" class="ghost" type="button" role="menuitem">Показать всё</button>
              <button id="orientation-button" class="ghost" type="button" role="menuitem">Горизонтально</button>
              <button id="export-button" class="ghost" type="button" role="menuitem">Экспорт</button>
              <button id="proposals-button" class="ghost hidden" type="button" role="menuitem">Предложения <span id="proposal-count"></span></button>
            </div>
          </div>
          <button id="save-button" class="primary save-button" type="button" aria-label="Сохранить изменения" disabled><span class="save-button-icon" aria-hidden="true">✓</span><span class="save-button-label">Сохранено</span></button>
        </nav>
        <div id="status-line" class="status-line app-ui-chrome" data-ui-chrome role="status"></div>
        <div id="FamilyChart" class="f3 chart-surface" data-tree-canvas></div>
        <div id="person-sidebar-host"></div>
      </section>
    </main>

    <dialog id="comment-dialog" class="dialog-card app-ui-chrome" data-ui-chrome><form id="comment-form"><h2>Предложить изменение</h2><label>Комментарий<textarea id="proposal-comment" rows="4" maxlength="500"></textarea></label><div class="dialog-actions"><button type="button" data-close-dialog="comment-dialog" class="ghost">Отмена</button><button class="primary">Отправить</button></div></form></dialog>
    <dialog id="proposals-dialog" class="dialog-card proposals-dialog app-ui-chrome" data-ui-chrome><form method="dialog"><div class="dialog-heading"><div><p class="eyebrow">Модерация</p><h2>Предложения родственников</h2></div><button type="button" data-close-dialog="proposals-dialog" class="ghost">Закрыть</button></div><div id="proposals-list" class="proposal-list"></div></form></dialog>
    <dialog id="kinship-dialog" class="dialog-card kinship-dialog app-ui-chrome" data-ui-chrome aria-labelledby="kinship-dialog-title"><div class="dialog-heading"><div><p class="eyebrow">Родство</p><h2 id="kinship-dialog-title">Как мы связаны</h2></div><button type="button" data-kinship-close class="ghost">Закрыть</button></div><div class="kinship-dialog-scroll"><div data-kinship-content></div><button type="button" class="ghost hidden" data-kinship-toggle aria-expanded="false"></button><div class="kinship-alternatives hidden" data-kinship-alternatives></div></div></dialog>
  `;
}

export function setCenterPersonLabel(label) {
  const element = document.querySelector('#center-person-name');
  if (element) element.textContent = label || '—';
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
export function setSaveState({ dirty, role, busy = false, previewMode = false, outcome = 'idle' }) {
  const b = document.querySelector('#save-button');
  const hidden = role === 'viewer' || previewMode;
  b.classList.toggle('hidden', hidden);
  b.setAttribute('aria-hidden', String(hidden));
  if (hidden) {
    b.disabled = true;
    return;
  }

  const state = busy
    ? 'busy'
    : outcome === 'error'
      ? 'error'
      : outcome === 'success'
        ? 'success'
        : 'idle';
  const action = role === 'member' ? 'propose' : 'save';
  const label = busy
    ? role === 'member'
      ? 'Отправляю…'
      : 'Сохраняю…'
    : outcome === 'error'
      ? 'Повторить'
      : !dirty
        ? 'Сохранено'
        : role === 'admin'
          ? 'Сохранить'
          : 'Предложить';

  b.disabled = !dirty || busy;
  b.dataset.action = action;
  b.dataset.state = state;
  b.setAttribute(
    'aria-label',
    action === 'propose' ? 'Отправить предложение' : 'Сохранить изменения',
  );
  b.title = busy
    ? label
    : outcome === 'error'
      ? 'Не удалось сохранить. Повторить'
      : outcome === 'success'
        ? role === 'member'
          ? 'Предложение отправлено'
          : 'Изменения сохранены'
        : action === 'propose'
          ? 'Отправить предложение'
          : 'Сохранить изменения';
  b.querySelector('.save-button-icon').textContent = busy ? '…' : outcome === 'error' ? '!' : '✓';
  b.querySelector('.save-button-label').textContent = label;
}

export function setupToolbarMenu(doc = document) {
  const button = doc.querySelector('#toolbar-menu-button');
  const menu = doc.querySelector('#toolbar-menu');
  let open = false;

  const setOpen = (nextOpen, { returnFocus = false } = {}) => {
    open = nextOpen;
    menu.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      const firstItem = [...menu.querySelectorAll('button')].find(
        (item) => !item.classList.contains('hidden') && !item.disabled,
      );
      firstItem?.focus();
    } else if (returnFocus) {
      button.focus();
    }
  };
  const onButtonClick = () => setOpen(!open);
  const onMenuClick = (event) => {
    if (event.target.closest('button')) setOpen(false);
  };
  const onDocumentClick = (event) => {
    if (open && !button.contains(event.target) && !menu.contains(event.target)) setOpen(false);
  };
  const onDocumentKeydown = (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, { returnFocus: true });
    }
  };

  button.addEventListener('click', onButtonClick);
  menu.addEventListener('click', onMenuClick);
  doc.addEventListener('click', onDocumentClick);
  doc.addEventListener('keydown', onDocumentKeydown);

  return {
    get open() {
      return open;
    },
    close: (options) => setOpen(false, options),
    destroy() {
      button.removeEventListener('click', onButtonClick);
      menu.removeEventListener('click', onMenuClick);
      doc.removeEventListener('click', onDocumentClick);
      doc.removeEventListener('keydown', onDocumentKeydown);
    },
  };
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
      const current = isProposalCurrent(item, currentTree.revision);
      const staleReason = getProposalApprovalBlockReason(item, currentTree.revision);
      const approveControl = current
        ? '<button type="button" class="primary" data-action="approve">Принять</button>'
        : `<button type="button" class="primary" data-action="approve" disabled title="${escapeHtml(staleReason)}" aria-disabled="true">Принять</button>`;
      const staleHint = current
        ? ''
        : `<p class="proposal-stale-hint" role="status">${escapeHtml(staleReason)}</p>`;
      return `<article class="proposal-card" data-id="${escapeHtml(item.id)}"><div class="proposal-card-head"><div><strong>${escapeHtml(author?.name || author?.email || 'Пользователь')}</strong><p class="muted compact">${new Date(item.created).toLocaleString('ru-RU')}</p></div>${current ? '<span class="ok-badge">Актуально</span>' : '<span class="warning-badge">Старая версия</span>'}</div><p>${escapeHtml(item.comment || 'Комментарий не указан.')}</p>${staleHint}<div class="diff-row"><span>Добавлено: ${diff.added}</span><span>Изменено: ${diff.changed}</span><span>Удалено: ${diff.removed}</span></div><div class="proposal-actions"><button type="button" class="ghost" data-action="preview">Посмотреть</button><button type="button" class="danger" data-action="reject">Отклонить</button>${approveControl}</div></article>`;
    })
    .join('');
  list.onclick = (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    handlers.onAction(button.dataset.action, button.closest('[data-id]').dataset.id);
  };
}
