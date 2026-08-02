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
