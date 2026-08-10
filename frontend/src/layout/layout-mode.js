/**
 * Tree layout mode selected by the URL.
 * The household prototype is the default; Family Chart remains available as
 * an explicit legacy fallback.
 */

export const LAYOUT_MODE_FAMILY_CHART = 'family-chart';
export const LAYOUT_MODE_PROTOTYPE = 'prototype';
export const LAYOUT_MODE_LEGACY = 'legacy';

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
  const requested = params.get('layout');
  if (requested === LAYOUT_MODE_LEGACY || requested === LAYOUT_MODE_FAMILY_CHART) {
    return LAYOUT_MODE_FAMILY_CHART;
  }
  return LAYOUT_MODE_PROTOTYPE;
}

export function isPrototypeLayoutMode(search) {
  return resolveLayoutMode(search) === LAYOUT_MODE_PROTOTYPE;
}
