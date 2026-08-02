import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setSaveState, setupToolbarMenu } from '../src/ui.js';

class FakeClassList {
  constructor(...names) {
    this.names = new Set(names);
  }

  add(name) {
    this.names.add(name);
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, force) {
    const enabled = force ?? !this.names.has(name);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }
}

class FakeElement extends EventTarget {
  constructor({ button = false, classes = [] } = {}) {
    super();
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList(...classes);
    this.dataset = {};
    this.disabled = false;
    this.focused = false;
    this.isButton = button;
    this.textContent = '';
    this.title = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  closest(selector) {
    return selector === 'button' && this.isButton ? this : null;
  }

  focus() {
    this.focused = true;
  }

  querySelectorAll(selector) {
    return selector === 'button' ? this.children.filter((child) => child.isButton) : [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }
}

function createSaveButton() {
  const button = new FakeElement({ button: true });
  const icon = new FakeElement();
  const label = new FakeElement();
  button.querySelector = (selector) => (selector === '.save-button-icon' ? icon : label);
  return { button, icon, label };
}

function applySaveState(state) {
  const originalDocument = globalThis.document;
  const elements = createSaveButton();
  globalThis.document = { querySelector: () => elements.button };
  try {
    setSaveState(state);
  } finally {
    globalThis.document = originalDocument;
  }
  return elements;
}

function createMenuFixture() {
  const doc = new EventTarget();
  const button = new FakeElement({ button: true });
  const menu = new FakeElement();
  const firstItem = new FakeElement({ button: true });
  const secondItem = new FakeElement({ button: true });
  menu.append(firstItem, secondItem);
  doc.querySelector = (selector) => (selector === '#toolbar-menu-button' ? button : menu);
  return { doc, button, menu, firstItem, controller: setupToolbarMenu(doc) };
}

function escapeEvent() {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  return event;
}

test('admin sees an enabled direct-save button when the tree is dirty', () => {
  const { button, icon, label } = applySaveState({ dirty: true, role: 'admin' });

  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.action, 'save');
  assert.equal(button.getAttribute('aria-label'), 'Сохранить изменения');
  assert.equal(button.getAttribute('aria-hidden'), 'false');
  assert.equal(icon.textContent, '✓');
  assert.equal(label.textContent, 'Сохранить');
});

test('member sees the enabled proposal action when the tree is dirty', () => {
  const { button, label } = applySaveState({ dirty: true, role: 'member' });

  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.action, 'propose');
  assert.equal(button.getAttribute('aria-label'), 'Отправить предложение');
  assert.equal(button.title, 'Отправить предложение');
  assert.equal(label.textContent, 'Предложить');
});

test('viewer does not see the save button', () => {
  const { button } = applySaveState({ dirty: true, role: 'viewer' });

  assert.equal(button.classList.contains('hidden'), true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-hidden'), 'true');
});

test('save button is disabled when there are no changes', () => {
  const { button } = applySaveState({ dirty: false, role: 'admin' });

  assert.equal(button.disabled, true);
});

test('save button exposes clear success and error states', () => {
  const success = applySaveState({ dirty: false, role: 'admin', outcome: 'success' });
  const error = applySaveState({ dirty: true, role: 'admin', outcome: 'error' });

  assert.equal(success.button.dataset.state, 'success');
  assert.equal(success.button.title, 'Изменения сохранены');
  assert.equal(error.button.dataset.state, 'error');
  assert.equal(error.icon.textContent, '!');
  assert.match(error.button.title, /Не удалось сохранить/);
});

test('toolbar menu opens and closes on repeated button presses', () => {
  const { button, menu, firstItem, controller } = createMenuFixture();

  button.dispatchEvent(new Event('click'));
  assert.equal(controller.open, true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.classList.contains('is-open'), true);
  assert.equal(firstItem.focused, true);

  button.dispatchEvent(new Event('click'));
  assert.equal(controller.open, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  controller.destroy();
});

test('click outside closes the toolbar menu', () => {
  const { doc, button, controller } = createMenuFixture();

  button.dispatchEvent(new Event('click'));
  doc.dispatchEvent(new Event('click'));
  assert.equal(controller.open, false);
  controller.destroy();
});

test('Escape closes the toolbar menu and returns focus to its button', () => {
  const { doc, button, controller } = createMenuFixture();

  button.dispatchEvent(new Event('click'));
  const event = escapeEvent();
  doc.dispatchEvent(event);
  assert.equal(controller.open, false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(button.focused, true);
  controller.destroy();
});

test('mobile toolbar has no horizontal overflow and keeps search readable', async () => {
  const [css, ui] = await Promise.all([
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui.js', import.meta.url), 'utf8'),
  ]);
  const mobileToolbarCss = css.slice(
    css.indexOf('@media (max-width: 760px)'),
    css.indexOf('/* Собственная панель человека.'),
  );

  assert.doesNotMatch(css, /overflow-x:\s*auto/);
  assert.match(
    mobileToolbarCss,
    /grid-template-columns:\s*minmax\(min\(8rem, 40vw\), 1fr\) auto auto/,
  );
  assert.match(mobileToolbarCss, /\.search-host input\s*{[\s\S]*?font-size:\s*16px/);
  assert.match(mobileToolbarCss, /env\(safe-area-inset-right\)/);
  assert.match(ui, /aria-label="Сохранить изменения"/);
  assert.match(ui, /aria-expanded="false" aria-controls="toolbar-menu"/);
});
