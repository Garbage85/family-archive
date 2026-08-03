import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFamilyChartCardHtml } from '../src/family-chart-card.js';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

function woman(overrides = {}) {
  return {
    id: 'elena',
    data: {
      gender: 'F',
      last_name: 'Сапожникова',
      maiden_name: 'Печёркина',
      first_name: 'Елена',
      middle_name: 'Юрьевна',
      birth_date: '1985-12-08',
      avatar: '/photo.webp',
      ...overrides,
    },
  };
}

const relationship = { label: 'свекровь', shortLabel: 'свекровь' };

test('kinship, avatar, surname, given name and date render in strict vertical order', () => {
  const html = createFamilyChartCardHtml(woman(), relationship);
  const positions = [
    html.indexOf('kinship-card-label'),
    html.indexOf('family-archive-card-avatar'),
    html.indexOf('family-archive-card-surname'),
    html.indexOf('family-archive-card-given-name'),
    html.indexOf('family-archive-card-birth-date'),
  ];
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
  );
});

test('name and date are siblings of the avatar instead of avatar overlays', () => {
  const html = createFamilyChartCardHtml(woman(), relationship);
  assert.match(
    html,
    /kinship-card-label[\s\S]*?<img class="family-archive-card-avatar"[^>]*\/>[\s\S]*?family-archive-card-surname/,
  );
  assert.doesNotMatch(
    html,
    /<img[^>]*>[\s\S]*?(kinship-card-label|family-archive-card-(?:surname|given-name|birth-date))[\s\S]*?<\/img>/,
  );
});

test('current and maiden surnames share one surname group while given names use another', () => {
  const html = createFamilyChartCardHtml(woman(), relationship);
  assert.match(html, /class="family-archive-card-surname"[^>]*>Сапожникова \(Печёркина\)<\/div>/);
  assert.match(html, /class="family-archive-card-given-name">Елена Юрьевна<\/div>/);
  assert.equal((html.match(/family-archive-card-surname/g) || []).length, 1);
});

test('a missing surname does not produce an empty surname block', () => {
  const html = createFamilyChartCardHtml(
    woman({ last_name: '', maiden_name: '', first_name: 'Елена' }),
    relationship,
  );
  assert.doesNotMatch(html, /family-archive-card-surname/);
  assert.match(html, /family-archive-card-given-name/);
});

test('full name and kinship remain available through title and aria-label', () => {
  const html = createFamilyChartCardHtml(woman(), relationship);
  assert.match(html, /title="Сапожникова \(Печёркина\) Елена Юрьевна\. Родство: Свекровь"/);
  assert.match(html, /aria-label="Сапожникова \(Печёркина\) Елена Юрьевна\. Родство: Свекровь"/);
  assert.match(
    html,
    /family-archive-card-surname" title="Сапожникова \(Печёркина\)" aria-label="Сапожникова \(Печёркина\)"/,
  );
});

test('long surnames are clamped inside a fixed-width card without horizontal overflow', async () => {
  const css = await source('src/styles.css');
  assert.match(css, /\.family-archive-card\s*\{[\s\S]*?max-width: 148px;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.family-archive-card-surname\s*\{[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(
    css,
    /\.family-archive-card-surname,[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden;/,
  );
});

test('the adapter preserves the center highlight on the custom card', async () => {
  const adapter = await source('src/adapters/family-chart-adapter.js');
  assert.match(adapter, /inner\?\.classList\.toggle\('kinship-center-card-inner', isCenter\)/);
});
