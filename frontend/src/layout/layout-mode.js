/**
 * Experimental tree layout preview flag.
 * Only an explicit query parameter enables the household prototype renderer.
 * Default remains Family Chart (production).
 */

export const LAYOUT_MODE_FAMILY_CHART = 'family-chart';
export const LAYOUT_MODE_PROTOTYPE = 'prototype';

/**
 * @param {string} [search]
 * @returns {'family-chart'|'prototype'}
 */
export function resolveLayoutMode(
  search = typeof window !== 'undefined' ? window.location.search : '',
) {
  const raw = String(search || '');
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  return params.get('layout') === LAYOUT_MODE_PROTOTYPE
    ? LAYOUT_MODE_PROTOTYPE
    : LAYOUT_MODE_FAMILY_CHART;
}

export function isPrototypeLayoutMode(search) {
  return resolveLayoutMode(search) === LAYOUT_MODE_PROTOTYPE;
}
