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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageViewTracker } from './page-view-tracker';
import { TURNSTILE_VERDICT_URL, TurnstileService } from './turnstile.service';

/** A stand-in for `TurnstileService`, which the tracker resolves from the
 *  injector after its dynamic `import()`. Inactive by default, which is the
 *  shipped (dark) state every pre-AECI-1457 test below runs in. */
function fakeTurnstile(active = false, token: string | null = null) {
  return { active, getToken: vi.fn(async (_cData?: string) => token) };
}

type ConfigWindow = Window & { __AECI_TURNSTILE__?: unknown };

/** Ship (or withhold) the inline site-key config the tracker gates the import on. */
function setTurnstileConfig(shipped: boolean): void {
  if (shipped)
    (window as ConfigWindow).__AECI_TURNSTILE__ = { siteKey: '1x00000000000000000000BB' };
  else delete (window as ConfigWindow).__AECI_TURNSTILE__;
}

/** Long enough for the lazy import and any token chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function configure(
  platform: 'browser' | 'server',
  turnstile: ReturnType<typeof fakeTurnstile> = fakeTurnstile(),
) {
  const events = new Subject<Event>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: Router, useValue: { events } },
      { provide: TurnstileService, useValue: turnstile },
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

  // AECI-743 — a navigation that only rewrote the query string is not a new view.
  // With `?`/`#` stripped, those produce a row byte-identical to the previous one,
  // and the debounced URL syncs in search / pagination / facets fire several per
  // interaction.
  describe('query-only re-navigation (AECI-743)', () => {
    it('POSTs once when a page re-syncs its query string repeatedly', () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/search?q=re'));
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/search', navigation: 'spa' });
      req.flush(null, { status: 204, statusText: 'No Content' });

      // The debounce fires again as the query grows — same path, no new view.
      events.next(nav(3, '/search?q=revit'));
      events.next(nav(4, '/search?q=revit&category=bim'));
      httpMock.expectNone('/api/page-views');
      httpMock.verify();
    });

    it('does not re-count the landing page when its first URL sync lands', () => {
      // The skipped initial navigation seeds the memo, so a facet sync immediately
      // after hydration cannot re-count the arrival the SSR Worker already wrote.
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/products'));
      events.next(nav(2, '/products?sort=name'));

      httpMock.expectNone('/api/page-views');
      httpMock.verify();
    });

    it('counts a genuine return to the same path later in the session', () => {
      // Only CONSECUTIVE repeats collapse — A → B → A is two views of A.
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products'));
      httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });

      events.next(nav(3, '/products/procore'));
      httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });

      events.next(nav(4, '/products'));
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('does not let an excluded route poison the memo', () => {
      // `/admin` returns before the memo is touched, so a public route visited
      // before AND after an admin hop still counts the second time.
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products'));
      httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });

      events.next(nav(3, '/admin/reviews'));
      httpMock.expectNone('/api/page-views');

      // Consecutive repeat of `/products` as far as the memo is concerned — and it
      // must stay suppressed, because nothing was written for the admin hop.
      events.next(nav(4, '/products'));
      httpMock.expectNone('/api/page-views');
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

  // AECI-1457 — Turnstile verdict as a classifier input. Capture only: the token
  // rides along when Turnstile is active and is never a reason to skip a beacon.
  describe('Turnstile (AECI-1457)', () => {
    const RAY = '8f2a1b3c4d5e6f70-SIN';

    /** Stub the navigation timing entry the gateway's Server-Timing lands in. */
    function stubServerTiming(entries: { name: string; description: string }[] | undefined) {
      return vi
        .spyOn(performance, 'getEntriesByType')
        .mockReturnValue(
          entries === undefined
            ? []
            : ([{ serverTiming: entries }] as unknown as PerformanceEntryList),
        );
    }

    afterEach(() => {
      vi.restoreAllMocks();
      setTurnstileConfig(false);
    });

    it('carries the token on an SPA beacon when Turnstile is active', async () => {
      stubServerTiming([]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok-spa');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products/procore'));
      const req = await vi.waitFor(() => httpMock.expectOne('/api/page-views'));
      // SPA tokens carry no cData: the beacon itself is the row being written.
      expect(turnstile.getToken).toHaveBeenLastCalledWith();
      expect(req.request.body).toEqual({
        route: '/products/procore',
        navigation: 'spa',
        turnstile_token: 'tok-spa',
      });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('still sends the beacon, without the field, when no token comes back', async () => {
      stubServerTiming([]);
      setTurnstileConfig(true);
      const { events, tracker, httpMock } = configure('browser', fakeTurnstile(true, null));
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/vendors/autodesk'));
      const req = await vi.waitFor(() => httpMock.expectOne('/api/page-views'));
      expect(req.request.body).toEqual({ route: '/vendors/autodesk', navigation: 'spa' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('still posts, without a token, when the loaded service reports inactive', async () => {
      stubServerTiming([]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(false);
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products'));
      const req = await vi.waitFor(() => httpMock.expectOne('/api/page-views'));
      expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
      expect(turnstile.getToken).not.toHaveBeenCalled();
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('skips Turnstile under Global Privacy Control even with a site key', () => {
      setTurnstileConfig(true);
      Object.defineProperty(window.navigator, 'globalPrivacyControl', {
        value: true,
        configurable: true,
      });
      try {
        const turnstile = fakeTurnstile(true, 'tok');
        const { events, tracker, httpMock } = configure('browser', turnstile);
        tracker.start();
        events.next(nav(1, '/')); // skipped

        events.next(nav(2, '/products'));
        // Synchronous and token-free: the gate is read before any import.
        const req = httpMock.expectOne('/api/page-views');
        expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
        expect(turnstile.getToken).not.toHaveBeenCalled();
        req.flush(null, { status: 204, statusText: 'No Content' });
        httpMock.verify();
      } finally {
        Object.defineProperty(window.navigator, 'globalPrivacyControl', {
          value: undefined,
          configurable: true,
        });
      }
    });

    it('posts at once and unchanged when Turnstile is inactive', () => {
      const turnstile = fakeTurnstile(false);
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();
      events.next(nav(1, '/')); // skipped

      events.next(nav(2, '/products'));
      // Synchronous: no await between the navigation and the request.
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
      expect(req.request.body).not.toHaveProperty('turnstile_token');
      expect(turnstile.getToken).not.toHaveBeenCalled();
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('posts the landing verdict for the ray in Server-Timing, and no beacon', async () => {
      stubServerTiming([
        { name: 'render', description: '' },
        { name: 'cfray', description: RAY },
      ]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok-landing');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));

      const req = await vi.waitFor(() => httpMock.expectOne(TURNSTILE_VERDICT_URL));
      // The token is bound to the ray through cData.
      expect(turnstile.getToken).toHaveBeenCalledWith(RAY);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ cf_ray: RAY, token: 'tok-landing' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.expectNone('/api/page-views');
      httpMock.verify();
    });

    it('posts no landing verdict when the response carried no cfray entry', async () => {
      stubServerTiming([{ name: 'render', description: '' }]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));
      await settle();

      expect(turnstile.getToken).not.toHaveBeenCalled();
      httpMock.expectNone(TURNSTILE_VERDICT_URL);
      httpMock.verify();
    });

    it('posts no landing verdict for a malformed ray', async () => {
      stubServerTiming([{ name: 'cfray', description: 'not-a-ray' }]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));
      await settle();

      expect(turnstile.getToken).not.toHaveBeenCalled();
      httpMock.expectNone(TURNSTILE_VERDICT_URL);
      httpMock.verify();
    });

    it('posts no landing verdict when no token comes back', async () => {
      stubServerTiming([{ name: 'cfray', description: RAY }]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, null);
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));
      await vi.waitFor(() => expect(turnstile.getToken).toHaveBeenCalled());
      await settle();

      httpMock.expectNone(TURNSTILE_VERDICT_URL);
      httpMock.verify();
    });

    it('posts no landing verdict on an untracked route (no arrival row exists)', async () => {
      stubServerTiming([{ name: 'cfray', description: RAY }]);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/admin/reviews'));
      await settle();

      expect(turnstile.getToken).not.toHaveBeenCalled();
      httpMock.expectNone(TURNSTILE_VERDICT_URL);
      httpMock.verify();
    });

    // AECI-1581: the geo exclusion, until the AECI-1458 ruling.
    it.each([
      [
        'the gateway stamped geo=eu',
        [
          { name: 'cfray', description: RAY },
          { name: 'geo', description: 'eu' },
        ],
      ],
      ['the browser exposes no navigation entry', undefined],
    ])('sends no landing verdict and no token when %s', async (_label, entries) => {
      stubServerTiming(entries);
      setTurnstileConfig(true);
      const turnstile = fakeTurnstile(true, 'tok');
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));
      await settle();
      httpMock.expectNone(TURNSTILE_VERDICT_URL);

      events.next(nav(2, '/products'));
      // Synchronous and token-free: the gate is read before any import.
      const req = httpMock.expectOne('/api/page-views');
      expect(req.request.body).toEqual({ route: '/products', navigation: 'spa' });
      expect(turnstile.getToken).not.toHaveBeenCalled();
      req.flush(null, { status: 204, statusText: 'No Content' });
      httpMock.verify();
    });

    it('never runs Turnstile for the landing view when it is inactive', () => {
      const spy = stubServerTiming([{ name: 'cfray', description: RAY }]);
      const turnstile = fakeTurnstile(false);
      const { events, tracker, httpMock } = configure('browser', turnstile);
      tracker.start();

      events.next(nav(1, '/products/procore'));

      expect(spy).not.toHaveBeenCalled();
      expect(turnstile.getToken).not.toHaveBeenCalled();
      httpMock.expectNone(TURNSTILE_VERDICT_URL);
      httpMock.verify();
    });
  });

  // AECI-1714 — the browser report: `ran` for the landing view, `interacted` once
  // per view on the first interaction, behind the tier flag, DNT/GPC and region.
  describe('browser report (AECI-1714)', () => {
    const LANDING_RAY = '8f2a1b3c4d5e6f70-SIN';
    const SPA_RAY = '0123456789abcdef-IAD';
    const SPA_RAY_2 = 'fedcba9876543210-LHR';

    type EvidenceWindow = Window & { __AECI_BROWSER_EVIDENCE__?: unknown };

    let fetchMock: ReturnType<typeof vi.fn>;

    function stubTiming(entries: { name: string; description: string }[] | undefined) {
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
        entries === undefined
          ? []
          : ([{ serverTiming: entries }] as unknown as PerformanceEntryList),
      );
    }

    function setFlag(on: boolean): void {
      if (on) (window as EvidenceWindow).__AECI_BROWSER_EVIDENCE__ = { enabled: true };
      else delete (window as EvidenceWindow).__AECI_BROWSER_EVIDENCE__;
    }

    /** The `{ cf_ray, evidence }` bodies posted so far, in order. */
    function reports(): { cf_ray: string; evidence: string }[] {
      return fetchMock.mock.calls
        .filter(([url]) => url === '/api/page-views/browser-evidence')
        .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    }

    function interact(type = 'pointerdown'): void {
      document.dispatchEvent(new Event(type));
    }

    /** Answer the SPA beacon, stamping `Server-Timing` the way the gateway does. */
    function flushBeacon(httpMock: HttpTestingController, ray: string | null): void {
      const headers: Record<string, string> = ray ? { 'Server-Timing': `cfray;desc="${ray}"` } : {};
      httpMock
        .expectOne('/api/page-views')
        .flush(null, { status: 204, statusText: 'No Content', headers });
    }

    beforeEach(() => {
      fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      vi.stubGlobal('fetch', fetchMock);
      setFlag(true);
      stubTiming([{ name: 'cfray', description: LANDING_RAY }]);
    });

    afterEach(() => {
      // Destroying the root injector drops the tracker's document listeners.
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      setFlag(false);
    });

    it('posts `ran` once for the landing view with the document ray', () => {
      const { events, tracker } = configure('browser');
      tracker.start();
      events.next(nav(1, '/products/procore'));
      expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
    });

    it('posts `interacted` once, on the first qualifying event, and never again', () => {
      const { events, tracker } = configure('browser');
      tracker.start();
      events.next(nav(1, '/products/procore'));
      interact('keydown');
      interact('pointerdown');
      interact('wheel');
      interact('touchstart');
      expect(reports()).toEqual([
        { cf_ray: LANDING_RAY, evidence: 'ran' },
        { cf_ray: LANDING_RAY, evidence: 'interacted' },
      ]);
    });

    it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])('%s counts', (type) => {
      const { events, tracker } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact(type);
      expect(reports().at(-1)).toEqual({ cf_ray: LANDING_RAY, evidence: 'interacted' });
    });

    it('ignores events that are not interactions', () => {
      const { events, tracker } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact('mousemove');
      interact('scroll');
      expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
    });

    it('re-arms on an in-app view and posts only `interacted`, with the beacon ray', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact();

      events.next(nav(2, '/products/procore'));
      flushBeacon(httpMock, SPA_RAY);
      await settle();
      interact();
      interact();

      events.next(nav(3, '/vendors/autodesk'));
      flushBeacon(httpMock, SPA_RAY_2);
      await settle();
      interact('keydown');

      expect(reports()).toEqual([
        { cf_ray: LANDING_RAY, evidence: 'ran' },
        { cf_ray: LANDING_RAY, evidence: 'interacted' },
        { cf_ray: SPA_RAY, evidence: 'interacted' },
        { cf_ray: SPA_RAY_2, evidence: 'interacted' },
      ]);
      httpMock.verify();
    });

    it('posts an interaction made before the beacon answered, once the ray arrives', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact();

      events.next(nav(2, '/products/procore'));
      interact();
      expect(reports()).toHaveLength(2);
      flushBeacon(httpMock, SPA_RAY);
      await settle();
      interact();

      expect(reports().slice(2)).toEqual([{ cf_ray: SPA_RAY, evidence: 'interacted' }]);
    });

    it('posts nothing for an in-app view whose beacon carried no ray (local dev)', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact();

      events.next(nav(2, '/products/procore'));
      flushBeacon(httpMock, null);
      await settle();
      interact();

      expect(reports()).toHaveLength(2);
    });

    it('posts nothing for an in-app view whose beacon failed', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact();

      events.next(nav(2, '/products/procore'));
      httpMock
        .expectOne('/api/page-views')
        .flush(null, { status: 500, statusText: 'Server Error' });
      await settle();
      interact();

      expect(reports()).toHaveLength(2);
    });

    it('posts nothing on untracked routes, landing or in-app', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/admin/reviews'));
      interact();
      expect(reports()).toEqual([]);

      events.next(nav(2, '/products/procore'));
      flushBeacon(httpMock, SPA_RAY);
      await settle();
      events.next(nav(3, '/account'));
      interact();
      expect(reports()).toEqual([]);
      httpMock.verify();
    });

    it('a query-only rewrite of the same route keeps the current view', async () => {
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/products'));
      events.next(nav(2, '/products?page=2'));
      httpMock.expectNone('/api/page-views');
      interact();
      expect(reports()).toEqual([
        { cf_ray: LANDING_RAY, evidence: 'ran' },
        { cf_ray: LANDING_RAY, evidence: 'interacted' },
      ]);
    });

    it.each([
      ['no tier flag', () => setFlag(false)],
      [
        'Do-Not-Track',
        () =>
          Object.defineProperty(window.navigator, 'doNotTrack', { value: '1', configurable: true }),
      ],
      [
        'Global Privacy Control',
        () =>
          Object.defineProperty(window.navigator, 'globalPrivacyControl', {
            value: true,
            configurable: true,
          }),
      ],
      [
        'a geo=eu stamp',
        () =>
          stubTiming([
            { name: 'cfray', description: LANDING_RAY },
            { name: 'geo', description: 'eu' },
          ]),
      ],
      ['no serverTiming', () => stubTiming(undefined)],
    ])('sends nothing with %s', async (_label, arrange) => {
      arrange();
      try {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        events.next(nav(1, '/products/procore'));
        interact();
        events.next(nav(2, '/vendors/autodesk'));
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        interact();
        expect(fetchMock).not.toHaveBeenCalled();
        httpMock.verify();
      } finally {
        Object.defineProperty(window.navigator, 'doNotTrack', { value: null, configurable: true });
        Object.defineProperty(window.navigator, 'globalPrivacyControl', {
          value: undefined,
          configurable: true,
        });
      }
    });

    it('sends nothing on the server', () => {
      const { events, tracker } = configure('server');
      tracker.start();
      events.next(nav(1, '/products/procore'));
      interact();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('writes nothing to localStorage, sessionStorage or cookies', async () => {
      const local = localStorage.length;
      const session = sessionStorage.length;
      const cookie = document.cookie;
      const { events, tracker, httpMock } = configure('browser');
      tracker.start();
      events.next(nav(1, '/'));
      interact();
      events.next(nav(2, '/products/procore'));
      flushBeacon(httpMock, SPA_RAY);
      await settle();
      interact();
      expect(reports()).toHaveLength(3);
      expect(localStorage.length).toBe(local);
      expect(sessionStorage.length).toBe(session);
      expect(document.cookie).toBe(cookie);
    });

    it('reads the beacon ray through the lazy Turnstile path too', async () => {
      setTurnstileConfig(true);
      stubTiming([]);
      try {
        const { events, tracker, httpMock } = configure('browser', fakeTurnstile(true, 'tok'));
        tracker.start();
        events.next(nav(1, '/'));
        // An empty timing list has no ray: no landing report.
        expect(reports()).toEqual([]);

        events.next(nav(2, '/products/procore'));
        const req = await vi.waitFor(() => httpMock.expectOne('/api/page-views'));
        expect(req.request.body).toMatchObject({ turnstile_token: 'tok' });
        req.flush(null, {
          status: 204,
          statusText: 'No Content',
          headers: { 'Server-Timing': `cfray;desc="${SPA_RAY}"` },
        });
        await settle();
        interact();
        expect(reports()).toEqual([{ cf_ray: SPA_RAY, evidence: 'interacted' }]);
      } finally {
        setTurnstileConfig(false);
      }
    });
  });
});
