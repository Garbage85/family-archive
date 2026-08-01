import { ROLE_LABELS, personName } from './tree-utils.js';

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
        <div id="drawer-backdrop" class="drawer-backdrop hidden"></div>
        <aside id="person-drawer" class="person-drawer" aria-hidden="true">
          <form id="person-form">
            <header class="drawer-header">
              <div><p class="eyebrow">Карточка человека</p><h2 id="drawer-title">Без имени</h2></div>
              <button id="drawer-close" type="button" class="icon-button" aria-label="Закрыть">×</button>
            </header>
            <div class="drawer-scroll">
              <div class="photo-block"><img id="person-avatar" class="person-avatar hidden" alt="" /><div id="avatar-placeholder" class="avatar-placeholder">Фото</div><button id="photo-button" type="button" class="ghost">Загрузить фотографию</button></div>
              <div class="form-grid">
                <label>Фамилия<input name="last_name" autocomplete="family-name" /></label>
                <label>Имя<input name="first_name" autocomplete="given-name" required /></label>
                <label>Отчество<input name="middle_name" /></label>
                <fieldset class="gender-field"><legend>Пол</legend><label><input type="radio" name="gender" value="M" /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label></fieldset>
                <label>Дата рождения<input name="birth_date" type="date" /></label>
                <label>Дата смерти<input name="death_date" type="date" /></label>
                <label class="full">Место рождения<input name="birth_place" /></label>
                <label class="full">Профессия или занятие<input name="occupation" /></label>
                <label class="full">Заметки<textarea name="notes" rows="4"></textarea></label>
              </div>
              <section class="relations-section"><h3>Добавить родственника</h3><div class="relation-buttons"><button type="button" class="ghost" data-relation="parent">Родителя</button><button type="button" class="ghost" data-relation="spouse">Супруга</button><button type="button" class="ghost" data-relation="child">Ребёнка</button><button type="button" class="ghost" data-relation="sibling">Брата или сестру</button></div></section>
              <button id="delete-person" type="button" class="danger wide">Удалить человека</button>
            </div>
            <footer class="drawer-footer"><button id="drawer-cancel" type="button" class="ghost">Отмена</button><button type="submit" class="primary">Применить</button></footer>
          </form>
        </aside>
      </section>
    </main>

    <dialog id="relative-dialog" class="dialog-card">
      <form id="relative-form">
        <input id="relative-type" name="relative_type" type="hidden" />
        <h2 id="relative-title">Добавить родственника</h2>
        <div class="form-grid">
          <label>Имя<input name="first_name" required /></label><label>Фамилия<input name="last_name" /></label><label>Отчество<input name="middle_name" /></label>
          <fieldset class="gender-field"><legend>Пол</legend><label><input type="radio" name="gender" value="M" checked /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label></fieldset>
          <label class="full">Дата рождения<input name="birth_date" type="date" /></label>
        </div>
        <div class="dialog-actions"><button type="button" data-close-dialog="relative-dialog" class="ghost">Отмена</button><button class="primary">Создать</button></div>
      </form>
    </dialog>

    <dialog id="comment-dialog" class="dialog-card"><form id="comment-form"><h2>Предложить изменение</h2><label>Комментарий<textarea id="proposal-comment" rows="4" maxlength="500"></textarea></label><div class="dialog-actions"><button type="button" data-close-dialog="comment-dialog" class="ghost">Отмена</button><button class="primary">Отправить</button></div></form></dialog>
    <dialog id="photo-dialog" class="dialog-card"><form id="photo-form"><h2>Фотография</h2><p id="photo-person-name" class="muted"></p><label>Файл<input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp" required /></label><div class="dialog-actions"><button type="button" data-close-dialog="photo-dialog" class="ghost">Отмена</button><button class="primary">Загрузить</button></div></form></dialog>
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
export function setSaveState({ dirty, role, busy = false }) {
  const b = document.querySelector('#save-button');
  if (role === 'viewer') return b.classList.add('hidden');
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

export function openPersonDrawer(person, editable) {
  const drawer = document.querySelector('#person-drawer');
  const form = document.querySelector('#person-form');
  form.dataset.personId = person.id;
  document.querySelector('#drawer-title').textContent = personName(person);
  for (const [key, value] of Object.entries(person.data)) {
    const field = form.elements.namedItem(key);
    if (field && key !== 'gender') field.value = value || '';
  }
  const gender = form.querySelector(`[name="gender"][value="${person.data.gender}"]`);
  if (gender) gender.checked = true;
  const img = document.querySelector('#person-avatar');
  const placeholder = document.querySelector('#avatar-placeholder');
  if (person.data.avatar) {
    img.src = person.data.avatar;
    img.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
  for (const field of form.querySelectorAll(
    'input, textarea, button[data-relation], #delete-person, #photo-button',
  ))
    field.disabled = !editable;
  form.querySelector('button[type="submit"]').classList.toggle('hidden', !editable);
  document.querySelector('#drawer-cancel').textContent = editable ? 'Отмена' : 'Закрыть';
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.querySelector('#drawer-backdrop').classList.remove('hidden');
}
export function closePersonDrawer() {
  const d = document.querySelector('#person-drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  document.querySelector('#drawer-backdrop').classList.add('hidden');
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
