import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('mobile sidebar form controls and special input text use at least 16px', async () => {
  const css = await source('src/styles.css');
  const mobileCss = css.slice(css.lastIndexOf('@media (max-width: 760px)'));

  assert.match(
    mobileCss,
    /\.person-sidebar :where\(input, textarea, select, \[contenteditable\][\s\S]*?font-size: 16px;/,
  );
  assert.match(mobileCss, /::placeholder,[\s\S]*?font-size: 16px;/);
  assert.match(mobileCss, /input\[type='date'\]::-webkit-date-and-time-value/);
  assert.doesNotMatch(mobileCss, /transform:\s*scale\(/);
});

test('application chrome uses vertical pan while the tree canvas owns zoom gestures', async () => {
  const [css, ui] = await Promise.all([source('src/styles.css'), source('src/ui.js')]);

  assert.match(css, /\.app-ui-chrome,[\s\S]*?\.person-sidebar\s*{\s*touch-action: pan-y;/);
  assert.match(css, /\.chart-surface\s*{[\s\S]*?touch-action: none;/);
  assert.match(ui, /class="topbar app-ui-chrome" data-ui-chrome/);
  assert.match(ui, /class="toolbar app-ui-chrome" data-ui-chrome/);
  assert.match(ui, /data-tree-canvas/);
});

test('viewport remains accessible and sidebar reacts to the visual viewport', async () => {
  const [html, sidebar] = await Promise.all([
    source('index.html'),
    source('src/person-sidebar.js'),
  ]);

  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.doesNotMatch(html, /(user-scalable=no|maximum-scale=1|minimum-scale=1)/);
  assert.match(sidebar, /visualViewport/);
  assert.match(sidebar, /scrollControlIntoView/);
  assert.match(sidebar, /person-sidebar-document-locked/);
});

test('sidebar exposes specific relative actions and generic parent as additional', async () => {
  const sidebar = await source('src/person-sidebar.js');

  assert.match(sidebar, /father: \{ action: 'Отец'/);
  assert.match(sidebar, /mother: \{ action: 'Мать'/);
  assert.match(sidebar, /son: \{ action: 'Сын'/);
  assert.match(sidebar, /daughter: \{ action: 'Дочь'/);
  assert.match(sidebar, /brother: \{ action: 'Брат'/);
  assert.match(sidebar, /sister: \{ action: 'Сестра'/);
  assert.match(
    sidebar,
    /<details class="person-sidebar-more-actions">[\s\S]*data-sidebar-relation="parent">Другой родитель/,
  );
});

test('suggested links wrap safely and relative actions remain a compact two-column grid', async () => {
  const css = await source('src/styles.css');

  assert.match(css, /\.person-sidebar-relation-actions\s*\{[\s\S]*?grid-template-columns: 1fr 1fr/);
  assert.match(css, /\.person-sidebar-suggestion\s*\{[\s\S]*?minmax\(0, 1fr\)/);
  assert.match(css, /\.person-sidebar-suggestion\s*\{[\s\S]*?overflow-wrap: anywhere/);
});

test('female surname labels and autofill controls remain mobile-safe', async () => {
  const [sidebar, css] = await Promise.all([
    source('src/person-sidebar.js'),
    source('src/styles.css'),
  ]);

  assert.match(sidebar, /Девичья фамилия[\s\S]*?data-last-name-label>Фамилия/);
  assert.doesNotMatch(sidebar, /если менялась/);
  assert.match(sidebar, /placeholder="Добавьте заметку о человеке"/);
  assert.match(sidebar, /class="hidden" data-autofill-badge>Предложено автоматически/);
  assert.match(sidebar, /data-sidebar-cancel>\$\{cancelLabel\}/);
  assert.match(sidebar, />Создать<\/button>/);
  assert.match(css, /\.person-sidebar-form-grid > \*\s*\{\s*min-width: 0/);
  assert.match(css, /\.person-sidebar-autofill-meta\s*\{[\s\S]*?flex-wrap: wrap/);
  assert.match(css, /\.person-sidebar-form-grid label,[\s\S]*?overflow-wrap: anywhere/);
});

test('relative creation warns about duplicates and offers both safe choices', async () => {
  const [sidebar, css] = await Promise.all([
    source('src/person-sidebar.js'),
    source('src/styles.css'),
  ]);

  assert.match(sidebar, /data-sidebar-duplicates aria-live="polite"/);
  assert.match(sidebar, /data-sidebar-use-existing/);
  assert.match(sidebar, /Всё равно создать нового/);
  assert.match(css, /\.person-sidebar-duplicate p\s*\{[\s\S]*?overflow-wrap: anywhere/);
});

test('edit and relative forms each expose one labelled gender group', async () => {
  const sidebar = await source('src/person-sidebar.js');
  const editForm = sidebar.match(/<form id="person-sidebar-edit-form"[\s\S]*?<\/form>/)?.[0];
  const relativeForm = sidebar.match(
    /<form id="person-sidebar-relative-form"[\s\S]*?<\/form>/,
  )?.[0];

  for (const form of [editForm, relativeForm]) {
    assert.ok(form);
    assert.equal((form.match(/<fieldset class="person-sidebar-gender">/g) || []).length, 1);
    assert.equal((form.match(/<legend>Пол<\/legend>/g) || []).length, 1);
  }
});

test('relationship rows use the existing sidebar selection path', async () => {
  const [sidebar, main, css] = await Promise.all([
    source('src/person-sidebar.js'),
    source('src/main.js'),
    source('src/styles.css'),
  ]);

  assert.match(sidebar, /createElement\(person\.isResolved \? 'button' : 'div'\)/);
  assert.match(
    sidebar,
    /if \(person\.isResolved\) \{[\s\S]*?row\.dataset\.sidebarOpenPerson = person\.id/,
  );
  assert.match(sidebar, /openRelatedPerson\(button\.dataset\.sidebarOpenPerson\)/);
  assert.match(main, /onSelect: \(personId\) => openSidebar\(personId\)/);
  const relationRowStyles = css.match(/\.person-sidebar-relation-person\s*\{([^}]*)\}/)?.[1];
  assert.ok(relationRowStyles);
  assert.match(relationRowStyles, /min-width: 0/);
  assert.match(relationRowStyles, /white-space: normal/);
  assert.match(relationRowStyles, /text-align: left/);
  assert.match(relationRowStyles, /overflow-wrap: anywhere/);
});
