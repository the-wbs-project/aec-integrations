/**
 * Tests for `ScrollBehaviorManager`. Named `.component.spec.ts` so it runs under
 * `ng test` — needs Angular DI (`Router`, `DOCUMENT`, `PLATFORM_ID`).
 *
 * The `Router` is stubbed with a `Subject` we drive directly, and `DOCUMENT` with
 * a minimal `{ documentElement: { style } }` stand-in, so we can assert the inline
 * `scroll-behavior` toggling without booting the real router or touching the
 * shared jsdom document. Deferred restores run on `requestAnimationFrame`,
 * flushed by awaiting a frame.
 */
import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type Event,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ScrollBehaviorManager } from './scroll-behavior-manager';

function configure(platform: 'browser' | 'server') {
  const events = new Subject<Event>();
  const root = { style: { scrollBehavior: '' } };
  const doc = { documentElement: root } as unknown as Document;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: Router, useValue: { events } },
      { provide: DOCUMENT, useValue: doc },
    ],
  });
  return { events, root, manager: TestBed.inject(ScrollBehaviorManager) };
}

// Flush a frame so the service's deferred `requestAnimationFrame` restore runs
// (the app is zoneless, so `fakeAsync`/`tick` are unavailable). The service
// registers its rAF before this one, and rAF callbacks fire in registration
// order within a frame, so its restore has run once this resolves.
const flushFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe('ScrollBehaviorManager', () => {
  it('disables smooth scrolling when a navigation starts', () => {
    const { events, root, manager } = configure('browser');
    manager.start();

    events.next(new NavigationStart(1, '/products'));
    expect(root.style.scrollBehavior).toBe('auto');
  });

  it('restores smooth scrolling after NavigationEnd, deferred past the router scroll', async () => {
    const { events, root, manager } = configure('browser');
    manager.start();

    events.next(new NavigationStart(1, '/products/x'));
    events.next(new NavigationEnd(1, '/products/x', '/products/x'));
    // Still 'auto' synchronously: the restore is deferred to a frame so it lands
    // AFTER the router's own scroll reset, keeping the reset instant.
    expect(root.style.scrollBehavior).toBe('auto');

    await flushFrame();
    expect(root.style.scrollBehavior).toBe('');
  });

  it('restores after a skipped navigation', async () => {
    const { events, root, manager } = configure('browser');
    manager.start();

    events.next(new NavigationStart(1, '/products'));
    events.next(new NavigationSkipped(1, '/products', ''));
    await flushFrame();
    expect(root.style.scrollBehavior).toBe('');
  });

  it('restores immediately on a cancelled navigation (no scroll to wait for)', () => {
    const { events, root, manager } = configure('browser');
    manager.start();

    events.next(new NavigationStart(1, '/x'));
    events.next(new NavigationCancel(1, '/x', ''));
    expect(root.style.scrollBehavior).toBe('');
  });

  it('restores immediately on a navigation error', () => {
    const { events, root, manager } = configure('browser');
    manager.start();

    events.next(new NavigationStart(1, '/x'));
    events.next(new NavigationError(1, '/x', new Error('boom')));
    expect(root.style.scrollBehavior).toBe('');
  });

  it('is a no-op on the server', () => {
    const { events, root, manager } = configure('server');
    manager.start();

    events.next(new NavigationStart(1, '/x'));
    expect(root.style.scrollBehavior).toBe('');
  });

  it('start() is idempotent — a second call still toggles as expected', async () => {
    const { events, root, manager } = configure('browser');
    manager.start();
    manager.start();

    events.next(new NavigationStart(1, '/x'));
    expect(root.style.scrollBehavior).toBe('auto');
    events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();
    expect(root.style.scrollBehavior).toBe('');
  });
});
