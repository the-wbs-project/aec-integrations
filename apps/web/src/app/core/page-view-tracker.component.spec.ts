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
  it('skips the initial navigation and POSTs a { route } for subsequent ones', () => {
    const { events, tracker, httpMock } = configure('browser');
    tracker.start();

    // Hydration of the Worker-rendered landing page — already counted; skipped.
    events.next(nav(1, '/'));
    httpMock.expectNone('/api/page-views');

    events.next(nav(2, '/vendors/autodesk'));
    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ route: '/vendors/autodesk' });
    req.flush(null, { status: 204, statusText: 'No Content' });

    httpMock.verify();
  });

  it('strips query string and hash from the route', () => {
    const { events, tracker, httpMock } = configure('browser');
    tracker.start();
    events.next(nav(1, '/')); // skipped
    events.next(nav(2, '/products?page=2&sort=name#top'));

    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.body).toEqual({ route: '/products' });
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
});
