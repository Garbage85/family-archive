/**
 * Experimental household-layout tree renderer (preview only).
 *
 * Enabled via createTreeChart(..., { layoutMode: 'prototype' }) which is
 * selected from ?layout=prototype. Family Chart remains the production default.
 *
 * Constraints:
 * - Display-only: never writes coordinates or derived layout into trees.data.
 * - Reuses Family Archive card HTML (createFamilyChartCardHtml).
 * - Orthogonal link routing is preview-quality; see link-routing.js.
 * - Editing continues through the existing sidebar / person-editor path.
 */

import { createFamilyChartCardHtml } from '../family-chart-card.js';
import { layoutFamilyTree } from '../layout/family-layout.js';
import { routeLayoutLinks } from '../layout/link-routing.js';
import { formatPersonName } from '../person-card-formatters.js';
import { cloneTree, normaliseTree } from '../tree-utils.js';

const CARD_WIDTH = 184;
const CARD_HEIGHT = 170;
const CARD_X_SPACING = 236;
const CARD_Y_SPACING = 224;
const FIT_PADDING = 48;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

function escapeAttr(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pointsToPath(points) {
  if (!points?.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0]},${point[1]}`)
    .join(' ');
}

export class PrototypeFamilyTreeChart {
  constructor(containerSelector) {
    this.containerSelector = containerSelector;
    this.data = [];
    this.selectedPersonId = null;
    this.rootPersonId = null;
    this.kinships = new Map();
    this.orientation = 'vertical';
    this.onSelect = () => {};
    this.onRootSelect = () => {};
    this.onKinshipClick = () => {};
    this.layout = null;
    this.engine = 'prototype';
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this._viewport = null;
    this._host = null;
    this._searchHost = null;
    this._pointer = null;
    this._onWheel = null;
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;
    this._onHostClick = null;
    this._onHostKeyDown = null;
    this._onDocumentClick = null;
  }

  mount(
    rawData,
    { onSelect, onRootSelect, onKinshipClick, rootPersonId = null, kinships = new Map() } = {},
  ) {
    this.destroy();
    this.data = normaliseTree(rawData);
    this.onSelect = onSelect || (() => {});
    this.onRootSelect = onRootSelect || (() => {});
    this.onKinshipClick = onKinshipClick || (() => {});
    this.kinships = kinships instanceof Map ? kinships : new Map();
    this.rootPersonId = this.resolvePersonId(rootPersonId);

    this._host = document.querySelector(this.containerSelector);
    this._searchHost = document.querySelector('#search-host');
    if (!this._host) return;

    this._host.innerHTML = '';
    this._host.classList.add('prototype-layout-surface');
    this._host.dataset.layoutEngine = 'prototype';
    if (this._searchHost) this._searchHost.innerHTML = '';

    this._host.innerHTML = `
      <div class="prototype-layout-root">
        <div class="prototype-layout-badge" aria-live="polite">Эксперимент: prototype layout</div>
        <div class="prototype-layout-viewport" data-prototype-viewport>
          <svg class="prototype-layout-links" data-prototype-links aria-hidden="true"></svg>
          <div class="prototype-layout-cards" data-prototype-cards></div>
        </div>
      </div>
    `;
    this._viewport = this._host.querySelector('[data-prototype-viewport]');
    this._bindViewportGestures();
    this._bindCardEvents();
    this._mountSearch();
    this._render({ fit: true });
  }

  resolvePersonId(personId) {
    const requested = String(personId ?? '');
    return this.data.some((person) => person.id === requested) ? requested : this.data[0]?.id || '';
  }

  select(id) {
    this.selectedPersonId = id;
    this.onSelect(id);
  }

  getData() {
    return cloneTree(this.data);
  }

  getLayout() {
    return this.layout;
  }

  updateData(rawData, { fit = false, focusId = null, rootPersonId, kinships } = {}) {
    this.data = normaliseTree(rawData);
    if (kinships instanceof Map) this.kinships = kinships;
    this.rootPersonId = this.resolvePersonId(rootPersonId ?? this.rootPersonId);
    if (focusId) this.selectedPersonId = String(focusId);
    this._render({ fit });
  }

  focus(id) {
    if (!id) return;
    this.selectedPersonId = String(id);
    this._syncSelectionClasses();
  }

  setRootPerson(personId, { fit = true, kinships } = {}) {
    const nextId = this.resolvePersonId(personId);
    if (!nextId) return false;
    if (kinships instanceof Map) this.kinships = kinships;
    this.rootPersonId = nextId;
    this._render({ fit });
    return true;
  }

  setKinships(kinships, { fit = false } = {}) {
    this.kinships = kinships instanceof Map ? kinships : new Map();
    this._render({ fit });
  }

  openPersonSearch() {
    const input = this._searchHost?.querySelector('input');
    input?.focus();
    input?.click();
  }

  fit() {
    this._fitToView();
    this._applyTransform();
  }

  toggleOrientation() {
    this.orientation = this.orientation === 'vertical' ? 'horizontal' : 'vertical';
    this._render({ fit: true });
    return this.orientation;
  }

  destroy() {
    this._unbindViewportGestures();
    if (this._host && this._onHostClick) {
      this._host.removeEventListener('click', this._onHostClick);
      this._host.removeEventListener('keydown', this._onHostKeyDown);
    }
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick, true);
      this._onDocumentClick = null;
    }
    if (this._host) {
      this._host.innerHTML = '';
      this._host.classList.remove('prototype-layout-surface');
      delete this._host.dataset.layoutEngine;
    }
    if (this._searchHost) this._searchHost.innerHTML = '';
    this._host = null;
    this._searchHost = null;
    this._viewport = null;
    this.layout = null;
    this.selectedPersonId = null;
    this._pointer = null;
  }

  _computeLayout() {
    // Always layout from a clone so source workingData / trees.data stay untouched.
    const people = cloneTree(this.data);
    const layout = layoutFamilyTree(people, {
      centerId: this.rootPersonId,
      orientation: this.orientation,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      nodeSeparation: CARD_X_SPACING,
      levelSeparation: CARD_Y_SPACING,
    });
    layout.links = routeLayoutLinks(layout, { orientation: this.orientation });
    return layout;
  }

  _render({ fit = false } = {}) {
    if (!this._host || !this._viewport) return;
    this.layout = this._computeLayout();
    const linksLayer = this._viewport.querySelector('[data-prototype-links]');
    const cardsLayer = this._viewport.querySelector('[data-prototype-cards]');
    if (!linksLayer || !cardsLayer) return;

    const byId = new Map(this.data.map((person) => [String(person.id), person]));
    linksLayer.innerHTML = (this.layout.links || [])
      .map((link) => {
        const className =
          link.type === 'spouse'
            ? 'prototype-link prototype-link-spouse'
            : 'prototype-link prototype-link-parent-child';
        return `<path class="${className}" d="${escapeAttr(pointsToPath(link.points))}" fill="none" />`;
      })
      .join('');

    cardsLayer.innerHTML = (this.layout.nodes || [])
      .map((node) => {
        const person = byId.get(String(node.id));
        if (!person) return '';
        const relationship = this.kinships.get(String(node.id));
        const isCenter = String(node.id) === String(this.rootPersonId);
        const isSelected = String(node.id) === String(this.selectedPersonId);
        const left = node.x - CARD_WIDTH / 2;
        const top = node.y - CARD_HEIGHT / 2;
        return `<div class="card_cont prototype-card-cont${isCenter ? ' kinship-center-card' : ''}${isSelected ? ' prototype-card-selected' : ''}"
          data-person-id="${escapeAttr(node.id)}"
          style="left:${left}px;top:${top}px;width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px">
          <div class="card" role="button" tabindex="0" data-person-id="${escapeAttr(node.id)}">
            ${createFamilyChartCardHtml(person, relationship).replace(
              'class="card-inner family-archive-card"',
              `class="card-inner family-archive-card${isCenter ? ' kinship-center-card-inner' : ''}"`,
            )}
          </div>
        </div>`;
      })
      .join('');

    this._bindKinshipLabels();
    if (fit) this._fitToView();
    this._applyTransform();
  }

  _syncSelectionClasses() {
    if (!this._viewport) return;
    for (const card of this._viewport.querySelectorAll('.prototype-card-cont')) {
      const id = card.getAttribute('data-person-id');
      card.classList.toggle('prototype-card-selected', id === String(this.selectedPersonId));
    }
  }

  _bindCardEvents() {
    if (!this._host) return;
    this._onHostClick = (event) => {
      const kinship = event.target.closest?.('[data-kinship-card-label]');
      if (kinship) {
        const personId = kinship.closest?.('[data-person-id]')?.getAttribute('data-person-id');
        if (personId) {
          event.stopPropagation();
          this.onKinshipClick(personId);
        }
        return;
      }
      const card = event.target.closest?.('[data-person-id]');
      if (!card || !this._host.contains(card)) return;
      const personId = card.getAttribute('data-person-id');
      if (personId) this.select(personId);
    };
    this._onHostKeyDown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest?.('[data-person-id]');
      if (!card || !this._host.contains(card)) return;
      event.preventDefault();
      const personId = card.getAttribute('data-person-id');
      if (personId) this.select(personId);
    };
    this._host.addEventListener('click', this._onHostClick);
    this._host.addEventListener('keydown', this._onHostKeyDown);
  }

  _bindKinshipLabels() {
    if (!this._viewport) return;
    for (const label of this._viewport.querySelectorAll('[data-kinship-card-label]')) {
      label.setAttribute('role', 'button');
      label.tabIndex = 0;
    }
  }

  _mountSearch() {
    if (!this._searchHost) return;
    this._searchHost.innerHTML = `
      <div class="prototype-search">
        <input type="search" placeholder="Найти человека" autocomplete="off" aria-label="Найти человека" />
        <ul class="prototype-search-results" hidden></ul>
      </div>
    `;
    const input = this._searchHost.querySelector('input');
    const results = this._searchHost.querySelector('.prototype-search-results');
    if (!input || !results) return;

    const close = () => {
      results.hidden = true;
      results.innerHTML = '';
    };

    const renderResults = (query) => {
      const needle = String(query || '')
        .trim()
        .toLocaleLowerCase('ru-RU');
      const matches = this.data
        .map((person) => ({ person, label: formatPersonName(person) }))
        .filter((item) => !needle || item.label.toLocaleLowerCase('ru-RU').includes(needle))
        .slice(0, 12);
      if (!matches.length) {
        close();
        return;
      }
      results.hidden = false;
      results.innerHTML = matches
        .map(
          (item) =>
            `<li><button type="button" data-prototype-search-id="${escapeAttr(item.person.id)}">${escapeAttr(item.label)}</button></li>`,
        )
        .join('');
    };

    input.addEventListener('input', () => renderResults(input.value));
    input.addEventListener('focus', () => renderResults(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    results.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-prototype-search-id]');
      if (!button) return;
      const id = button.getAttribute('data-prototype-search-id');
      close();
      input.value = '';
      if (id) this.onRootSelect(String(id));
    });
    this._onDocumentClick = (event) => {
      if (!this._searchHost?.contains(event.target)) close();
    };
    document.addEventListener('click', this._onDocumentClick, true);
  }

  _bindViewportGestures() {
    if (!this._host || !this._viewport) return;

    this._onWheel = (event) => {
      event.preventDefault();
      const rect = this._host.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
      const worldX = (cursorX - this.translateX) / this.scale;
      const worldY = (cursorY - this.translateY) / this.scale;
      this.scale = nextScale;
      this.translateX = cursorX - worldX * this.scale;
      this.translateY = cursorY - worldY * this.scale;
      this._applyTransform();
    };

    this._onPointerDown = (event) => {
      if (event.target.closest?.('[data-person-id]')) return;
      this._pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        originX: this.translateX,
        originY: this.translateY,
      };
      this._host.setPointerCapture?.(event.pointerId);
    };
    this._onPointerMove = (event) => {
      if (!this._pointer || this._pointer.id !== event.pointerId) return;
      this.translateX = this._pointer.originX + (event.clientX - this._pointer.x);
      this.translateY = this._pointer.originY + (event.clientY - this._pointer.y);
      this._applyTransform();
    };
    this._onPointerUp = (event) => {
      if (!this._pointer || this._pointer.id !== event.pointerId) return;
      this._pointer = null;
    };

    this._host.addEventListener('wheel', this._onWheel, { passive: false });
    this._host.addEventListener('pointerdown', this._onPointerDown);
    this._host.addEventListener('pointermove', this._onPointerMove);
    this._host.addEventListener('pointerup', this._onPointerUp);
    this._host.addEventListener('pointercancel', this._onPointerUp);
  }

  _unbindViewportGestures() {
    if (!this._host) return;
    if (this._onWheel) this._host.removeEventListener('wheel', this._onWheel);
    if (this._onPointerDown) this._host.removeEventListener('pointerdown', this._onPointerDown);
    if (this._onPointerMove) this._host.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) {
      this._host.removeEventListener('pointerup', this._onPointerUp);
      this._host.removeEventListener('pointercancel', this._onPointerUp);
    }
    this._onWheel = null;
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;
  }

  _fitToView() {
    if (!this._host || !this.layout?.nodes?.length) {
      this.scale = 1;
      this.translateX = 0;
      this.translateY = 0;
      return;
    }
    const width = this._host.clientWidth || 800;
    const height = this._host.clientHeight || 600;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of this.layout.nodes) {
      minX = Math.min(minX, node.x - CARD_WIDTH / 2);
      maxX = Math.max(maxX, node.x + CARD_WIDTH / 2);
      minY = Math.min(minY, node.y - CARD_HEIGHT / 2);
      maxY = Math.max(maxY, node.y + CARD_HEIGHT / 2);
    }
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min(
          (width - FIT_PADDING * 2) / contentWidth,
          (height - FIT_PADDING * 2) / contentHeight,
        ),
      ),
    );
    this.scale = scale;
    this.translateX = (width - contentWidth * scale) / 2 - minX * scale;
    this.translateY = (height - contentHeight * scale) / 2 - minY * scale;
  }

  _applyTransform() {
    if (!this._viewport) return;
    this._viewport.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }
}
