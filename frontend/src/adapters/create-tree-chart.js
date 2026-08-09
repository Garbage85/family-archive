import { FamilyTreeChart } from './family-chart-adapter.js';
import { PrototypeFamilyTreeChart } from './prototype-layout-adapter.js';
import { LAYOUT_MODE_PROTOTYPE, resolveLayoutMode } from '../layout/layout-mode.js';

/**
 * Create the active tree renderer. Production default is Family Chart.
 * Prototype household layout is opt-in via ?layout=prototype.
 */
export function createTreeChart(containerSelector, { layoutMode } = {}) {
  const mode = layoutMode ?? resolveLayoutMode();
  if (mode === LAYOUT_MODE_PROTOTYPE) {
    return new PrototypeFamilyTreeChart(containerSelector);
  }
  return new FamilyTreeChart(containerSelector);
}
