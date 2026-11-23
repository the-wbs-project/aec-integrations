/**
 * Tests for `PageViewTracker` (AECI-151). Named `.component.spec.ts` so it runs
 * under `ng test` — needs Angular DI (`HttpClient`, `Router`, `PLATFORM_ID`).
 *
 * The `Router` is stubbed with a `Subject` we drive directly so navigations can
 * be emitted synchronously without booting the real router.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Event, NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEW_TAB_ANSWER_WAIT_MS,
  NEW_TAB_CHANNEL_NAME,
  NEW_TAB_INPUT_EVENTS,
  NEW_TAB_MENU_WINDOW_MS,
  NEW_TAB_OPEN_LIMIT,
  NEW_TAB_OPEN_WINDOW_MS,
  linkAddress,
  recordNewTabOpen,
} from './new-tab-evidence';
import { NAVIGATION_INPUT_EVENTS, PageViewTracker } from './page-view-tracker';
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

    describe('a beacon that answers after the next navigation (AECI-1714 review)', () => {
      /** Answer one pending SPA beacon, stamped as the gateway stamps it. */
      function answer(req: TestRequest, ray: string | null): void {
        const headers: Record<string, string> = ray
          ? { 'Server-Timing': `cfray;desc="${ray}"` }
          : {};
        req.flush(null, { status: 204, statusText: 'No Content', headers });
      }

      it('still posts the interaction view A saw, and B arms and posts on its own ray', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        events.next(nav(1, '/'));
        events.next(nav(2, '/products/procore'));
        interact();
        events.next(nav(3, '/vendors/autodesk'));
        const [a, b] = httpMock.match('/api/page-views');

        answer(a!, SPA_RAY);
        await settle();
        expect(reports().slice(1)).toEqual([{ cf_ray: SPA_RAY, evidence: 'interacted' }]);

        interact();
        answer(b!, SPA_RAY_2);
        await settle();
        interact();

        expect(reports()).toEqual([
          { cf_ray: LANDING_RAY, evidence: 'ran' },
          { cf_ray: SPA_RAY, evidence: 'interacted' },
          { cf_ray: SPA_RAY_2, evidence: 'interacted' },
        ]);
        httpMock.verify();
      });

      it('posts nothing for an untouched view A when its ray lands late', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        events.next(nav(1, '/'));
        events.next(nav(2, '/products/procore'));
        events.next(nav(3, '/vendors/autodesk'));
        const [a, b] = httpMock.match('/api/page-views');

        answer(a!, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);

        answer(b!, SPA_RAY_2);
        await settle();
        interact();
        expect(reports().slice(1)).toEqual([{ cf_ray: SPA_RAY_2, evidence: 'interacted' }]);
      });

      it("posts nothing when A's late beacon has no ray, and leaves B armed", async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        events.next(nav(1, '/'));
        events.next(nav(2, '/products/procore'));
        interact();
        events.next(nav(3, '/vendors/autodesk'));
        const [a, b] = httpMock.match('/api/page-views');

        answer(a!, null);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);

        interact();
        answer(b!, SPA_RAY_2);
        await settle();
        expect(reports().slice(1)).toEqual([{ cf_ray: SPA_RAY_2, evidence: 'interacted' }]);
      });
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

    // AECI-1987, ruling 2026-11-20: carry the click forward. The click, tap or key
    // press that starts an in-app navigation counts for the view it opens.
    describe('the input that opens an in-app view (AECI-1987)', () => {
      let addSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        addSpy = vi.spyOn(window, 'addEventListener');
      });

      /** The tracker's navigation-input listener for `type`, if it registered one. */
      function inputListener(type: string): ((e: globalThis.Event) => void) | undefined {
        const call = addSpy.mock.calls
          .filter(
            ([t, , options]: unknown[]) =>
              t === type && (options as AddEventListenerOptions | undefined)?.capture === true,
          )
          .at(-1);
        return call?.[1] as ((e: globalThis.Event) => void) | undefined;
      }

      /**
       * A trusted visitor input. jsdom cannot dispatch a trusted event (`isTrusted` is
       * unforgeable), so the listener is called with one directly, as the browser would.
       */
      function visitorInput(type: (typeof NAVIGATION_INPUT_EVENTS)[number] = 'click'): void {
        const listener = inputListener(type);
        expect(listener).toBeDefined();
        listener!({ type, isTrusted: true } as unknown as globalThis.Event);
      }

      /** One router navigation: its start, then its end. */
      function navigate(
        events: Subject<Event>,
        id: number,
        url: string,
        trigger: 'imperative' | 'popstate' = 'imperative',
      ): void {
        events.next(new NavigationStart(id, url, trigger));
        events.next(nav(id, url));
      }

      /** Answer one pending SPA beacon with `ray` in `Server-Timing`. */
      function answer(req: TestRequest, ray: string): void {
        req.flush(null, {
          status: 204,
          statusText: 'No Content',
          headers: { 'Server-Timing': `cfray;desc="${ray}"` },
        });
      }

      it.each(NAVIGATION_INPUT_EVENTS)(
        'a %s that opens the view posts `interacted` with no second touch',
        async (type) => {
          const { events, tracker, httpMock } = configure('browser');
          tracker.start();
          navigate(events, 1, '/');

          visitorInput(type);
          navigate(events, 2, '/products/procore');
          // The ray is not known yet, so nothing is posted for the new view.
          expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
          flushBeacon(httpMock, SPA_RAY);
          await settle();

          expect(reports()).toEqual([
            { cf_ray: LANDING_RAY, evidence: 'ran' },
            { cf_ray: SPA_RAY, evidence: 'interacted' },
          ]);
          // One word per view: a later touch posts nothing more.
          interact();
          expect(reports()).toHaveLength(2);
          httpMock.verify();
        },
      );

      it('marks a key-opened view (Enter in a search box)', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('keydown');
        navigate(events, 2, '/search?q=revit');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports().slice(1)).toEqual([{ cf_ray: SPA_RAY, evidence: 'interacted' }]);
      });

      it('does not mark a navigation with no visitor input', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        navigate(events, 2, '/products/procore');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('does not mark a navigation that starts in a later task, such as a timer', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('click');
        await settle();
        navigate(events, 2, '/products/procore');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('does not mark the view a later navigation opens in place of the clicked one', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('click');
        events.next(new NavigationStart(2, '/products/procore'));
        await settle();
        // An async redirect: a new navigation id, started in a later task.
        navigate(events, 3, '/vendors/autodesk');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('does not mark a Back or Forward navigation', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('keydown');
        navigate(events, 2, '/products/procore', 'popstate');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('does not count an untrusted click, such as a script calling element.click()', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        document.dispatchEvent(new MouseEvent('click'));
        navigate(events, 2, '/products/procore');
        flushBeacon(httpMock, SPA_RAY);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('never marks the landing view', () => {
        const { events, tracker } = configure('browser');
        tracker.start();
        visitorInput('click');
        navigate(events, 1, '/products/procore');
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('posts nothing for a carried click when the beacon carries no ray', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('click');
        navigate(events, 2, '/products/procore');
        flushBeacon(httpMock, null);
        await settle();
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it('posts nothing for a carried click into an untracked route', async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('click');
        navigate(events, 2, '/account');
        await settle();
        httpMock.expectNone('/api/page-views');
        expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
      });

      it("keeps a carried click when the view's beacon answers after the next navigation", async () => {
        const { events, tracker, httpMock } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        visitorInput('click');
        navigate(events, 2, '/products/procore');
        await settle();
        // B opens with no input before A's beacon answers.
        navigate(events, 3, '/vendors/autodesk');
        const [a, b] = httpMock.match('/api/page-views');
        answer(a!, SPA_RAY);
        await settle();
        expect(reports().slice(1)).toEqual([{ cf_ray: SPA_RAY, evidence: 'interacted' }]);

        // B was not opened by an input, and its own listeners still work.
        answer(b!, SPA_RAY_2);
        await settle();
        expect(reports()).toHaveLength(2);
        interact();
        expect(reports().slice(1)).toEqual([
          { cf_ray: SPA_RAY, evidence: 'interacted' },
          { cf_ray: SPA_RAY_2, evidence: 'interacted' },
        ]);
        httpMock.verify();
      });

      it.each([
        ['no tier flag', () => setFlag(false)],
        [
          'Do-Not-Track',
          () =>
            Object.defineProperty(window.navigator, 'doNotTrack', {
              value: '1',
              configurable: true,
            }),
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
      ])('a carried click sends nothing with %s', async (_label, arrange) => {
        arrange();
        try {
          const { events, tracker, httpMock } = configure('browser');
          tracker.start();
          navigate(events, 1, '/');
          // The gates are read once: no input listener is ever registered.
          for (const type of NAVIGATION_INPUT_EVENTS) expect(inputListener(type)).toBeUndefined();
          document.dispatchEvent(new MouseEvent('click'));
          navigate(events, 2, '/products/procore');
          flushBeacon(httpMock, SPA_RAY);
          await settle();
          interact();
          expect(fetchMock).not.toHaveBeenCalled();
          httpMock.verify();
        } finally {
          Object.defineProperty(window.navigator, 'doNotTrack', {
            value: null,
            configurable: true,
          });
          Object.defineProperty(window.navigator, 'globalPrivacyControl', {
            value: undefined,
            configurable: true,
          });
        }
      });

      it('registers no input listener on the server', () => {
        const { events, tracker } = configure('server');
        tracker.start();
        navigate(events, 1, '/');
        for (const type of NAVIGATION_INPUT_EVENTS) expect(inputListener(type)).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('removes its input listeners when the injector is destroyed', () => {
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const { events, tracker } = configure('browser');
        tracker.start();
        navigate(events, 1, '/');
        const listener = inputListener('click');
        expect(listener).toBeDefined();
        TestBed.resetTestingModule();
        expect(removeSpy).toHaveBeenCalledWith('click', listener, { capture: true });
      });
    });

    // AECI-1988, ruling 2026-11-20: a link the visitor opens in a new tab counts. The
    // opening tab remembers the address of a trusted new-tab input. The new tab's landing
    // view asks over a BroadcastChannel and marks itself touched on a yes.
    describe('a link opened in a new tab (AECI-1988)', () => {
      /**
       * An in-memory BroadcastChannel. Delivery is async, like the browser's, and never
       * reaches the sender. `peer()` is the other tab, driven by the test.
       */
      class FakeChannel {
        static all: FakeChannel[] = [];
        onmessage: ((event: MessageEvent) => void) | null = null;
        closed = false;
        readonly sent: unknown[] = [];
        constructor(readonly name: string) {
          FakeChannel.all.push(this);
        }
        postMessage(data: unknown): void {
          if (this.closed) throw new Error('closed');
          this.sent.push(data);
          for (const other of FakeChannel.all) {
            if (other === this || other.closed || other.name !== this.name) continue;
            queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
          }
        }
        close(): void {
          this.closed = true;
          FakeChannel.all = FakeChannel.all.filter((c) => c !== this);
        }
      }

      let addSpy: ReturnType<typeof vi.spyOn>;
      let now: number;
      let link: HTMLAnchorElement;

      beforeEach(() => {
        FakeChannel.all = [];
        vi.stubGlobal('BroadcastChannel', FakeChannel);
        addSpy = vi.spyOn(window, 'addEventListener');
        now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        link = document.createElement('a');
        link.href = '/products/procore';
        document.body.appendChild(link);
      });

      afterEach(() => {
        link.remove();
      });

      /** The tracker's own channel, or undefined when it opened none. */
      const trackerChannel = (peer?: FakeChannel) =>
        FakeChannel.all.find((c) => c !== peer && c.name === NEW_TAB_CHANNEL_NAME);

      /** The other tab: a raw channel that records what it hears. */
      function peer(): { channel: FakeChannel; heard: unknown[] } {
        const channel = new FakeChannel(NEW_TAB_CHANNEL_NAME);
        const heard: unknown[] = [];
        channel.onmessage = (e) => heard.push(e.data);
        return { channel, heard };
      }

      /**
       * The tracker's new-tab listener for `type`. It registers before the AECI-1987
       * input listener, so for `click` it is the first capture listener, not the last.
       */
      function newTabListener(type: string): ((e: globalThis.Event) => void) | undefined {
        const call = addSpy.mock.calls.find(
          ([t, , options]: unknown[]) =>
            t === type && (options as AddEventListenerOptions | undefined)?.capture === true,
        );
        return call?.[1] as ((e: globalThis.Event) => void) | undefined;
      }

      /** A visitor input as the browser would deliver it. jsdom cannot make one trusted. */
      function input(
        type: (typeof NEW_TAB_INPUT_EVENTS)[number],
        init: Partial<MouseEvent> & { isTrusted?: boolean } = {},
        target: EventTarget = link,
      ): void {
        const listener = newTabListener(type);
        expect(listener).toBeDefined();
        listener!({
          type,
          isTrusted: true,
          button: 0,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          target,
          ...init,
        } as unknown as globalThis.Event);
      }

      /** The landing document, loaded by a plain navigation to `path`. */
      function landingEntry(path: string, type = 'navigate'): void {
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
          {
            type,
            name: location.origin + path,
            serverTiming: [{ name: 'cfray', description: LANDING_RAY }],
          },
        ] as unknown as PerformanceEntryList);
      }

      const ask = (other: FakeChannel, address: string, tag = 'q1') =>
        other.postMessage({ kind: 'ask', tag, address });

      describe('the opening tab', () => {
        function startOpener() {
          const { events, tracker } = configure('browser');
          tracker.start();
          events.next(nav(1, '/'));
          return tracker;
        }

        it.each([
          ['a Ctrl-click', 'click', { ctrlKey: true }],
          ['a Cmd-click', 'click', { metaKey: true }],
          ['a Shift-click', 'click', { shiftKey: true }],
          ['a middle click', 'auxclick', { button: 1 }],
          ['a context menu', 'contextmenu', { button: 2 }],
        ] as const)('answers yes once for %s on our link', async (_label, type, init) => {
          startOpener();
          input(type, init);
          const other = peer();
          ask(other.channel, '/products/procore');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'q1' }]);

          // The answer used the record up: a second tab of the same address gets nothing.
          ask(other.channel, '/products/procore', 'q2');
          await settle();
          expect(other.heard).toHaveLength(1);
        });

        it('answers for a plain click on a link with target="_blank"', async () => {
          link.target = '_blank';
          startOpener();
          input('click');
          const other = peer();
          ask(other.channel, '/products/procore');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'q1' }]);
        });

        it('answers each of two opens of one address once', async () => {
          startOpener();
          input('auxclick', { button: 1 });
          now += 2_000;
          input('auxclick', { button: 1 });
          const other = peer();
          ask(other.channel, '/products/procore', 'a');
          ask(other.channel, '/products/procore', 'b');
          ask(other.channel, '/products/procore', 'c');
          await settle();
          expect(other.heard).toEqual([
            { kind: 'yes', tag: 'a' },
            { kind: 'yes', tag: 'b' },
          ]);
        });

        it('counts a middle auxclick and a middle click from one press as one open', async () => {
          startOpener();
          input('auxclick', { button: 1 });
          input('click', { button: 1 });
          const other = peer();
          ask(other.channel, '/products/procore', 'a');
          ask(other.channel, '/products/procore', 'b');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'a' }]);
        });

        it('matches on path and query, ignoring the fragment and a trailing slash', async () => {
          link.href = '/search/?q=revit#results';
          startOpener();
          input('click', { ctrlKey: true });
          const other = peer();
          ask(other.channel, '/search?q=other', 'wrong-query');
          ask(other.channel, '/search?q=revit', 'right');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'right' }]);
        });

        it('says nothing for a wrong address', async () => {
          startOpener();
          input('click', { ctrlKey: true });
          const other = peer();
          ask(other.channel, '/vendors/autodesk');
          await settle();
          expect(other.heard).toEqual([]);
        });

        it('says nothing once the click is stale', async () => {
          startOpener();
          input('click', { ctrlKey: true });
          now += NEW_TAB_OPEN_WINDOW_MS + 1;
          const other = peer();
          ask(other.channel, '/products/procore');
          await settle();
          expect(other.heard).toEqual([]);
        });

        it('gives a context menu the longer window, and no longer', async () => {
          startOpener();
          input('contextmenu', { button: 2 });
          now += NEW_TAB_OPEN_WINDOW_MS + 1;
          const other = peer();
          ask(other.channel, '/products/procore', 'inside');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'inside' }]);

          input('contextmenu', { button: 2 });
          now += NEW_TAB_MENU_WINDOW_MS + 1;
          ask(other.channel, '/products/procore', 'outside');
          await settle();
          expect(other.heard).toHaveLength(1);
        });

        it('records nothing for an untrusted input', async () => {
          startOpener();
          input('click', { ctrlKey: true, isTrusted: false });
          input('auxclick', { button: 1, isTrusted: false });
          input('contextmenu', { isTrusted: false });
          expect(trackerChannel()).toBeUndefined();
          const other = peer();
          ask(other.channel, '/products/procore');
          await settle();
          expect(other.heard).toEqual([]);
        });

        it('records nothing for a same-tab click, a right button, a download or a non-link', async () => {
          startOpener();
          input('click');
          input('auxclick', { button: 2 });
          const download = document.createElement('a');
          download.href = '/products/procore';
          download.setAttribute('download', '');
          input('click', { ctrlKey: true }, download);
          input('click', { ctrlKey: true }, document.body);
          expect(trackerChannel()).toBeUndefined();
        });

        it('records nothing for another origin or an untracked route', () => {
          startOpener();
          link.href = 'https://example.com/products/procore';
          input('click', { ctrlKey: true });
          link.href = '/admin/reviews';
          input('click', { ctrlKey: true });
          expect(trackerChannel()).toBeUndefined();
        });

        it(`keeps at most ${NEW_TAB_OPEN_LIMIT} links, dropping the oldest`, async () => {
          startOpener();
          for (let i = 0; i <= NEW_TAB_OPEN_LIMIT; i += 1) {
            link.href = `/products/p${i}`;
            input('click', { ctrlKey: true });
          }
          const other = peer();
          ask(other.channel, '/products/p0', 'oldest');
          ask(other.channel, `/products/p${NEW_TAB_OPEN_LIMIT}`, 'newest');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'newest' }]);
        });

        it('records a row open made by our own code from a trusted click', async () => {
          startOpener();
          recordNewTabOpen({ isTrusted: false } as globalThis.Event, '/vendors/autodesk');
          expect(trackerChannel()).toBeUndefined();
          recordNewTabOpen({ isTrusted: true } as globalThis.Event, '/vendors/autodesk');
          const other = peer();
          ask(other.channel, '/vendors/autodesk');
          await settle();
          expect(other.heard).toEqual([{ kind: 'yes', tag: 'q1' }]);
        });

        it('opens its channel only while a record is live, and closes it after', () => {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            startOpener();
            expect(trackerChannel()).toBeUndefined();
            input('click', { ctrlKey: true });
            expect(trackerChannel()).toBeDefined();
            now += NEW_TAB_OPEN_WINDOW_MS + 2;
            vi.advanceTimersByTime(NEW_TAB_OPEN_WINDOW_MS + 2);
            expect(trackerChannel()).toBeUndefined();
          } finally {
            vi.useRealTimers();
          }
        });

        it('stops answering and closes the channel when the injector is destroyed', async () => {
          startOpener();
          input('click', { ctrlKey: true });
          const own = trackerChannel()!;
          TestBed.resetTestingModule();
          expect(own.closed).toBe(true);
          recordNewTabOpen({ isTrusted: true } as globalThis.Event, '/vendors/autodesk');
          expect(trackerChannel()).toBeUndefined();
        });
      });

      describe('the new tab', () => {
        function startNewTab(path = '/products/procore') {
          const { events, tracker } = configure('browser');
          tracker.start();
          events.next(nav(1, path));
          return tracker;
        }

        it('asks with its own address and posts `interacted` on a yes', async () => {
          landingEntry('/products/procore?tab=integrations');
          const other = peer();
          other.channel.onmessage = (e) => {
            other.heard.push(e.data);
            const q = e.data as { tag: string };
            other.channel.postMessage({ kind: 'yes', tag: q.tag });
          };
          startNewTab('/products/procore?tab=integrations');
          await settle();
          expect(other.heard).toEqual([
            {
              kind: 'ask',
              tag: expect.any(String),
              address: '/products/procore?tab=integrations',
            },
          ]);
          expect(reports()).toEqual([
            { cf_ray: LANDING_RAY, evidence: 'ran' },
            { cf_ray: LANDING_RAY, evidence: 'interacted' },
          ]);
          // One word per view: a touch after the yes posts nothing more.
          interact();
          expect(reports()).toHaveLength(2);
        });

        it('stays `ran` when no tab answers, and closes its channel after the wait', async () => {
          landingEntry('/products/procore');
          const other = peer();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            startNewTab();
            expect(trackerChannel(other.channel)).toBeDefined();
            now += NEW_TAB_ANSWER_WAIT_MS + 2;
            vi.advanceTimersByTime(NEW_TAB_ANSWER_WAIT_MS + 2);
            expect(trackerChannel(other.channel)).toBeUndefined();
          } finally {
            vi.useRealTimers();
          }
          await settle();
          expect(other.heard).toHaveLength(1);
          expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
        });

        it('ignores a yes to another tab’s question and a malformed message', async () => {
          landingEntry('/products/procore');
          const other = peer();
          startNewTab();
          await settle();
          other.channel.postMessage({ kind: 'yes', tag: 'not-mine' });
          other.channel.postMessage({ kind: 'yes' });
          other.channel.postMessage('yes');
          other.channel.postMessage(null);
          await settle();
          expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
        });

        it('takes one yes only, even when two tabs answer', async () => {
          landingEntry('/products/procore');
          const a = peer();
          const b = peer();
          // Each answers only a question, never the other's answer.
          const yes = (p: ReturnType<typeof peer>) => (e: MessageEvent) => {
            const data = e.data as { kind: string; tag: string };
            if (data.kind === 'ask') p.channel.postMessage({ kind: 'yes', tag: data.tag });
          };
          a.channel.onmessage = yes(a);
          b.channel.onmessage = yes(b);
          startNewTab();
          await settle();
          await settle();
          expect(reports().filter((r) => r.evidence === 'interacted')).toHaveLength(1);
        });

        it.each(['reload', 'back_forward'])('does not ask after a %s', async (type) => {
          landingEntry('/products/procore', type);
          const other = peer();
          startNewTab();
          await settle();
          expect(other.heard).toEqual([]);
          expect(trackerChannel(other.channel)).toBeUndefined();
        });

        it('does not ask from an untracked route, which has no row', async () => {
          landingEntry('/account');
          const other = peer();
          startNewTab('/account');
          await settle();
          expect(other.heard).toEqual([]);
        });

        it('never reads the referrer: a same-origin referrer with no answer stays `ran`', async () => {
          landingEntry('/products/procore');
          Object.defineProperty(document, 'referrer', {
            value: location.origin + '/products',
            configurable: true,
          });
          try {
            startNewTab();
            await settle();
            expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
          } finally {
            Object.defineProperty(document, 'referrer', { value: '', configurable: true });
          }
        });

        it('does nothing in a browser with no BroadcastChannel', async () => {
          vi.stubGlobal('BroadcastChannel', undefined);
          landingEntry('/products/procore');
          startNewTab();
          await settle();
          expect(reports()).toEqual([{ cf_ray: LANDING_RAY, evidence: 'ran' }]);
        });
      });

      describe('the gates hold in both roles', () => {
        it.each([
          ['no tier flag', () => setFlag(false)],
          [
            'Do-Not-Track',
            () =>
              Object.defineProperty(window.navigator, 'doNotTrack', {
                value: '1',
                configurable: true,
              }),
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
              vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
                {
                  type: 'navigate',
                  name: location.origin + '/products/procore',
                  serverTiming: [
                    { name: 'cfray', description: LANDING_RAY },
                    { name: 'geo', description: 'eu' },
                  ],
                },
              ] as unknown as PerformanceEntryList),
          ],
        ])('with %s it neither asks nor answers', async (_label, arrange) => {
          landingEntry('/products/procore');
          arrange();
          try {
            const other = peer();
            other.channel.onmessage = (e) => {
              other.heard.push(e.data);
              other.channel.postMessage({ kind: 'yes', tag: (e.data as { tag: string }).tag });
            };
            const { events, tracker } = configure('browser');
            tracker.start();
            events.next(nav(1, '/products/procore'));
            for (const type of NEW_TAB_INPUT_EVENTS) expect(newTabListener(type)).toBeUndefined();
            recordNewTabOpen({ isTrusted: true } as globalThis.Event, '/products/procore');
            ask(other.channel, '/products/procore');
            await settle();
            expect(other.heard).toEqual([]);
            expect(trackerChannel(other.channel)).toBeUndefined();
            expect(fetchMock).not.toHaveBeenCalled();
          } finally {
            Object.defineProperty(window.navigator, 'doNotTrack', {
              value: null,
              configurable: true,
            });
            Object.defineProperty(window.navigator, 'globalPrivacyControl', {
              value: undefined,
              configurable: true,
            });
          }
        });

        it('on the server it neither asks nor answers', async () => {
          landingEntry('/products/procore');
          const other = peer();
          const { events, tracker } = configure('server');
          tracker.start();
          events.next(nav(1, '/products/procore'));
          for (const type of NEW_TAB_INPUT_EVENTS) expect(newTabListener(type)).toBeUndefined();
          ask(other.channel, '/products/procore');
          await settle();
          expect(other.heard).toEqual([]);
          expect(trackerChannel(other.channel)).toBeUndefined();
        });
      });

      it('linkAddress keeps path and query, and refuses another origin', () => {
        const origin = 'https://www.aecintegrations.com';
        expect(linkAddress('/products/procore/#x', origin)).toBe('/products/procore');
        expect(linkAddress('/?q=1', origin)).toBe('/?q=1');
        expect(linkAddress('https://www.aecintegrations.com/a?b=c', origin)).toBe('/a?b=c');
        expect(linkAddress('https://aecintegrations.com/a', origin)).toBeNull();
        expect(linkAddress('http://[', origin)).toBeNull();
      });
    });
  });
});
