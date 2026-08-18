/**
 * Tests for `PageViewTracker` (AECI-151). Named `.component.spec.ts` so it runs
 * under `ng test` — needs Angular DI (`HttpClient`, `Router`, `PLATFORM_ID`).
 *
 * The `Router` is stubbed with a `Subject` we drive directly so navigations can
 * be emitted synchronously without booting the real router.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Event, NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { PageViewTracker } from './page-view-tracker';

function configure(platform: 'browser' | 'server') {
  const events = new Subject<Event>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: Router, useValue: { events } },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    events,
    tracker: TestBed.inject(PageViewTracker),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

const nav = (id: number, url: string) => new NavigationEnd(id, url, url);

describe('PageViewTracker', () => {
  it('skips the initial navigation and POSTs a route for subsequent ones', () => {
    const { events, tracker, httpMock } = configure('browser');
    tracker.start();

    // Hydration of the Worker-rendered landing page — already counted; skipped.
    events.next(nav(1, '/'));
    httpMock.expectNone('/api/page-views');

    events.next(nav(2, '/vendors/autodesk'));
    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ route: '/vendors/autodesk', navigation: 'spa' });
    req.flush(null, { status: 204, statusText: 'No Content' });

    httpMock.verify();
  });

  it('strips query string and hash from the route', () => {
    const { events, tracker, httpMock } = configure('browser');
    tracker.start();
    events.next(nav(1, '/')); // skipped
    events.next(nav(2, '/products?page=2&sort=name#top'));

    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    httpMock.verify();
  });

  it('is a no-op on the server', () => {
    const { events, tracker, httpMock } = configure('server');
    tracker.start();
    events.next(nav(1, '/'));
    events.next(nav(2, '/vendors/x'));
    httpMock.expectNone('/api/page-views');
    httpMock.verify();
  });

  it('start() is idempotent — a second call does not double-subscribe', () => {
    const { events, tracker, httpMock } = configure('browser');
    tracker.start();
    tracker.start();
    events.next(nav(1, '/')); // skipped once
    events.next(nav(2, '/about'));

    // Exactly one POST despite two start() calls.
    httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });
    httpMock.verify();
  });

  // AECI-575 / ADMIN_PANEL_SPEC §9.6 — the console must not record its own
  // navigation into the table it reads.
  describe('operator-only routes', () => {
    const ADMIN_TREE = [
      '/admin',
      '/admin/reviews',
      '/admin/requests',
      '/admin/reviewers',
      // A route the tree doesn't have yet: prefix matching must cover it too,
      // so a new admin child never needs a spec change here.
      '/admin/traffic/breakdown',
      '/admin/reviews?status=pending#queue',
      '/account',
    ];

    it('writes zero page views across the whole /admin tree and /account', () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // the skipped initial navigation

      ADMIN_TREE.forEach((url, i) => events.next(nav(i + 2, url)));

      httpMock.expectNone('/api/page-views');
      httpMock.verify();
    });

    it('keeps tracking public routes navigated after an excluded one', () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/admin/reviews'));
      httpMock.expectNone('/api/page-views');

      // The subscription survives the skip — the next public navigation counts.
      events.next(nav(3, '/products/procore'));
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/products/procore', navigation: 'spa' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('does not exclude public routes that merely share a prefix', () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products/admin-tool'));
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/products/admin-tool', navigation: 'spa' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });
  });

  // AECI-585 / ADMIN_PANEL_SPEC §7.3 — this tracker fires ONLY on in-app
  // navigation, so `spa` is a property of the writer rather than a guess. Without
  // it the same-origin `Referer` on this POST classifies as `Direct`, which is what
  // made `Direct` a mixed bucket of true arrivals and in-app clicks.
  describe('navigation flag', () => {
    it('tags every POST as an SPA navigation', () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      for (const [i, url] of ['/products', '/products/procore', '/vendors/autodesk'].entries()) {
        events.next(nav(i + 2, url));
        const req = httpMock.expectOne('/api/page-views');
        expect(req.request.body).toEqual({ route: url, navigation: 'spa' });
        req.flush(null, { status: 204, statusText: 'No Content' });
      }

      httpMock.verify();
    });

    it('sends no explicit path — the route is already concrete', () => {
      // The API falls back to `route` for the concrete path, so duplicating it on
      // the wire would cost bytes on every in-app click for nothing.
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped
      events.next(nav(2, '/categories/bim-coordination'));

      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).not.toHaveProperty('path');
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });
  });
});
