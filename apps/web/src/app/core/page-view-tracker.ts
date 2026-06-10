/**
 * Fires a client-side `POST /api/page-views` on every in-app navigation after
 * the initial document load (AECI-151).
 *
 * The SSR Worker fires a page-view for the landing URL on every cacheable
 * request (`server-runtime.ts` `firePageView`), so the metric is meant to
 * reflect "visitor arrivals" — but the Worker only sees full-document loads.
 * In-app `routerLink` navigations never reach the Worker, so before this they
 * went uncounted (a visitor who landed on `/` and clicked through five products
 * registered one page-view, not six).
 *
 * This tracker closes that gap. It skips the FIRST `NavigationEnd` — the
 * hydration of the Worker-rendered landing page, already counted server-side —
 * and posts a minimal `{ route }` payload (path only) for each subsequent
 * navigation, matching the payload the Worker synthesizes on a cache HIT. The
 * richer `{ entity_type, entity_id }` enrichment stays SSR-only (only the
 * server resolver branch knows the entity id); that mirrors the existing
 * cache-HIT behavior and is acceptable for a view counter.
 *
 * Browser-only (no-op on the server) and fire-and-forget (errors swallowed —
 * analytics must never break navigation). The endpoint returns 204 and, since
 * Phase 4 (AECI-177), inserts an enriched `page_views` row server-side; this
 * client only ever sends the lean `{ route }` payload (`packages/shared`
 * `PageViewPayload`). The browser POST is proxied through the SSR Worker, which
 * adds trusted Cloudflare request context the API Worker uses for enrichment.
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import type { PageViewPayload } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class PageViewTracker {
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;

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
          return;
        }
        this.fire(event.urlAfterRedirects);
      });
  }

  private fire(url: string): void {
    const route = url.split(/[?#]/, 1)[0] || '/';
    const payload: PageViewPayload = { route };
    // Fire-and-forget: subscribe to issue the request, swallow any error.
    this.http.post('/api/page-views', payload).subscribe({ error: () => undefined });
  }
}
