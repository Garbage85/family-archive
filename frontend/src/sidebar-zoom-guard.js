export class SidebarZoomGuard {
  constructor(panel, eventRoot = panel?.ownerDocument) {
    if (!panel) throw new Error('Sidebar zoom guard panel is required.');

    this.panel = panel;
    this.eventRoot = eventRoot || panel;
    this.activeTouchPointers = new Set();
    this.listenerCleanups = [];
    this.active = false;
    this.gestureActive = false;

    this.onPointerDown = (event) => {
      if (event.pointerType !== 'touch') return;
      this.activeTouchPointers.add(event.pointerId);
      this.preventMultiPointerGesture(event);
    };
    this.onPointerMove = (event) => {
      if (event.pointerType !== 'touch') return;
      this.preventMultiPointerGesture(event);
    };
    this.onPointerEnd = (event) => {
      if (event.pointerType === 'touch') this.activeTouchPointers.delete(event.pointerId);
    };
    this.onTouchMove = (event) => {
      if (event.touches?.length >= 2) event.preventDefault();
    };
    this.onGestureStart = (event) => {
      this.gestureActive = true;
      event.preventDefault();
    };
    this.onGestureChange = (event) => {
      event.preventDefault();
    };
    this.onGestureEnd = () => {
      this.gestureActive = false;
    };
  }

  preventMultiPointerGesture(event) {
    if (this.activeTouchPointers.size >= 2) event.preventDefault();
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listenerCleanups.push(() => target.removeEventListener(type, handler, options));
  }

  activate() {
    if (this.active) return;

    this.active = true;
    this.listen(this.panel, 'pointerdown', this.onPointerDown, { passive: false });
    this.listen(this.panel, 'pointermove', this.onPointerMove, { passive: false });
    this.listen(this.eventRoot, 'pointerup', this.onPointerEnd, {
      capture: true,
      passive: true,
    });
    this.listen(this.eventRoot, 'pointercancel', this.onPointerEnd, {
      capture: true,
      passive: true,
    });
    this.listen(this.panel, 'touchmove', this.onTouchMove, { passive: false });
    this.listen(this.panel, 'gesturestart', this.onGestureStart, { passive: false });
    this.listen(this.panel, 'gesturechange', this.onGestureChange, { passive: false });
    this.listen(this.panel, 'gestureend', this.onGestureEnd, { passive: true });
  }

  deactivate() {
    for (const cleanup of this.listenerCleanups.splice(0)) cleanup();
    this.activeTouchPointers.clear();
    this.gestureActive = false;
    this.active = false;
  }

  destroy() {
    this.deactivate();
    this.panel = null;
    this.eventRoot = null;
  }
}
