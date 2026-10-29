/**
 * Fires a client-side `POST /api/page-views` on every in-app navigation after
 * the initial document load (AECI-151).
 *
 * The SSR Worker's gateway writes the arrival for the landing URL on every
 * cacheable page, on an edge-cache HIT and a MISS alike (`server-runtime.ts`
 * `recordGatewayArrival`, AECI-1297). It only sees full-document loads.
 * In-app `routerLink` navigations never reach the Worker, so before this they
 * went uncounted (a visitor who landed on `/` and clicked through five products
 * registered one page-view, not six).
 *
 * This tracker closes that gap. It skips the FIRST `NavigationEnd` — the
 * hydration of the landing page, already counted by the gateway — and posts a
 * minimal `{ route }` payload (path only) for each subsequent navigation. The
 * API resolves an arrival's entity from its path; an SPA row is attributed by
 * route alone, which is acceptable for a view counter.
 *
 * Operator-only surfaces are excluded (AECI-575 / ADMIN_PANEL_SPEC §9.6): an
 * admin SPA navigation would otherwise write a `page_views` row into the very
 * table the admin console reads and the daily digest reports on — the panel
 * measuring itself. The exclusion lives HERE, at the tracker, so nothing is sent
 * at all; the prefix list is `UNTRACKED_ROUTE_PREFIXES` in `@aeci/shared`, shared
 * with the gateway's `firePageView` and with the digest's read-side filter so
 * the three can't drift.
 *
 * AECI-743 added a last-fired-route memo: with the query string stripped, a
 * programmatic `router.navigate([], { queryParams })` produced a row identical to
 * the previous one, so a debounced URL sync wrote several views of one page. Only
 * consecutive repeats of the same route collapse. That memo is one of two nets —
 * the API also refuses a second row for the same visitor + page inside
 * `PAGE_VIEW_DEDUPE_WINDOW_MS`, which is what catches the SSR side.
 *
 * Browser-only (no-op on the server) and fire-and-forget (errors swallowed —
 * analytics must never break navigation). The endpoint returns 204 and, since
 * Phase 4 (AECI-177), inserts an enriched `page_views` row server-side; this
 * client only ever sends the lean `{ route }` payload (`packages/shared`
 * `PageViewPayload`). The browser POST is proxied through the SSR Worker, which
 * adds trusted Cloudflare request context the API Worker uses for enrichment.
 *
 * AECI-1457 adds a Turnstile verdict as classifier evidence, only in the
 * browser with a site key shipped and no DNT/GPC signal (`turnstile-config.ts`).
 * Everything else lives in the lazy `turnstile.service.ts` chunk, which the
 * tracker `import()`s only then. The initial bundle carries just that gate, and
 * a dark env never downloads the chunk:
 *
 *   - **SPA beacon.** The lazy `postSpaBeacon` awaits one invisible-widget token
 *     and sends it as `turnstile_token`. A `null` token sends the beacon without
 *     it. With no config the tracker posts at once, unchanged.
 *   - **Landing view.** It still sends no beacon. After the first NavigationEnd
 *     the lazy `postLandingVerdict` reads the gateway's `Server-Timing: cfray`
 *     entry (AECI-1330), mints a token with that ray as `cData`, and posts
 *     `{ cf_ray, token }` to `TURNSTILE_VERDICT_URL`. The API attaches the
 *     verdict to the arrival row the gateway stored under that ray. No ray or no
 *     token means nothing is sent.
 *
 * Both are fire-and-forget with errors swallowed, like the beacon itself.
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, PLATFORM_ID, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { isUntrackedRoute, type PageViewPayload } from '@aeci/shared';

import { turnstileSiteKey } from './turnstile-config';

/** The lazily imported Turnstile module (AECI-1457). */
type TurnstileModule = typeof import('./turnstile.service');

@Injectable({ providedIn: 'root' })
export class PageViewTracker {
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly injector = inject(Injector);
  /**
   * AECI-1457. Read once from the inline config, so a dark env or a DNT/GPC
   * visitor never imports the Turnstile chunk and never waits on it.
   */
  private readonly turnstileWanted = this.isBrowser && turnstileSiteKey() !== null;
  private started = false;
  /**
   * The last route this tracker actually posted (AECI-743). See `fire()` — it is
   * the memo that stops a query-string rewrite from being counted as a new view.
   * Seeded by the skipped initial navigation so the landing page, already counted
   * server-side, cannot be re-counted by the first URL sync after hydration.
   */
  private lastFiredRoute: string | null = null;

