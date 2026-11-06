/**
 * Tests for `PreStableScrollReset` (AECI-1629). Named `.component.spec.ts` so it
 * runs under `ng test`, since it needs Angular DI.
 *
 * The `Router` is a stub driven through a `Subject`, `ViewportScroller` is a spy,
 * and `ApplicationRef.whenStable()` is a promise each test resolves itself. So the
 * tests control exactly when the app turns stable and whether the router emitted
 * its own `Scroll` event.
 */
import { ViewportScroller } from '@angular/common';
import { ApplicationRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DefaultUrlSerializer,
  type Event,
  type Navigation,
  NavigationEnd,
  NavigationStart,
  Router,
  Scroll,
} from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { PreStableScrollReset } from './pre-stable-scroll-reset';

function configure(platform: 'browser' | 'server' = 'browser') {
  const events = new Subject<Event>();
  const currentNavigation = signal<Navigation | null>(null);
  const serializer = new DefaultUrlSerializer();
  let markStable: () => void = () => {};
  const stable = new Promise<void>((resolve) => (markStable = resolve));
  let scrollY = 0;
  const scroller = {
    getScrollPosition: vi.fn(() => [0, scrollY] as [number, number]),
    scrollToPosition: vi.fn(),
    scrollToAnchor: vi.fn(),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      {
        provide: Router,
        useValue: { events, currentNavigation, parseUrl: (url: string) => serializer.parse(url) },
      },
      { provide: ViewportScroller, useValue: scroller },
      { provide: ApplicationRef, useValue: { whenStable: () => stable } },
    ],
  });
  const service = TestBed.inject(PreStableScrollReset);

  let id = 0;
  const navigate = (
    url: string,
    opts: { trigger?: 'imperative' | 'popstate'; restoredId?: number; scroll?: 'manual' } = {},
  ): NavigationEnd => {
    id++;
    events.next(
      new NavigationStart(
        id,
        url,
        opts.trigger ?? 'imperative',
        opts.restoredId ? { navigationId: opts.restoredId } : null,
      ),
    );
    currentNavigation.set({ extras: { scroll: opts.scroll } } as unknown as Navigation);
    const end = new NavigationEnd(id, url, url);
    events.next(end);
    currentNavigation.set(null);
    return end;
  };

  return {
    events,
    service,
    scroller,
    navigate,
    markStable,
    setScrollY: (y: number) => (scrollY = y),
  };
}

/** Past the router's task/frame race plus the fallback's extra task. */
const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('PreStableScrollReset', () => {
  it('leaves the initial hydration navigation alone', async () => {
    const { service, scroller, navigate } = configure();
    service.start();

    navigate('/products');
    await settle();

    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
    expect(scroller.scrollToAnchor).not.toHaveBeenCalled();
  });

  it('scrolls to the top, instantly, for a click before the app is stable', async () => {
    const { service, scroller, navigate } = configure();
    service.start();

    navigate('/products');
    navigate('/products/procore');
    await settle();

    expect(scroller.scrollToPosition).toHaveBeenCalledExactlyOnceWith([0, 0], {
      behavior: 'instant',
    });
  });

  it('stands down when the router emitted its own Scroll for the navigation', async () => {
    const { events, service, scroller, navigate } = configure();
    service.start();

    navigate('/products');
    const end = navigate('/products/procore');
    events.next(new Scroll(end, null, null));
    await settle();

    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
  });

  it('does nothing once the app has been stable', async () => {
    const { service, scroller, navigate, markStable } = configure();
    service.start();

    navigate('/products');
    markStable();
    await Promise.resolve();
    navigate('/products/procore');
    await settle();

    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
  });

  it('respects scroll: manual on listing filter and sort navigations', async () => {
    const { service, scroller, navigate } = configure();
    service.start();

    navigate('/products');
    navigate('/products?sort=name', { scroll: 'manual' });
    await settle();

    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
  });

  it('scrolls to the fragment through the ViewportScroller', async () => {
    const { service, scroller, navigate } = configure();
    service.start();

    navigate('/products');
    navigate('/products/procore#integrations');
    await settle();

    expect(scroller.scrollToAnchor).toHaveBeenCalledExactlyOnceWith('integrations');
    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restores the saved position on Back before the app is stable', async () => {
    const { service, scroller, navigate, setScrollY } = configure();
    service.start();

    navigate('/products');
    setScrollY(143);
    navigate('/products/procore');
    setScrollY(0);
    navigate('/products', { trigger: 'popstate', restoredId: 1 });
    await settle();

    expect(scroller.scrollToPosition).toHaveBeenLastCalledWith([0, 143], { behavior: 'instant' });
  });

  it('is a no-op on the server', async () => {
    const { service, scroller, navigate } = configure('server');
    service.start();

    navigate('/products');
    navigate('/products/procore');
    await settle();

    expect(scroller.scrollToPosition).not.toHaveBeenCalled();
  });
});
