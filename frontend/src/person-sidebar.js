import { SidebarZoomGuard } from './sidebar-zoom-guard.js';
import { getInitialMaidenName } from './person-relationship-rules.js';

const RELATION_CONFIG = {
  father: { label: 'отца', gender: 'M', lockGender: true },
  mother: { label: 'мать', gender: 'F', lockGender: true },
  parent: { label: 'другого родителя', gender: '' },
  spouse: { label: 'супруга', gender: 'M' },
  child: { label: 'ребёнка', gender: 'M' },
  sibling: { label: 'брата или сестру', gender: 'M' },
};

const FORM_CONTROL_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export class PersonSidebar {
  constructor(host) {
    if (!host) throw new Error('Person Sidebar host is required.');

    this.host = host;
    this.previousFocus = null;
    this.viewModel = null;
    this.handlers = {};
    this.editable = false;
    this.mode = 'view';
    this.busy = false;
    this.eventCleanups = [];
    this.viewportCleanups = [];
    this.maidenNameFormStates = new WeakMap();
    this.renderShell();
    this.zoomGuard = new SidebarZoomGuard(this.sidebar);
    this.bindEvents();
  }

  renderShell() {
    this.host.classList.add('person-sidebar-host');
    this.host.innerHTML = `
      <div class="person-sidebar-backdrop" aria-hidden="true"></div>
      <aside class="person-sidebar" aria-hidden="true" aria-labelledby="person-sidebar-title" role="dialog">
        <header class="person-sidebar-header">
          <p class="eyebrow" data-sidebar-mode-label>Карточка человека</p>
          <button class="icon-button" type="button" data-sidebar-close aria-label="Закрыть панель">×</button>
        </header>
        <div class="person-sidebar-scroll">
          <section data-sidebar-panel="view">
            <div class="person-sidebar-identity">
              <img class="person-sidebar-avatar hidden" alt="" />
              <div class="person-sidebar-placeholder" aria-hidden="true"><span></span></div>
              <h2 id="person-sidebar-title" tabindex="-1">Без имени</h2>
            </div>
            <dl class="person-sidebar-facts"></dl>
            <section class="person-sidebar-relations" aria-labelledby="person-sidebar-relations-title">
              <h3 id="person-sidebar-relations-title">Родственники</h3>
              <div class="person-sidebar-relation-groups"></div>
            </section>
          </section>

          <form id="person-sidebar-edit-form" class="hidden" data-sidebar-panel="edit">
            <h2 tabindex="-1">Изменить сведения</h2>
            <div class="person-sidebar-form-grid">
              <label>Фамилия<input name="last_name" autocomplete="family-name" /></label>
              <label class="hidden" data-maiden-name-field>Девичья фамилия<input name="maiden_name" /></label>
              <label>Имя<input name="first_name" autocomplete="given-name" required /></label>
              <label>Отчество<input name="middle_name" /></label>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label><label><input type="radio" name="gender" value="" /> Не указан</label></fieldset>
              <label>Дата рождения<input name="birth_date" type="date" /></label>
              <label>Дата смерти<input name="death_date" type="date" /></label>
              <label class="full">Место рождения<input name="birth_place" /></label>
              <label class="full">Профессия или занятие<input name="occupation" /></label>
              <label class="full">Заметки<textarea name="notes" rows="4"></textarea></label>
            </div>
            <section class="person-sidebar-edit-actions">
              <h3>Добавить родственника</h3>
              <div class="person-sidebar-relation-actions">
                <button type="button" class="ghost" data-sidebar-relation="father">Отца</button>
                <button type="button" class="ghost" data-sidebar-relation="mother">Мать</button>
                <button type="button" class="ghost" data-sidebar-relation="spouse">Супруга</button>
                <button type="button" class="ghost" data-sidebar-relation="child">Ребёнка</button>
                <button type="button" class="ghost" data-sidebar-relation="sibling">Брата/сестру</button>
              </div>
              <details class="person-sidebar-more-actions">
                <summary>Дополнительные действия</summary>
                <button type="button" class="ghost wide" data-sidebar-relation="parent">Другой родитель</button>
              </details>
              <button type="button" class="ghost wide" data-sidebar-photo>Изменить фотографию</button>
              <button type="button" class="danger wide" data-sidebar-delete>Удалить человека</button>
            </section>
          </form>

          <form id="person-sidebar-relative-form" class="hidden" data-sidebar-panel="relative">
            <h2 tabindex="-1" data-sidebar-relative-title>Добавить родственника</h2>
            <input name="relative_type" type="hidden" />
            <div class="person-sidebar-form-grid">
              <label>Фамилия<input name="last_name" /></label>
              <label class="hidden" data-maiden-name-field>Девичья фамилия<input name="maiden_name" /></label>
              <label>Имя<input name="first_name" required /></label>
              <label>Отчество<input name="middle_name" /></label>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" checked /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label><label><input type="radio" name="gender" value="" /> Не указан</label></fieldset>
              <label class="full">Дата рождения<input name="birth_date" type="date" /></label>
            </div>
          </form>

          <form id="person-sidebar-photo-form" class="hidden" data-sidebar-panel="photo">
            <h2 tabindex="-1">Фотография</h2>
            <p class="muted" data-sidebar-photo-name></p>
            <div class="person-sidebar-photo-preview"></div>
            <label>Новый файл<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
            <p class="muted compact">JPEG, PNG или WebP, не больше 10 МБ.</p>
            <button type="button" class="danger wide hidden" data-sidebar-remove-photo>Удалить фотографию</button>
          </form>

          <section class="hidden person-sidebar-delete" data-sidebar-panel="delete">
            <h2 tabindex="-1">Удалить человека?</h2>
            <p>Человек будет удалён из древа вместе со всеми связями с ним.</p>
            <p><strong data-sidebar-delete-name></strong></p>
          </section>
        </div>
        <footer class="person-sidebar-footer"></footer>
      </aside>
    `;

    this.sidebar = this.host.querySelector('.person-sidebar');
    this.backdrop = this.host.querySelector('.person-sidebar-backdrop');
    this.closeButton = this.host.querySelector('[data-sidebar-close]');
    this.modeLabel = this.host.querySelector('[data-sidebar-mode-label]');
    this.title = this.host.querySelector('#person-sidebar-title');
    this.avatar = this.host.querySelector('.person-sidebar-avatar');
    this.placeholder = this.host.querySelector('.person-sidebar-placeholder');
    this.facts = this.host.querySelector('.person-sidebar-facts');
    this.relationGroups = this.host.querySelector('.person-sidebar-relation-groups');
    this.footer = this.host.querySelector('.person-sidebar-footer');
    this.editForm = this.host.querySelector('#person-sidebar-edit-form');
    this.relativeForm = this.host.querySelector('#person-sidebar-relative-form');
    this.photoForm = this.host.querySelector('#person-sidebar-photo-form');
  }

  bindEvents() {
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.eventCleanups.push(() => target.removeEventListener(type, handler, options));
    };

    listen(this.closeButton, 'click', () => this.close());
    listen(this.backdrop, 'click', () => this.close());
    listen(this.host, 'click', (event) => {
      const button = event.target.closest('button');
      if (!button || button === this.closeButton) return;
      if (button.matches('[data-sidebar-edit]')) this.showMode('edit');
      if (button.matches('[data-sidebar-cancel]')) this.showMode('view');
      if (button.matches('[data-sidebar-relation]')) {
        this.showRelativeMode(button.dataset.sidebarRelation);
      }
      if (button.matches('[data-sidebar-photo]')) this.showMode('photo');
      if (button.matches('[data-sidebar-delete]')) this.showMode('delete');
      if (button.matches('[data-sidebar-confirm-delete]')) this.runAction('onDelete');
      if (button.matches('[data-sidebar-remove-photo]')) this.runAction('onRemovePhoto');
    });
    listen(this.editForm, 'submit', (event) => {
      event.preventDefault();
      this.runAction('onUpdate', Object.fromEntries(new FormData(this.editForm)));
    });
    listen(this.relativeForm, 'submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(this.relativeForm));
      const relation = values.relative_type;
      delete values.relative_type;
      this.runAction('onAddRelative', relation, values);
    });
    listen(this.photoForm, 'submit', (event) => {
      event.preventDefault();
      const file = new FormData(this.photoForm).get('photo');
      if (!file?.size) return;
      if (file.size > 10 * 1024 * 1024) {
        window.alert('Файл больше 10 МБ.');
        return;
      }
      this.runAction('onUploadPhoto', file);
    });
    listen(document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen()) this.close();
    });
    listen(this.sidebar, 'focusin', (event) => {
      if (!this.isOpen() || !event.target.matches?.(FORM_CONTROL_SELECTOR)) return;
      this.requestFrame(() => this.scrollControlIntoView(event.target));
    });

    for (const form of [this.editForm, this.relativeForm]) {
      this.maidenNameFormStates.set(form, { initialised: false });
      listen(form.elements.maiden_name, 'input', () => {
        this.maidenNameFormStates.get(form).initialised = true;
      });
      listen(form, 'change', (event) => {
        if (!event.target.matches('[name="gender"]')) return;
        this.updateMaidenNameField(form, { genderChanged: true });
      });
      this.updateMaidenNameField(form);
    }
  }

  open(viewModel, options = {}) {
    if (!viewModel) return this.close();

    if (!this.isOpen()) this.previousFocus = document.activeElement;
    this.viewModel = viewModel;
    this.editable = Boolean(options.editable);
    this.handlers = options.handlers || this.handlers;
    this.render(viewModel);
    this.showMode('view', { focus: false });
    this.host.classList.add('open');
    this.sidebar.setAttribute('aria-hidden', 'false');
    this.zoomGuard.activate();
    this.activateViewportHandling();
    this.closeButton.focus();
  }

  close() {
    this.zoomGuard.deactivate();
    this.deactivateViewportHandling();
    if (!this.isOpen()) return;

    this.host.classList.remove('open');
    this.sidebar.setAttribute('aria-hidden', 'true');
    this.mode = 'view';
    if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
    this.previousFocus = null;
  }

  destroy() {
    this.close();
    this.zoomGuard.destroy();
    for (const cleanup of this.eventCleanups.splice(0)) cleanup();
  }

  isOpen() {
    return this.host.classList.contains('open');
  }

  showRelativeMode(relation) {
    const config = RELATION_CONFIG[relation];
    if (!config) return;
    this.relativeForm.reset();
    for (const input of this.relativeForm.querySelectorAll('[name="gender"]')) {
      input.checked = input.value === config.gender;
    }
    this.relativeForm.querySelector('.person-sidebar-gender').disabled = Boolean(config.lockGender);
    this.maidenNameFormStates.set(this.relativeForm, { initialised: false });
    this.updateMaidenNameField(this.relativeForm);
    this.relativeForm.elements.relative_type.value = relation;
    this.relativeForm.querySelector('[data-sidebar-relative-title]').textContent =
      `Добавить ${config.label}`;
    this.showMode('relative');
  }

  requestFrame(callback) {
    const view = this.sidebar.ownerDocument?.defaultView;
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(callback);
    else callback();
  }

  scrollControlIntoView(control) {
    const scrollArea = this.host.querySelector('.person-sidebar-scroll');
    if (!scrollArea?.contains(control)) return;

    const controlRect = control.getBoundingClientRect();
    const scrollRect = scrollArea.getBoundingClientRect();
    const gap = 16;
    if (controlRect.top < scrollRect.top + gap) {
      scrollArea.scrollTop -= scrollRect.top + gap - controlRect.top;
    } else if (controlRect.bottom > scrollRect.bottom - gap) {
      scrollArea.scrollTop += controlRect.bottom - (scrollRect.bottom - gap);
    }
  }

  activateViewportHandling() {
    if (this.viewportCleanups.length) return;

    const doc = this.sidebar.ownerDocument;
    const view = doc?.defaultView;
    doc?.documentElement?.classList.add('person-sidebar-document-locked');
    doc?.body?.classList.add('person-sidebar-document-locked');

    const viewport = view?.visualViewport;
    const syncViewport = () => {
      const width = viewport?.width || view?.innerWidth;
      const height = viewport?.height || view?.innerHeight;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      if (width) this.sidebar.style.setProperty('--person-sidebar-visual-width', `${width}px`);
      if (height) this.sidebar.style.setProperty('--person-sidebar-visual-height', `${height}px`);
      this.sidebar.style.setProperty('--person-sidebar-visual-left', `${left}px`);
      this.sidebar.style.setProperty('--person-sidebar-visual-top', `${top}px`);

      const activeControl = doc?.activeElement;
      if (activeControl?.matches?.(FORM_CONTROL_SELECTOR)) {
        this.requestFrame(() => this.scrollControlIntoView(activeControl));
      }
    };
    const listen = (target, type) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, syncViewport, { passive: true });
      this.viewportCleanups.push(() => target.removeEventListener(type, syncViewport));
    };

    listen(viewport, 'resize');
    listen(viewport, 'scroll');
    listen(view, 'orientationchange');
    syncViewport();
  }

  deactivateViewportHandling() {
    for (const cleanup of this.viewportCleanups.splice(0)) cleanup();
    const doc = this.sidebar?.ownerDocument;
    doc?.documentElement?.classList.remove('person-sidebar-document-locked');
    doc?.body?.classList.remove('person-sidebar-document-locked');
    for (const property of [
      '--person-sidebar-visual-width',
      '--person-sidebar-visual-height',
      '--person-sidebar-visual-left',
      '--person-sidebar-visual-top',
    ]) {
      this.sidebar?.style.removeProperty(property);
    }
  }

  showMode(mode, { focus = true } = {}) {
    if (mode !== 'view' && !this.editable) return;
    this.mode = mode;
    for (const panel of this.host.querySelectorAll('[data-sidebar-panel]')) {
      panel.classList.toggle('hidden', panel.dataset.sidebarPanel !== mode);
    }

    const labels = {
      view: 'Карточка человека',
      edit: 'Редактирование',
      relative: 'Новый родственник',
      photo: 'Фотография',
      delete: 'Удаление',
    };
    this.modeLabel.textContent = labels[mode];
    if (mode === 'edit') this.populateEditForm();
    if (mode === 'photo') this.populatePhotoForm();
    if (mode === 'delete') {
      this.host.querySelector('[data-sidebar-delete-name]').textContent = this.viewModel.fullName;
    }
    this.renderFooter();

    if (focus) {
      const panel = this.host.querySelector(`[data-sidebar-panel="${mode}"]`);
      (panel.querySelector('h2') || panel.querySelector('input') || this.closeButton).focus();
    }
  }

  renderFooter() {
    if (this.mode === 'view') {
      this.footer.innerHTML = this.editable
        ? '<button class="primary" type="button" data-sidebar-edit>Редактировать</button>'
        : '<p class="person-sidebar-notice">Только просмотр</p>';
      return;
    }

    const submitButtons = {
      edit: '<button class="primary" type="submit" form="person-sidebar-edit-form">Применить</button>',
      relative:
        '<button class="primary" type="submit" form="person-sidebar-relative-form">Создать</button>',
      photo:
        '<button class="primary" type="submit" form="person-sidebar-photo-form">Загрузить</button>',
      delete: '<button class="danger" type="button" data-sidebar-confirm-delete>Удалить</button>',
    };
    this.footer.innerHTML = `<button class="ghost" type="button" data-sidebar-cancel>Назад</button>${submitButtons[this.mode]}`;
  }

  populateEditForm() {
    for (const [key, value] of Object.entries(this.viewModel.values)) {
      const field = this.editForm.elements.namedItem(key);
      if (field && key !== 'gender') field.value = value || '';
    }
    const genderValue = ['M', 'F'].includes(this.viewModel.values.gender)
      ? this.viewModel.values.gender
      : '';
    const gender = [...this.editForm.querySelectorAll('[name="gender"]')].find(
      (input) => input.value === genderValue,
    );
    if (gender) gender.checked = true;
    this.maidenNameFormStates.set(this.editForm, { initialised: false });
    this.updateMaidenNameField(this.editForm);
  }

  updateMaidenNameField(form, { genderChanged = false } = {}) {
    const maidenNameField = form.querySelector('[data-maiden-name-field]');
    const maidenNameInput = form.elements.maiden_name;
    const selectedGender = form.elements.gender.value;
    const isFemale = selectedGender === 'F';
    const state = this.maidenNameFormStates.get(form);

    if (genderChanged && isFemale && !state.initialised) {
      maidenNameInput.value = getInitialMaidenName({
        last_name: form.elements.last_name.value,
        maiden_name: maidenNameInput.value,
      });
      state.initialised = true;
    }

    maidenNameField.classList.toggle('hidden', !isFemale);
  }

  populatePhotoForm() {
    this.photoForm.reset();
    this.photoForm.querySelector('[data-sidebar-photo-name]').textContent = this.viewModel.fullName;
    const preview = this.photoForm.querySelector('.person-sidebar-photo-preview');
    preview.replaceChildren();
    if (this.viewModel.photoUrl) {
      const image = document.createElement('img');
      image.src = this.viewModel.photoUrl;
      image.alt = `Фотография: ${this.viewModel.fullName}`;
      image.className = 'person-sidebar-avatar';
      preview.append(image);
    } else {
      const empty = document.createElement('p');
      empty.className = 'person-sidebar-empty';
      empty.textContent = 'Фотография не загружена.';
      preview.append(empty);
    }
    this.photoForm
      .querySelector('[data-sidebar-remove-photo]')
      .classList.toggle('hidden', !this.viewModel.photoUrl);
  }

  async runAction(handlerName, ...args) {
    if (!this.editable || this.busy || typeof this.handlers[handlerName] !== 'function') return;
    this.busy = true;
    for (const button of this.host.querySelectorAll('button')) button.disabled = true;
    try {
      const nextViewModel = await this.handlers[handlerName](this.viewModel.id, ...args);
      if (!nextViewModel) {
        this.close();
        return;
      }
      this.viewModel = nextViewModel;
      this.render(nextViewModel);
      this.showMode('view');
    } catch (error) {
      window.alert(error.message || error);
    } finally {
      this.busy = false;
      for (const button of this.host.querySelectorAll('button')) button.disabled = false;
    }
  }

  render(viewModel) {
    this.title.textContent = viewModel.fullName;

    if (viewModel.photoUrl) {
      this.avatar.src = viewModel.photoUrl;
      this.avatar.alt = `Фотография: ${viewModel.fullName}`;
      this.avatar.classList.remove('hidden');
      this.placeholder.classList.add('hidden');
    } else {
      this.avatar.removeAttribute('src');
      this.avatar.alt = '';
      this.avatar.classList.add('hidden');
      this.placeholder.querySelector('span').textContent = viewModel.initials;
      this.placeholder.classList.remove('hidden');
    }

    this.facts.replaceChildren();
    if (!viewModel.fields.length) {
      const empty = document.createElement('p');
      empty.className = 'person-sidebar-empty';
      empty.textContent = 'Дополнительные сведения не указаны.';
      this.facts.append(empty);
    } else {
      for (const field of viewModel.fields) {
        const item = document.createElement('div');
        item.className = `person-sidebar-fact person-sidebar-fact-${field.key}`;
        const label = document.createElement('dt');
        label.textContent = field.label;
        const value = document.createElement('dd');
        value.textContent = field.value;
        item.append(label, value);
        this.facts.append(item);
      }
    }

    this.relationGroups.replaceChildren();
    for (const group of viewModel.relationGroups) {
      const section = document.createElement('section');
      section.className = 'person-sidebar-relation-group';
      const heading = document.createElement('h4');
      heading.textContent = group.label;
      section.append(heading);

      if (!group.people.length) {
        const empty = document.createElement('p');
        empty.className = 'person-sidebar-empty';
        empty.textContent = 'Не указаны';
        section.append(empty);
      } else {
        const list = document.createElement('ul');
        for (const person of group.people) {
          const item = document.createElement('li');
          const initials = document.createElement('span');
          initials.className = 'relation-avatar';
          initials.textContent = person.initials;
          const name = document.createElement('span');
          name.textContent = person.name;
          const description = document.createElement('span');
          description.className = 'person-sidebar-relation-description';
          if (person.roleLabel) {
            const role = document.createElement('span');
            role.className = 'person-sidebar-relation-role';
            role.textContent = person.roleLabel;
            description.append(role);
          }
          description.append(name);
          item.append(initials, description);
          list.append(item);
        }
        section.append(list);
      }

      this.relationGroups.append(section);
    }
  }
}