  /**
   * Begin tracking client-side navigations. Idempotent and a no-op on the
   * server. Called once from the root component at bootstrap.
   */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;

    // The first NavigationEnd after hydration corresponds to the landing URL
    // the SSR Worker already counted; skip it so we never double-count it.
    let isInitialNavigation = true;
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        if (isInitialNavigation) {
          isInitialNavigation = false;
          this.lastFiredRoute = event.urlAfterRedirects.split(/[?#]/, 1)[0] || '/';
          // AECI-1457 / AECI-1330 — attach a Turnstile verdict to the landing
          // view's arrival row (`postLandingVerdict` in the lazy module). This is
          // after the first NavigationEnd, so it never touches hydration. The
          // gateway writes no arrival for an untracked route, so it is skipped.
          if (this.turnstileWanted && !isUntrackedRoute(this.lastFiredRoute)) {
            void this.turnstile().then((m) => m?.postLandingVerdict(this.injector));
          }
          return;
        }
        this.fire(event.urlAfterRedirects);
      });
  }

  private fire(url: string): void {
    const route = url.split(/[?#]/, 1)[0] || '/';
    // §9.6 — never record the operator's own navigation. Guarding here rather
    // than in the subscription means any future caller inherits the exclusion.
    if (isUntrackedRoute(route)) return;
    // AECI-743 — a navigation that only rewrote the QUERY STRING is not a new view.
    // The line above strips `?` and `#`, so a `router.navigate([], { queryParams })`
    // produces a row byte-identical to the previous one: same route, same path, same
    // UA hash, same ASN. Those calls are everywhere and several are debounced, so a
    // single typed search query used to write a row per keystroke-batch
    // (`search-page.ts` `scheduleUrlSync`, `paginated-index-controller.ts`,
    // `facet-sidebar.ts`).
    //
    // Only CONSECUTIVE repeats collapse, so A → B → A still counts both visits to A.
    // Deliberately NOT keyed on `Navigation.extras.replaceUrl`, which looks like the
    // precise discriminator and is a trap: Angular issues Back/Forward (popstate)
    // navigations with `replaceUrl: true` as well, so that test would silently stop
    // counting every history navigation — a real view, and a worse error than the one
    // being fixed. Known trade-off: `?page=2` pagination on a listing no longer adds a
    // row. It never carried the page number anyway (this table stores no query string
    // by design, §9.7), so those rows were indistinguishable from the noise above.
    if (route === this.lastFiredRoute) return;
    this.lastFiredRoute = route;
    // `navigation: 'spa'` (AECI-585 / §7.3) — this tracker fires ONLY on in-app
    // navigation (the initial hydration is skipped above), so the flag is a fact
    // about the writer, not a guess. Without it the same-origin `Referer` on this
    // POST classifies as `Direct`, which is what made `Direct` a mixed bucket of
    // true arrivals and in-app clicks. No `path` is sent: `route` is already the
    // concrete path here, and the API falls back to it.
    const payload: PageViewPayload = { route, navigation: 'spa' };
    // No Turnstile config (dark env, DNT/GPC, server) posts at once, unchanged.
    if (!this.turnstileWanted) {
      this.post(payload);
      return;
    }
    // AECI-1457. The lazy module adds the token and posts. A failed chunk load
    // posts the payload unchanged, so the beacon always goes out.
    void this.turnstile().then((m) =>
      m ? m.postSpaBeacon(this.injector, payload) : this.post(payload),
    );
  }

  /**
   * Import the Turnstile module. Everything Turnstile does lives in that lazy
   * chunk, so the initial bundle carries only this gate. The browser's module
   * map fetches the chunk once however often this runs. Never rejects: a failed
   * chunk load resolves `null` and costs the token, never the beacon.
   */
  private turnstile(): Promise<TurnstileModule | null> {
    return import('./turnstile.service').catch(() => null);
  }

  private post(payload: PageViewPayload): void {
    // Fire-and-forget: subscribe to issue the request, swallow any error.
    this.http.post('/api/page-views', payload).subscribe({ error: () => undefined });
  }
}
