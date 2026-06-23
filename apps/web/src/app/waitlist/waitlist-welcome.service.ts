/**
 * Waitlist welcome state (AECI-243 / Phase 7.9, §11.2).
 *
 * Owns the two browser-only concerns of the welcome banner so the component
 * stays presentational:
 *   1. **Dismissal** — persisted in `localStorage` (NOT a cookie) so it never
 *      reaches the SSR Worker and can't poison the URL-keyed edge cache (§9.1a),
 *      mirroring `ConsentService`.
 *   2. **Attribution** — a one-time `POST /api/page-views` carrying the campaign
 *      `ref_source` / `ref_token`, reusing the AECI-177 capture (the SSR landing
 *      fire and the client `PageViewTracker` both strip the query string, so the
 *      token can only be logged by a dedicated client POST). A `localStorage`
 *      guard keyed by the token value dedupes refreshes while still logging a
 *      *different* token (a second invite link).
 *
 * Everything here is a no-op on the server and degrades gracefully when storage
 * is unavailable (private mode / quota).
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';

import type { PageViewPayload } from '@aeci/shared';

/** Campaign source value sent for waitlist launch-email arrivals. */
export const WAITLIST_REF_SOURCE = 'waitlist';

/** localStorage key recording that the banner was dismissed. */
export const WAITLIST_DISMISSED_KEY = 'aeci_waitlist_welcome_dismissed';

/** localStorage key holding the last attribution token already logged. */
export const WAITLIST_LOGGED_TOKEN_KEY = 'aeci_waitlist_attribution_token';

@Injectable({ providedIn: 'root' })
export class WaitlistWelcomeService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly http = inject(HttpClient);

  /** True once the visitor has dismissed the banner. False on the server or when
   *  storage is unavailable, so the banner can still show. */
  isDismissed(): boolean {
    if (!this.isBrowser) return false;
    try {
      return globalThis.localStorage?.getItem(WAITLIST_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Persist the dismissal so the banner stays hidden on later visits. */
  dismiss(): void {
    if (!this.isBrowser) return;
    try {
      globalThis.localStorage?.setItem(WAITLIST_DISMISSED_KEY, '1');
    } catch {
      // Storage unavailable — the component's signal still hides it this session.
    }
  }

  /**
   * Log campaign attribution for this arrival, exactly once per token. Browser-
   * only and fire-and-forget (analytics must never break the page). The dedupe
   * guard is written *before* the request is issued so a fast double-invoke
   * (e.g. dev double-render) can't race two POSTs through.
   */
  logAttribution(token: string | null | undefined): void {
    if (!this.isBrowser || !token) return;

    let alreadyLogged = false;
    try {
      alreadyLogged = globalThis.localStorage?.getItem(WAITLIST_LOGGED_TOKEN_KEY) === token;
      if (!alreadyLogged) globalThis.localStorage?.setItem(WAITLIST_LOGGED_TOKEN_KEY, token);
    } catch {
      // Storage unavailable — fall through and still POST (we just can't dedupe
      // across reloads). The in-session signal isn't involved here.
    }
    if (alreadyLogged) return;

    const payload: PageViewPayload = {
      route: '/',
      ref_source: WAITLIST_REF_SOURCE,
      ref_token: token,
    };
    this.http.post('/api/page-views', payload).subscribe({ error: () => undefined });
  }
}
