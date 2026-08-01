const RELATION_LABELS = {
  parent: 'родителя',
  spouse: 'супруга',
  child: 'ребёнка',
  sibling: 'брата или сестру',
};

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
    this.renderShell();
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
              <label>Имя<input name="first_name" autocomplete="given-name" required /></label>
              <label>Отчество<input name="middle_name" /></label>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label></fieldset>
              <label>Дата рождения<input name="birth_date" type="date" /></label>
              <label>Дата смерти<input name="death_date" type="date" /></label>
              <label class="full">Место рождения<input name="birth_place" /></label>
              <label class="full">Профессия или занятие<input name="occupation" /></label>
              <label class="full">Заметки<textarea name="notes" rows="4"></textarea></label>
            </div>
            <section class="person-sidebar-edit-actions">
              <h3>Добавить родственника</h3>
              <div class="person-sidebar-relation-actions">
                <button type="button" class="ghost" data-sidebar-relation="parent">Родителя</button>
                <button type="button" class="ghost" data-sidebar-relation="spouse">Супруга</button>
                <button type="button" class="ghost" data-sidebar-relation="child">Ребёнка</button>
                <button type="button" class="ghost" data-sidebar-relation="sibling">Брата/сестру</button>
              </div>
              <button type="button" class="ghost wide" data-sidebar-photo>Изменить фотографию</button>
              <button type="button" class="danger wide" data-sidebar-delete>Удалить человека</button>
            </section>
          </form>

          <form id="person-sidebar-relative-form" class="hidden" data-sidebar-panel="relative">
            <h2 tabindex="-1" data-sidebar-relative-title>Добавить родственника</h2>
            <input name="relative_type" type="hidden" />
            <div class="person-sidebar-form-grid">
              <label>Фамилия<input name="last_name" /></label>
              <label>Имя<input name="first_name" required /></label>
              <label>Отчество<input name="middle_name" /></label>
              <fieldset class="person-sidebar-gender"><legend>Пол</legend><label><input type="radio" name="gender" value="M" checked /> Мужчина</label><label><input type="radio" name="gender" value="F" /> Женщина</label></fieldset>
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
    this.closeButton.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    this.host.addEventListener('click', (event) => {
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
    this.editForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.runAction('onUpdate', Object.fromEntries(new FormData(this.editForm)));
    });
    this.relativeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(this.relativeForm));
      const relation = values.relative_type;
      delete values.relative_type;
      this.runAction('onAddRelative', relation, values);
    });
    this.photoForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const file = new FormData(this.photoForm).get('photo');
      if (!file?.size) return;
      if (file.size > 10 * 1024 * 1024) {
        window.alert('Файл больше 10 МБ.');
        return;
      }
      this.runAction('onUploadPhoto', file);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen()) this.close();
    });
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
    this.closeButton.focus();
  }

  close() {
    if (!this.isOpen()) return;

    this.host.classList.remove('open');
    this.sidebar.setAttribute('aria-hidden', 'true');
    this.mode = 'view';
    if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
    this.previousFocus = null;
  }

  isOpen() {
    return this.host.classList.contains('open');
  }

  showRelativeMode(relation) {
    if (!RELATION_LABELS[relation]) return;
    this.relativeForm.reset();
    this.relativeForm.elements.relative_type.value = relation;
    this.relativeForm.querySelector('[data-sidebar-relative-title]').textContent =
      `Добавить ${RELATION_LABELS[relation]}`;
    this.showMode('relative');
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
    const gender = this.editForm.querySelector(
      `[name="gender"][value="${this.viewModel.values.gender === 'F' ? 'F' : 'M'}"]`,
    );
    if (gender) gender.checked = true;
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
          item.append(initials, name);
          list.append(item);
        }
        section.append(list);
      }

      this.relationGroups.append(section);
    }
  }
}
