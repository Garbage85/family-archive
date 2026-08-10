/**
 * Viewport math for the prototype layout preview.
 * Pure helpers — no DOM, no layout algorithm, no trees.data writes.
 *
 * Initial view focuses the center at a readable scale (does NOT fit-all).
 * Explicit fit() may shrink below the readable floor down to MIN_SCALE.
 */

export const CARD_WIDTH = 184;
export const CARD_HEIGHT = 170;
export const FIT_PADDING = 40;

/** Absolute zoom-out floor (fit-all and gestures). */
export const MIN_SCALE = 0.35;
/** Absolute zoom-in ceiling. */
export const MAX_SCALE = 2.75;
/**
 * Mobile/compact initial scale floor — cards must stay readable after open.
 * Fit-all may go below this; center changes must not.
 */
export const MOBILE_MIN_READABLE_SCALE = 0.95;
/** Desktop initial scale target when focusing the center person. */
export const DESKTOP_INITIAL_SCALE = 1;
/** Host width at/below which compact (mobile) readable rules apply. */
export const COMPACT_VIEWPORT_WIDTH = 760;

export function clampScale(scale, { min = MIN_SCALE, max = MAX_SCALE } = {}) {
  return Math.min(max, Math.max(min, Number(scale) || min));
}

export function isCompactViewport(hostWidth) {
  return Number(hostWidth) > 0 && Number(hostWidth) <= COMPACT_VIEWPORT_WIDTH;
}

export function contentBounds(nodes, cardWidth = CARD_WIDTH, cardHeight = CARD_HEIGHT) {
  if (!nodes?.length) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 1, height: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const halfW = (node.width ?? cardWidth) / 2;
    const halfH = (node.height ?? cardHeight) / 2;
    minX = Math.min(minX, node.x - halfW);
    maxX = Math.max(maxX, node.x + halfW);
    minY = Math.min(minY, node.y - halfH);
    maxY = Math.max(maxY, node.y + halfH);
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function readableInitialScale(hostWidth, { cardWidth = CARD_WIDTH } = {}) {
  if (isCompactViewport(hostWidth)) {
    // Keep a card roughly ~38–45% of screen width, never below mobile readable floor.
    const target = (hostWidth * 0.42) / cardWidth;
    return clampScale(Math.max(MOBILE_MIN_READABLE_SCALE, target), {
      min: MOBILE_MIN_READABLE_SCALE,
      max: MAX_SCALE,
    });
  }
  return clampScale(DESKTOP_INITIAL_SCALE);
}

/**
 * Focus a world-space point (usually the center person) in the useful viewport area.
 * Does not shrink to fit the whole tree.
 */
export function computeCenterFocusView({
  hostWidth,
  hostHeight,
  focusX = 0,
  focusY = 0,
  scale,
  verticalBias = 0.42,
} = {}) {
  const nextScale = clampScale(scale);
  const translateX = hostWidth / 2 - focusX * nextScale;
  const translateY = hostHeight * verticalBias - focusY * nextScale;
  return { scale: nextScale, translateX, translateY };
}

/**
 * Fit the entire content bounds into the host (toolbar "Показать всё").
 * May go down to MIN_SCALE — intentionally smaller than readable initial scale.
 */
export function computeFitAllView({
  hostWidth,
  hostHeight,
  nodes,
  cardWidth = CARD_WIDTH,
  cardHeight = CARD_HEIGHT,
  padding = FIT_PADDING,
} = {}) {
  const bounds = contentBounds(nodes, cardWidth, cardHeight);
  const availW = Math.max(1, hostWidth - padding * 2);
  const availH = Math.max(1, hostHeight - padding * 2);
  const raw = Math.min(availW / bounds.width, availH / bounds.height);
  const scale = clampScale(raw);
  const translateX = (hostWidth - bounds.width * scale) / 2 - bounds.minX * scale;
  const translateY = (hostHeight - bounds.height * scale) / 2 - bounds.minY * scale;
  return { scale, translateX, translateY, bounds };
}

export function zoomAtPoint(
  { scale, translateX, translateY },
  { hostX, hostY, factor, min = MIN_SCALE, max = MAX_SCALE },
) {
  const nextScale = clampScale(scale * factor, { min, max });
  if (nextScale === scale) {
    return { scale, translateX, translateY };
  }
  const worldX = (hostX - translateX) / scale;
  const worldY = (hostY - translateY) / scale;
  return {
    scale: nextScale,
    translateX: hostX - worldX * nextScale,
    translateY: hostY - worldY * nextScale,
  };
}

export function panBy({ scale, translateX, translateY }, { dx = 0, dy = 0 } = {}) {
  return {
    scale,
    translateX: translateX + dx,
    translateY: translateY + dy,
  };
}

export function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointerMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function wheelZoomFactor(deltaY) {
  return deltaY < 0 ? 1.08 : 1 / 1.08;
}
