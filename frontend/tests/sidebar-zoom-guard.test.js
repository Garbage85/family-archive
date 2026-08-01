import test from 'node:test';
import assert from 'node:assert/strict';
import { SidebarZoomGuard } from '../src/sidebar-zoom-guard.js';

class EventTargetSpy {
  constructor() {
    this.listeners = new Map();
    this.added = [];
    this.removed = [];
  }

  addEventListener(type, handler, options) {
    this.listeners.set(type, handler);
    this.added.push({ type, handler, options });
  }

  removeEventListener(type, handler, options) {
    this.listeners.delete(type);
    this.removed.push({ type, handler, options });
  }

  dispatch(type, event) {
    this.listeners.get(type)?.(event);
  }
}

test('zoom guard registers non-passive multi-touch and iOS gesture handlers', () => {
  const panel = new EventTargetSpy();
  const eventRoot = new EventTargetSpy();
  const guard = new SidebarZoomGuard(panel, eventRoot);

  guard.activate();

  assert.deepEqual(
    panel.added.map(({ type, options }) => [type, options.passive]),
    [
      ['pointerdown', false],
      ['pointermove', false],
      ['touchmove', false],
      ['gesturestart', false],
      ['gesturechange', false],
      ['gestureend', true],
    ],
  );
  assert.deepEqual(
    eventRoot.added.map(({ type, options }) => [type, options.passive]),
    [
      ['pointerup', true],
      ['pointercancel', true],
    ],
  );
});

test('zoom guard blocks multi-touch while preserving one-finger interaction', () => {
  const panel = new EventTargetSpy();
  const eventRoot = new EventTargetSpy();
  const guard = new SidebarZoomGuard(panel, eventRoot);
  let prevented = 0;
  const pointer = (pointerId) => ({
    pointerId,
    pointerType: 'touch',
    preventDefault: () => {
      prevented += 1;
    },
  });

  guard.activate();
  panel.dispatch('pointerdown', pointer(1));
  panel.dispatch('pointermove', pointer(1));
  assert.equal(prevented, 0);

  panel.dispatch('pointerdown', pointer(2));
  panel.dispatch('pointermove', pointer(1));
  assert.equal(prevented, 2);

  eventRoot.dispatch('pointercancel', pointer(2));
  panel.dispatch('pointermove', pointer(1));
  assert.equal(prevented, 2);
});

test('zoom guard removes every handler and clears pointer state on deactivate and destroy', () => {
  const panel = new EventTargetSpy();
  const eventRoot = new EventTargetSpy();
  const guard = new SidebarZoomGuard(panel, eventRoot);

  guard.activate();
  panel.dispatch('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    preventDefault() {},
  });
  guard.deactivate();

  assert.equal(panel.removed.length, panel.added.length);
  assert.equal(eventRoot.removed.length, eventRoot.added.length);
  assert.equal(guard.activeTouchPointers.size, 0);
  assert.equal(guard.active, false);

  guard.activate();
  guard.destroy();
  assert.equal(panel.removed.length, panel.added.length);
  assert.equal(eventRoot.removed.length, eventRoot.added.length);
});
