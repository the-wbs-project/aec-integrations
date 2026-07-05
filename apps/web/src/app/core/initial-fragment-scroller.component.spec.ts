/**
 * Tests for `InitialFragmentScroller`. Named `.component.spec.ts` so it runs under
 * `ng test` — needs Angular DI (`Router`, `DOCUMENT`, `PLATFORM_ID`).
 *
 * The `Router` is stubbed with a `Subject` we drive directly, and `DOCUMENT` with
 * a minimal stand-in exposing `defaultView` (a fake window with `location`,
 * `scrollY`, `requestAnimationFrame`, `setTimeout`) and `getElementById` /
 * `getElementsByName`, so we can assert `scrollIntoView` is (or isn't) called
 * without booting the real router or touching the shared jsdom document. The
 * first-pass jump runs on `requestAnimationFrame`, flushed by awaiting a frame.
 */
import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Event, NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { InitialFragmentScroller } from './initial-fragment-scroller';

interface FakeEl {
  scrollIntoView: ReturnType<typeof vi.fn>;
}

function configure(opts: {
  platform: 'browser' | 'server';
  hash: string;
  hasElement?: boolean;
  scrollY?: number;
}) {
  const events = new Subject<Event>();
  const el: FakeEl = { scrollIntoView: vi.fn() };
  const timeoutCbs: Array<() => void> = [];

  const win = {
    location: { hash: opts.hash },
    scrollY: opts.scrollY ?? 0,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      // Defer to a real frame so the test can flush it deterministically.
      requestAnimationFrame(() => cb(0));
      return 0;
    },
    setTimeout: (cb: () => void) => {
      timeoutCbs.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  };

  const doc = {
    defaultView: opts.platform === 'browser' ? win : null,
    getElementById: (id: string) => (opts.hasElement !== false && id ? el : null),
    getElementsByName: () => ({ item: () => null }),
  } as unknown as Document;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform },
      { provide: Router, useValue: { events } },
      { provide: DOCUMENT, useValue: doc },
    ],
  });
  return {
    events,
    el,
    win,
    flushReAssert: () => timeoutCbs.forEach((cb) => cb()),
    manager: TestBed.inject(InitialFragmentScroller),
  };
}

// Flush a frame so the service's deferred `requestAnimationFrame` jump runs (the
// app is zoneless, so `fakeAsync`/`tick` are unavailable).
const flushFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe('InitialFragmentScroller', () => {
  it('scrolls to the fragment target on the initial NavigationEnd', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '#integrations' });
    manager.start();

    events.next(new NavigationEnd(1, '/products/x', '/products/x'));
    await flushFrame();

    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  });

  it('does nothing when there is no fragment', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '' });
    manager.start();

    events.next(new NavigationEnd(1, '/products/x', '/products/x'));
    await flushFrame();

    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('only acts on the first navigation — later ones are left to RouterScroller', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '#integrations' });
    manager.start();

    events.next(new NavigationEnd(1, '/products/x', '/products/x'));
    await flushFrame();
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);

    // A subsequent in-app navigation must NOT re-trigger the initial-load jump.
    events.next(new NavigationEnd(2, '/products/y', '/products/y'));
    await flushFrame();
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('re-asserts once for late layout shift, but not if the visitor scrolled away', async () => {
    // Visitor stays put: re-assert fires.
    const stayed = configure({ platform: 'browser', hash: '#integrations', scrollY: 0 });
    stayed.manager.start();
    stayed.events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();
    stayed.flushReAssert();
    expect(stayed.el.scrollIntoView).toHaveBeenCalledTimes(2);

    // Visitor scrolled away before the re-assert (scrollY drifted): no re-jump.
    const moved = configure({ platform: 'browser', hash: '#integrations', scrollY: 0 });
    moved.manager.start();
    moved.events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();
    moved.win.scrollY = 900;
    moved.flushReAssert();
    expect(moved.el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on the server', async () => {
    const { events, el, manager } = configure({ platform: 'server', hash: '#integrations' });
    manager.start();

    events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();

    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('start() is idempotent — a second call does not double-subscribe', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '#integrations' });
    manager.start();
    manager.start();

    events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw id (does not throw) on a malformed percent-encoded hash', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '#%E0%A4%A' });
    manager.start();

    events.next(new NavigationEnd(1, '/x', '/x'));
    await flushFrame();

    // Decoding '#%E0%A4%A' throws URIError; the manager must swallow it and still
    // attempt the jump with the raw id.
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('ignores non-NavigationEnd events', async () => {
    const { events, el, manager } = configure({ platform: 'browser', hash: '#integrations' });
    manager.start();

    events.next(new NavigationStart(1, '/x'));
    await flushFrame();

    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });
});
