import { SidebarZoomGuard } from './sidebar-zoom-guard.js';
import {
  buildRelativeDraft,
  getRelativeActionTypes,
  markDraftFieldExplicit,
  mergeRelativeDraft,
  resetDraftFieldSuggestion,
} from './person-autofill.js';

const RELATION_CONFIG = {
  father: { action: 'Отец', label: 'отца', lockGender: true },
  mother: { action: 'Мать', label: 'мать', lockGender: true },
  son: { action: 'Сын', label: 'сына', lockGender: true },
  daughter: { action: 'Дочь', label: 'дочь', lockGender: true },
  brother: { action: 'Брат', label: 'брата', lockGender: true },
  sister: { action: 'Сестра', label: 'сестру', lockGender: true },
  husband: { action: 'Супруг', label: 'супруга', lockGender: true },
  wife: { action: 'Супруга', label: 'супругу', lockGender: true },
  spouse: { action: 'Супруг(а)', label: 'супруга/супругу' },
  parent: { action: 'Другой родитель', label: 'другого родителя' },
};

const AUTOFILL_FIELD_NAMES = {
  first_name: 'first_name',
  last_name: 'last_name',
  middle_name: 'patronymic',
  gender: 'gender',
  maiden_name: 'maiden_name',
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
    this.people = [];
    this.getPeople = null;
    this.relativeDraft = null;
    this.relativeContext = null;
    this.eventCleanups = [];
    this.viewportCleanups = [];
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
            <section class="person-sidebar-kinship" aria-label="Родство с центром дерева">
              <p class="person-sidebar-kinship-label" data-sidebar-kinship-label></p>
              <div class="person-sidebar-kinship-actions">
                <button type="button" class="ghost" data-sidebar-show-kinship>Как мы связаны</button>
                <button type="button" class="ghost" data-sidebar-set-center>Сделать центром дерева</button>
              </div>
            </section>
            <dl class="person-sidebar-facts"></dl>
            <section class="person-sidebar-relations" aria-labelledby="person-sidebar-relations-title">
              <h3 id="person-sidebar-relations-title">Родственники</h3>
              <div class="person-sidebar-relation-groups"></div>
            </section>
          </section>

          <form id="person-sidebar-edit-form" class="hidden" data-sidebar-panel="edit">
            <h2 tabindex="-1">Изменить сведения</h2>
            <div class="person-sidebar-form-grid">
              <label class="hidden" data-maiden-name-field>Девичья фамилия<input name="maiden_name" /></label>
              <label data-last-name-field><span data-last-name-label>Фамилия</span><input name="last_name" autocomplete="family-name" /></label>
              <label>Имя<input name="first_name" autocomplete="given-name" required /></label>
              <label>Отчество<input name="middle_name" /></label>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label><label><input type="radio" name="gender" value="" /> Не указан</label></fieldset>
              <label>Дата рождения<input name="birth_date" type="date" /></label>
              <label>Дата смерти<input name="death_date" type="date" /></label>
              <label class="full">Место рождения<input name="birth_place" /></label>
              <label class="full">Профессия или занятие<input name="occupation" /></label>
              <label class="full">Заметки<textarea name="notes" rows="4" placeholder="Добавьте заметку о человеке"></textarea></label>
            </div>
            <section class="person-sidebar-edit-actions">
              <h3>Добавить родственника</h3>
              <div class="person-sidebar-relation-actions" data-sidebar-relation-actions></div>
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
              <div class="person-sidebar-autofill-field hidden" data-maiden-name-field data-autofill-control="maiden_name">
                <label>Девичья фамилия<input name="maiden_name" /></label>
                <div class="person-sidebar-autofill-meta"><span class="hidden" data-autofill-badge>Предложено автоматически</span><button class="hidden" type="button" data-autofill-reset="maiden_name">Сбросить подсказку</button></div>
              </div>
              <div class="person-sidebar-autofill-field" data-last-name-field data-autofill-control="last_name">
                <label><span data-last-name-label>Фамилия</span><input name="last_name" /></label>
                <div class="person-sidebar-autofill-meta"><span class="hidden" data-autofill-badge>Предложено автоматически</span><button class="hidden" type="button" data-autofill-reset="last_name">Сбросить подсказку</button></div>
              </div>
              <div class="person-sidebar-autofill-field" data-autofill-control="first_name">
                <label>Имя<input name="first_name" required /></label>
                <div class="person-sidebar-autofill-meta"><span class="hidden" data-autofill-badge>Предложено автоматически</span><button class="hidden" type="button" data-autofill-reset="first_name">Сбросить подсказку</button></div>
              </div>
              <div class="person-sidebar-autofill-field" data-autofill-control="patronymic">
                <label>Отчество<input name="middle_name" /></label>
                <div class="person-sidebar-autofill-meta"><span class="hidden" data-autofill-badge>Предложено автоматически</span><button class="hidden" type="button" data-autofill-reset="patronymic">Сбросить подсказку</button></div>
              </div>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label><label><input type="radio" name="gender" value="" /> Не указан</label></fieldset>
              <label class="full">Дата рождения<input name="birth_date" type="date" /></label>
            </div>
            <p class="person-sidebar-required-link" data-sidebar-required-link></p>
            <section class="person-sidebar-suggestions hidden" data-sidebar-suggestions>
              <h3>Предлагаемые связи</h3>
              <div data-sidebar-suggestion-list></div>
            </section>
            <ul class="person-sidebar-warnings hidden" data-sidebar-warnings></ul>
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
      if (button.matches('[data-autofill-reset]')) {
        this.resetRelativeSuggestion(button.dataset.autofillReset);
      }
      if (button.matches('[data-sidebar-photo]')) this.showMode('photo');
      if (button.matches('[data-sidebar-delete]')) this.showMode('delete');
      if (button.matches('[data-sidebar-confirm-delete]')) this.runAction('onDelete');
      if (button.matches('[data-sidebar-remove-photo]')) this.runAction('onRemovePhoto');
      if (button.matches('[data-sidebar-show-kinship]')) {
        this.handlers.onShowKinship?.(this.viewModel.id);
      }
      if (button.matches('[data-sidebar-set-center]') && !button.disabled) {
        this.handlers.onSetCenter?.(this.viewModel.id);
      }
    });
    listen(this.editForm, 'submit', (event) => {
      event.preventDefault();
      this.runAction('onUpdate', Object.fromEntries(new FormData(this.editForm)));
    });
    listen(this.relativeForm, 'submit', (event) => {
      event.preventDefault();
      const formData = new FormData(this.relativeForm);
      const values = Object.fromEntries(formData);
      const relation = values.relative_type;
      delete values.relative_type;
      delete values.suggested_link;
      const selectedLinkIds = new Set(formData.getAll('suggested_link').map(String));
      const links = (this.relativeDraft?.suggestedLinks || [])
        .filter((item) => selectedLinkIds.has(item.id))
        .map(({ personId, relation: linkRelation }) => ({ personId, relation: linkRelation }));
      this.runAction('onAddRelative', relation, values, links);
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

    listen(this.editForm, 'change', (event) => {
      if (!event.target.matches('[name="gender"]')) return;
      this.updateSurnameFieldPresentation(this.editForm);
    });
    this.updateSurnameFieldPresentation(this.editForm);

    listen(this.relativeForm, 'input', (event) => {
      const field = AUTOFILL_FIELD_NAMES[event.target.name];
      if (!field || field === 'gender' || !this.relativeDraft) return;
      this.relativeDraft = markDraftFieldExplicit(this.relativeDraft, field, event.target.value);
      this.renderAutofillFieldState(field);
    });
    listen(this.relativeForm, 'change', (event) => {
      if (event.target.matches('[name="suggested_link"]')) {
        this.updateSuggestedLinkSelection(event.target.value, event.target.checked);
      }
      if (event.target.matches('[name="gender"]') && this.relativeDraft) {
        this.relativeDraft = markDraftFieldExplicit(
          this.relativeDraft,
          'gender',
          event.target.value,
        );
        this.relativeContext = { ...this.relativeContext, genderOverride: event.target.value };
        this.relativeDraft = mergeRelativeDraft(this.relativeDraft, this.buildFreshRelativeDraft());
        this.applyRelativeDraft();
      }
    });
  }

  open(viewModel, options = {}) {
    if (!viewModel) return this.close();

    if (!this.isOpen()) this.previousFocus = document.activeElement;
    this.viewModel = viewModel;
    this.editable = Boolean(options.editable);
    this.handlers = options.handlers || this.handlers;
    this.people = Array.isArray(options.people) ? options.people : this.people;
    this.getPeople = typeof options.getPeople === 'function' ? options.getPeople : this.getPeople;
    this.relationship = options.relationship || null;
    this.isCenter = Boolean(options.isCenter);
    this.render(viewModel);
    this.showMode('view', { focus: false });
    this.host.classList.add('open');
    this.sidebar.setAttribute('aria-hidden', 'false');
    this.zoomGuard.activate();
    this.activateViewportHandling();
    this.closeButton.focus();
  }

  setKinshipContext(relationship, isCenter = false) {
    this.relationship = relationship || null;
    this.isCenter = Boolean(isCenter);
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
    const selectedPerson = this.getSelectedPerson();
    if (!selectedPerson) return;
    this.relativeForm.reset();
    this.relativeForm.querySelector('.person-sidebar-gender').disabled = Boolean(config.lockGender);
    this.relativeForm.elements.relative_type.value = relation;
    this.relativeContext = {
      selectedPerson,
      relationType: relation,
      people: this.currentPeople(),
    };
    this.relativeDraft = buildRelativeDraft(this.relativeContext);
    this.applyRelativeDraft();
    this.relativeForm.querySelector('[data-sidebar-relative-title]').textContent =
      `Добавить ${config.label}`;
    this.showMode('relative');
  }

  getSelectedPerson() {
    const selected = this.currentPeople().find(
      (person) => String(person?.id) === String(this.viewModel?.id),
    );
    if (selected) return selected;
    if (!this.viewModel) return null;
    return {
      id: this.viewModel.id,
      data: this.viewModel.values || {},
      rels: { parents: [], spouses: [], children: [] },
    };
  }

  currentPeople() {
    const people = this.getPeople?.();
    return Array.isArray(people) ? people : this.people;
  }

  buildFreshRelativeDraft() {
    if (!this.relativeContext) return null;
    const selectedSecondParents = (this.relativeDraft?.suggestedLinks || []).filter(
      (item) => item.kind === 'second-parent' && item.checked,
    );
    return buildRelativeDraft({
      ...this.relativeContext,
      secondParentId:
        selectedSecondParents.length === 1 ? selectedSecondParents[0].personId : undefined,
    });
  }

  applyRelativeDraft() {
    if (!this.relativeDraft) return;
    const values = {
      first_name: this.relativeDraft.person.first_name,
      last_name: this.relativeDraft.person.last_name,
      middle_name: this.relativeDraft.person.patronymic,
      maiden_name: this.relativeDraft.person.maiden_name,
    };
    for (const [name, value] of Object.entries(values)) {
      this.relativeForm.elements[name].value = value;
    }
    for (const input of this.relativeForm.querySelectorAll('[name="gender"]')) {
      input.checked = input.value === this.relativeDraft.person.gender;
    }
    for (const field of Object.values(AUTOFILL_FIELD_NAMES)) this.renderAutofillFieldState(field);
    this.updateSurnameFieldPresentation(this.relativeForm);
    this.renderRelativeLinks();
    this.renderRelativeWarnings();
  }

  renderAutofillFieldState(field) {
    const container = this.relativeForm.querySelector(`[data-autofill-control="${field}"]`);
    if (!container || !this.relativeDraft) return;
    const source = this.relativeDraft.fieldSources[field];
    const badge = container.querySelector('[data-autofill-badge]');
    const reset = container.querySelector('[data-autofill-reset]');
    badge?.classList.toggle('hidden', source !== 'suggested');
    const freshDraft = this.buildFreshRelativeDraft();
    reset?.classList.toggle('hidden', freshDraft?.fieldSources?.[field] !== 'suggested');
    container.classList.toggle('is-suggested', source === 'suggested');
  }

  resetRelativeSuggestion(field) {
    if (!this.relativeDraft) return;
    const freshDraft = this.buildFreshRelativeDraft();
    if (!freshDraft) return;
    this.relativeDraft = resetDraftFieldSuggestion(this.relativeDraft, freshDraft, field);
    this.applyRelativeDraft();
    const inputName = field === 'patronymic' ? 'middle_name' : field;
    this.relativeForm.elements[inputName]?.focus();
  }

  updateSuggestedLinkSelection(linkId, checked) {
    const selectedLink = this.relativeDraft?.suggestedLinks.find((item) => item.id === linkId);
    if (!selectedLink) return;
    selectedLink.checked = checked;
    if (selectedLink.kind !== 'second-parent') return;
    const freshDraft = this.buildFreshRelativeDraft();
    this.relativeDraft = mergeRelativeDraft(this.relativeDraft, freshDraft);
    this.applyRelativeDraft();
  }

  renderRelativeLinks() {
    const required = this.relativeForm.querySelector('[data-sidebar-required-link]');
    required.textContent = this.relativeDraft.requiredLinks[0]?.label || '';

    const section = this.relativeForm.querySelector('[data-sidebar-suggestions]');
    const list = this.relativeForm.querySelector('[data-sidebar-suggestion-list]');
    list.replaceChildren();
    const links = this.relativeDraft.suggestedLinks;
    section.classList.toggle('hidden', links.length === 0);
    if (!links.length) return;

    if (links.some((item) => item.kind === 'shared-parent')) {
      const intro = document.createElement('p');
      intro.className = 'person-sidebar-suggestion-intro';
      intro.textContent = 'Использовать тех же родителей:';
      list.append(intro);
    }
    for (const item of links) {
      const label = document.createElement('label');
      label.className = 'person-sidebar-suggestion';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'suggested_link';
      input.value = item.id;
      input.checked = item.checked;
      const text = document.createElement('span');
      text.textContent = item.label;
      label.append(input, text);
      list.append(label);
    }
  }

  renderRelativeWarnings() {
    const list = this.relativeForm.querySelector('[data-sidebar-warnings]');
    list.replaceChildren();
    list.classList.toggle('hidden', this.relativeDraft.warnings.length === 0);
    for (const warning of this.relativeDraft.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }
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
    const cancelLabel = this.mode === 'relative' ? 'Отмена' : 'Назад';
    this.footer.innerHTML = `<button class="ghost" type="button" data-sidebar-cancel>${cancelLabel}</button>${submitButtons[this.mode]}`;
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
    this.updateSurnameFieldPresentation(this.editForm);
  }

  updateSurnameFieldPresentation(form) {
    const maidenNameField = form.querySelector('[data-maiden-name-field]');
    const isFemale = form.elements.gender.value === 'F';
    maidenNameField.classList.toggle('hidden', !isFemale);
    const label = form.querySelector('[data-last-name-label]');
    if (label) label.textContent = 'Фамилия';
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

  renderRelationActions() {
    const container = this.host.querySelector('[data-sidebar-relation-actions]');
    container.replaceChildren();
    const types = getRelativeActionTypes(this.getSelectedPerson()).filter(
      (type) => type !== 'parent',
    );
    for (const type of types) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.dataset.sidebarRelation = type;
      button.textContent = RELATION_CONFIG[type].action;
      container.append(button);
    }
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
      if (this.viewModel) this.renderKinship();
    }
  }

  render(viewModel) {
    this.title.textContent = viewModel.fullName;
    this.renderRelationActions();
    this.renderKinship();

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

  renderKinship() {
    const relationshipLabel = this.host.querySelector('[data-sidebar-kinship-label]');
    relationshipLabel.textContent = this.relationship?.label || 'Родство не найдено';
    relationshipLabel.title = relationshipLabel.textContent;
    const setCenterButton = this.host.querySelector('[data-sidebar-set-center]');
    setCenterButton.disabled = this.isCenter;
    setCenterButton.textContent = this.isCenter ? 'Центр дерева' : 'Сделать центром дерева';
  }
}
