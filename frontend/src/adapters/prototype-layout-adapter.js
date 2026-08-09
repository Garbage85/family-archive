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
 * - Viewport: readable initial/center focus; explicit fit() fits all; pinch+pan.
 */

import { createFamilyChartCardHtml } from '../family-chart-card.js';
import { layoutFamilyTree } from '../layout/family-layout.js';
import { pointsToSvgPath, routeLayoutLinks } from '../layout/link-routing.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_SCALE,
  MIN_SCALE,
  MOBILE_MIN_READABLE_SCALE,
  computeCenterFocusView,
  computeFitAllView,
  panBy,
  pointerDistance,
  pointerMidpoint,
  readableInitialScale,
  wheelZoomFactor,
  zoomAtPoint,
} from '../layout/prototype-viewport.js';
import { formatPersonName } from '../person-card-formatters.js';
import { cloneTree, normaliseTree } from '../tree-utils.js';

const CARD_X_SPACING = 236;
const CARD_Y_SPACING = 224;
const PAN_CLICK_THRESHOLD_PX = 8;

function escapeAttr(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pointsToPath(points, jumps) {
  return pointsToSvgPath(points, jumps);
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
    this._pointers = new Map();
    this._panSession = null;
    this._pinchSession = null;
    this._suppressClick = false;
    this._onWheel = null;
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;
    this._onTouchStart = null;
    this._onTouchMove = null;
    this._onTouchEnd = null;
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
    // Readable center focus — not fit-all (fit-all is explicit via fit()).
    this._render({ view: 'initial' });
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

  getViewport() {
    return {
      scale: this.scale,
      translateX: this.translateX,
      translateY: this.translateY,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      mobileMinReadableScale: MOBILE_MIN_READABLE_SCALE,
    };
  }

  updateData(rawData, { fit = false, focusId = null, rootPersonId, kinships } = {}) {
    this.data = normaliseTree(rawData);
    if (kinships instanceof Map) this.kinships = kinships;
    this.rootPersonId = this.resolvePersonId(rootPersonId ?? this.rootPersonId);
    if (focusId) this.selectedPersonId = String(focusId);
    // `fit` from app means "keep useful view", not microscopic fit-all.
    this._render({ view: fit ? 'center' : 'preserve' });
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
    // Center change must NOT call fit-all (microscopic). Focus center at readable scale.
    this._render({ view: fit ? 'center' : 'preserve' });
    return true;
  }

  setKinships(kinships, { fit = false } = {}) {
    this.kinships = kinships instanceof Map ? kinships : new Map();
    this._render({ view: fit ? 'center' : 'preserve' });
  }

  openPersonSearch() {
    const input = this._searchHost?.querySelector('input');
    input?.focus();
    input?.click();
  }

  /** Toolbar "Показать всё" — may shrink below readable floor. */
  fit() {
    this._applyView(computeFitAllView(this._hostMetrics()));
  }

  /** Readable center-focused view used after mount / as non-fit-all reset. */
  resetView() {
    this._applyView(this._computeReadableCenterView());
  }

  toggleOrientation() {
    this.orientation = this.orientation === 'vertical' ? 'horizontal' : 'vertical';
    this._render({ view: 'initial' });
    return this.orientation;
  }

  /** Test/helper: wheel zoom at a host-local point. */
  zoomAt(hostX, hostY, factor) {
    this._applyView(
      zoomAtPoint(
        { scale: this.scale, translateX: this.translateX, translateY: this.translateY },
        { hostX, hostY, factor },
      ),
    );
  }

  /** Test/helper: pan by delta in screen pixels. */
  panViewport(dx, dy) {
    this._applyView(
      panBy(
        { scale: this.scale, translateX: this.translateX, translateY: this.translateY },
        { dx, dy },
      ),
    );
  }

  /** Test/helper: pinch zoom around a host-local midpoint. */
  pinchZoom(hostX, hostY, factor) {
    this.zoomAt(hostX, hostY, factor);
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
    this._pointers.clear();
    this._panSession = null;
    this._pinchSession = null;
  }

  _hostMetrics() {
    const hostWidth = this._host?.clientWidth || 800;
    const hostHeight = this._host?.clientHeight || 600;
    return {
      hostWidth,
      hostHeight,
      nodes: this.layout?.nodes || [],
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    };
  }

  _focusNode() {
    return (
      this.layout?.nodes?.find((node) => String(node.id) === String(this.rootPersonId)) ||
      this.layout?.nodes?.[0] || { x: 0, y: 0 }
    );
  }

  _computeReadableCenterView() {
    const metrics = this._hostMetrics();
    const focus = this._focusNode();
    const scale = readableInitialScale(metrics.hostWidth, { cardWidth: CARD_WIDTH });
    return computeCenterFocusView({
      hostWidth: metrics.hostWidth,
      hostHeight: metrics.hostHeight,
      focusX: focus.x,
      focusY: focus.y,
      scale,
    });
  }

  _computeCenterPreserveScaleView() {
    const metrics = this._hostMetrics();
    const focus = this._focusNode();
    // Keep current scale but never below readable floor on compact screens.
    const minReadable = readableInitialScale(metrics.hostWidth, { cardWidth: CARD_WIDTH });
    const scale = Math.max(this.scale || minReadable, minReadable);
    return computeCenterFocusView({
      hostWidth: metrics.hostWidth,
      hostHeight: metrics.hostHeight,
      focusX: focus.x,
      focusY: focus.y,
      scale,
    });
  }

  _applyView(view) {
    if (!view) return;
    this.scale = view.scale;
    this.translateX = view.translateX;
    this.translateY = view.translateY;
    this._applyTransform();
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

  _render({ view = 'preserve' } = {}) {
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
        return `<path class="${className}" d="${escapeAttr(pointsToPath(link.points, link.jumps))}" fill="none" />`;
      })
      .join('');

    cardsLayer.innerHTML = (this.layout.nodes || [])
      .map((node) => {
        const person = byId.get(String(node.id));
        if (!person) return '';
        const relationship = this.kinships.get(String(node.id));
        const isCenter = String(node.id) === String(this.rootPersonId);
        const isSelected = String(node.id) === String(this.selectedPersonId);
        const gender = String(person.data?.gender || '').toUpperCase();
        const genderClass =
          gender === 'M' ? 'card-male' : gender === 'F' ? 'card-female' : 'card-genderless';
        const left = node.x - CARD_WIDTH / 2;
        const top = node.y - CARD_HEIGHT / 2;
        return `<div class="card_cont prototype-card-cont${isCenter ? ' kinship-center-card' : ''}${isSelected ? ' prototype-card-selected' : ''}"
          data-person-id="${escapeAttr(node.id)}"
          style="left:${left}px;top:${top}px;width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px">
          <div class="card ${genderClass}${isCenter ? ' card-main' : ''}" role="button" tabindex="0" data-person-id="${escapeAttr(node.id)}">
            ${createFamilyChartCardHtml(person, relationship).replace(
              'class="card-inner family-archive-card"',
              `class="card-inner family-archive-card${isCenter ? ' kinship-center-card-inner' : ''}"`,
            )}
          </div>
        </div>`;
      })
      .join('');

    this._bindKinshipLabels();
    if (view === 'initial') this._applyView(this._computeReadableCenterView());
    else if (view === 'center') this._applyView(this._computeCenterPreserveScaleView());
    else this._applyTransform();
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
      if (this._suppressClick) {
        this._suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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

  _hostPointFromClient(clientX, clientY) {
    const rect = this._host.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  _bindViewportGestures() {
    if (!this._host || !this._viewport) return;

    this._onWheel = (event) => {
      // Only hijack wheel over the canvas host.
      event.preventDefault();
      const point = this._hostPointFromClient(event.clientX, event.clientY);
      this._applyView(
        zoomAtPoint(
          { scale: this.scale, translateX: this.translateX, translateY: this.translateY },
          { hostX: point.x, hostY: point.y, factor: wheelZoomFactor(event.deltaY) },
        ),
      );
    };

    this._onPointerDown = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this._host.setPointerCapture?.(event.pointerId);
      if (this._pointers.size === 2) {
        this._beginPinch();
        this._panSession = null;
      } else if (this._pointers.size === 1) {
        this._pinchSession = null;
        this._panSession = {
          x: event.clientX,
          y: event.clientY,
          originX: this.translateX,
          originY: this.translateY,
          moved: false,
          onCard: Boolean(event.target.closest?.('[data-person-id]')),
        };
      }
    };

    this._onPointerMove = (event) => {
      if (!this._pointers.has(event.pointerId)) return;
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (this._pointers.size >= 2 && this._pinchSession) {
        event.preventDefault();
        this._updatePinch();
        return;
      }

      if (this._panSession && this._pointers.size === 1) {
        const dx = event.clientX - this._panSession.x;
        const dy = event.clientY - this._panSession.y;
        if (!this._panSession.moved && Math.hypot(dx, dy) >= PAN_CLICK_THRESHOLD_PX) {
          this._panSession.moved = true;
          this._suppressClick = true;
        }
        if (this._panSession.moved) {
          event.preventDefault();
          this.translateX = this._panSession.originX + dx;
          this.translateY = this._panSession.originY + dy;
          this._applyTransform();
        }
      }
    };

    this._onPointerUp = (event) => {
      this._pointers.delete(event.pointerId);
      if (this._pointers.size < 2) this._pinchSession = null;
      if (this._pointers.size === 1) {
        const remaining = [...this._pointers.entries()][0];
        if (remaining) {
          const [id, point] = remaining;
          this._panSession = {
            id,
            x: point.x,
            y: point.y,
            originX: this.translateX,
            originY: this.translateY,
            moved: false,
            onCard: false,
          };
        }
      } else if (this._pointers.size === 0) {
        this._panSession = null;
      }
    };

    // iOS Safari: touch events remain the most reliable path for two-finger pinch.
    this._onTouchStart = (event) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
        this._syncPointersFromTouches(event.touches);
        this._beginPinch();
        this._panSession = null;
      }
    };
    this._onTouchMove = (event) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
        this._syncPointersFromTouches(event.touches);
        if (!this._pinchSession) this._beginPinch();
        this._updatePinch();
        return;
      }
      if (event.touches.length === 1 && this._panSession?.moved) {
        event.preventDefault();
      }
    };
    this._onTouchEnd = (event) => {
      this._syncPointersFromTouches(event.touches);
      if (event.touches.length < 2) this._pinchSession = null;
      if (event.touches.length === 0) this._panSession = null;
    };

    this._host.addEventListener('wheel', this._onWheel, { passive: false });
    this._host.addEventListener('pointerdown', this._onPointerDown);
    this._host.addEventListener('pointermove', this._onPointerMove, { passive: false });
    this._host.addEventListener('pointerup', this._onPointerUp);
    this._host.addEventListener('pointercancel', this._onPointerUp);
    this._host.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this._host.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this._host.addEventListener('touchend', this._onTouchEnd, { passive: false });
    this._host.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  _syncPointersFromTouches(touches) {
    this._pointers.clear();
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      this._pointers.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
  }

  _beginPinch() {
    const points = [...this._pointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    this._pinchSession = {
      distance: Math.max(1, pointerDistance(a, b)),
      scale: this.scale,
      translateX: this.translateX,
      translateY: this.translateY,
    };
    this._suppressClick = true;
  }

  _updatePinch() {
    if (!this._pinchSession) return;
    const points = [...this._pointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const distance = Math.max(1, pointerDistance(a, b));
    const factor = distance / this._pinchSession.distance;
    const mid = pointerMidpoint(a, b);
    const hostMid = this._hostPointFromClient(mid.x, mid.y);
    this._applyView(
      zoomAtPoint(
        {
          scale: this._pinchSession.scale,
          translateX: this._pinchSession.translateX,
          translateY: this._pinchSession.translateY,
        },
        { hostX: hostMid.x, hostY: hostMid.y, factor },
      ),
    );
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
    if (this._onTouchStart) this._host.removeEventListener('touchstart', this._onTouchStart);
    if (this._onTouchMove) this._host.removeEventListener('touchmove', this._onTouchMove);
    if (this._onTouchEnd) {
      this._host.removeEventListener('touchend', this._onTouchEnd);
      this._host.removeEventListener('touchcancel', this._onTouchEnd);
    }
    this._onWheel = null;
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onPointerUp = null;
    this._onTouchStart = null;
    this._onTouchMove = null;
    this._onTouchEnd = null;
  }

  _applyTransform() {
    if (!this._viewport) return;
    // Single transform for cards + SVG links together.
    this._viewport.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }
}
