/**
 * Tests for `ScrollMarginViewportScroller`. Named `.component.spec.ts` so it runs
 * under `ng test` — the provider factory needs Angular DI (`DOCUMENT`,
 * `PLATFORM_ID`).
 *
 * The scroller itself is a plain class, so most cases construct it directly over
 * a stub `Document` + `Window`. Real layout is not available under `ng test`, so
 * `getBoundingClientRect` and `getComputedStyle` are stubbed with the numbers the
 * real page produces: `/products/procore` measured `#reviews` at
 * `rect.top = 1381`, `scroll-margin-top: 80px`, and Angular's stock scroller
 * scrolled to `1381` where the browser had correctly landed on `1301`.
 */
import { DOCUMENT, ViewportScroller } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  NoopViewportScroller,
  ScrollMarginViewportScroller,
  provideScrollMarginViewportScroller,
} from './scroll-margin-viewport-scroller';

interface Stub {
  scroller: ScrollMarginViewportScroller;
  scrollTo: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  el: HTMLElement | null;
}

/**
 * Build a scroller over a fake document holding a single anchor target.
 * `rectTop` is the target's viewport-relative top, `scrollY` the current page
 * offset, `scrollMarginTop` its computed CSS clearance.
 */
function stub(opts: {
  id?: string | null;
  rectTop?: number;
  rectLeft?: number;
  scrollX?: number;
  scrollY?: number;
  scrollMarginTop?: string;
  scrollMarginLeft?: string;
}): Stub {
  const {
    id = 'reviews',
    rectTop = 1381,
    rectLeft = 32,
    scrollX = 0,
    scrollY = 0,
    scrollMarginTop = '80px',
    scrollMarginLeft = '0px',
  } = opts;

  const scrollTo = vi.fn();
  const focus = vi.fn();
  const el = id
    ? ({
        focus,
        getBoundingClientRect: () => ({ top: rectTop, left: rectLeft }),
      } as unknown as HTMLElement)
    : null;

  const document = {
    getElementById: (target: string) => (target === id ? el : null),
    getElementsByName: () => ({ item: () => null }),
  } as unknown as Document;

  const window = {
    scrollX,
    scrollY,
    scrollTo,
    getComputedStyle: () => ({ scrollMarginTop, scrollMarginLeft }),
    history: {} as History,
  } as unknown as Window;

  return { scroller: new ScrollMarginViewportScroller(document, window), scrollTo, focus, el };
}

describe('ScrollMarginViewportScroller', () => {
  it('subtracts the target scroll-margin-top so the heading clears the sticky nav', () => {
    // Angular's stock scroller would scroll to 1381 and park #reviews flush with
    // the viewport top, under the ~50px sticky section-nav.
    const { scroller, scrollTo } = stub({ rectTop: 1381, scrollY: 0, scrollMarginTop: '80px' });

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1301 }));
  });

  it('adds the current scroll offset, so the target position is absolute', () => {
    const { scroller, scrollTo } = stub({ rectTop: 200, scrollY: 1000, scrollMarginTop: '80px' });

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1120 }));
  });

  it('matches Angular stock behavior when the target has no scroll-margin', () => {
    // The `#main` skip-link target: no clearance declared, so nothing changes.
    const { scroller, scrollTo } = stub({ rectTop: 640, scrollY: 0, scrollMarginTop: '0px' });

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 640 }));
  });

  it('treats a non-numeric computed margin as zero', () => {
    const { scroller, scrollTo } = stub({ rectTop: 640, scrollMarginTop: 'auto' });

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 640 }));
  });

  it('adds any configured setOffset on TOP of the scroll-margin', () => {
    const { scroller, scrollTo } = stub({ rectTop: 1381, scrollMarginTop: '80px' });
    scroller.setOffset([0, 20]);

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1281 }));
  });

  it('accepts a function form of setOffset, evaluated at scroll time', () => {
    const { scroller, scrollTo } = stub({ rectTop: 1381, scrollMarginTop: '80px' });
    let dynamic = 0;
    scroller.setOffset(() => [0, dynamic]);

    dynamic = 30;
    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1271 }));
  });

  it('honors the horizontal axis the same way', () => {
    const { scroller, scrollTo } = stub({ rectLeft: 300, scrollX: 50, scrollMarginLeft: '16px' });

    scroller.scrollToAnchor('reviews');

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 334 }));
  });

  it('forwards the caller scroll options', () => {
    const { scroller, scrollTo } = stub({});

    scroller.scrollToAnchor('reviews', { behavior: 'instant' as ScrollBehavior });

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }));
  });

  it('focuses the target without scrolling again', () => {
    const { scroller, focus } = stub({});

    scroller.scrollToAnchor('reviews');

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does nothing when the fragment matches no element', () => {
    const { scroller, scrollTo } = stub({ id: null });

    scroller.scrollToAnchor('missing');

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrollToPosition is unaffected by scroll-margin or offset', () => {
    // Back/Forward restoration must land on the exact stored pixel — the offset
    // is an anchor-only concern, exactly as in Angular's own scroller.
    const { scroller, scrollTo } = stub({});
    scroller.setOffset([0, 80]);

    scroller.scrollToPosition([0, 950]);

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 0, top: 950 }));
  });

  it('swallows a rejected history.scrollRestoration write', () => {
    const scrollTo = vi.fn();
    const window = {
      scrollX: 0,
      scrollY: 0,
      scrollTo,
      getComputedStyle: () => ({ scrollMarginTop: '0px', scrollMarginLeft: '0px' }),
      history: {
        set scrollRestoration(_: string) {
          throw new Error('sandboxed');
        },
      },
    } as unknown as Window;
    const scroller = new ScrollMarginViewportScroller({} as Document, window);

    expect(() => scroller.setHistoryScrollRestoration('manual')).not.toThrow();
  });
});

describe('provideScrollMarginViewportScroller', () => {
  it('installs the scroll-margin-aware scroller in the browser', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideScrollMarginViewportScroller(),
      ],
    });

    expect(TestBed.inject(ViewportScroller)).toBeInstanceOf(ScrollMarginViewportScroller);
  });

  it('falls back to a no-op on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: DOCUMENT, useValue: { defaultView: null } as unknown as Document },
        provideScrollMarginViewportScroller(),
      ],
    });

    expect(TestBed.inject(ViewportScroller)).toBeInstanceOf(NoopViewportScroller);
  });
});
