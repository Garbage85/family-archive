import { FamilyTreeChart } from './family-chart-adapter.js';
import { PrototypeFamilyTreeChart } from './prototype-layout-adapter.js';
import { LAYOUT_MODE_PROTOTYPE, resolveLayoutMode } from '../layout/layout-mode.js';

/**
 * Create the active tree renderer. The household prototype is the default;
 * Family Chart remains available through the explicit legacy mode.
 */
export function createTreeChart(containerSelector, { layoutMode } = {}) {
  const mode = layoutMode ?? resolveLayoutMode();
  if (mode === LAYOUT_MODE_PROTOTYPE) {
    return new PrototypeFamilyTreeChart(containerSelector);
  }
  return new FamilyTreeChart(containerSelector);
}
