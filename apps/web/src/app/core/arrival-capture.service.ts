/**
 * The arrival beacon (AECI-1208): tell the API how a signed-in visitor arrived.
 *
 * The API records one `user_activity_daily` row per signed-in user per day, but
 * it never sees the landing URL. An SSR landing makes its API calls from the
 * resolver, and later loads replay them from TransferState. So the browser
 * reports the landing URL's `utm_source`, `utm_campaign` and `n` once, in a
 * `POST /api/activity/arrival`, and the API stores them as the day's arrival.
 *
 * Three rules keep it inside the privacy model (`docs/ANALYTICS.md`):
 *
 *   - **Browser-only, after hydration.** `start()` is a no-op on the server, and
 *     the send waits on `SessionStatus.signedIn()`, which only flips after
 *     hydration. Nothing here reads the params during SSR, so cached HTML stays
 *     visitor-neutral.
 *   - **Signed-in only.** An anonymous visitor's params are never sent anywhere.
 *     A signed-out click on a gated link keeps them through the sign-in bounce
 *     (`signInReturnPath`), so they are still on the URL when the visitor lands
 *     signed in.
 *   - **No browser storage.** No `localStorage`, no `sessionStorage`, no cookie.
 *     It sends at most once per app instance. A reload sends again, which is
 *     harmless: the server keeps the first arrival of the day.
 *
 * It reads `location.search` directly, because the app shell's `ActivatedRoute`
 * carries no query params (the same reason as `WaitlistWelcomeService`). The
 * params are read once, at `start()`, so a later in-app navigation cannot change
 * what is reported.
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';

import { arrivalFromSearch, type ArrivalParams } from '@aeci/shared';

import { SessionStatus } from '../auth/session-status';

export const ARRIVAL_BEACON_URL = '/api/activity/arrival';

@Injectable({ providedIn: 'root' })
export class ArrivalCaptureService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionStatus);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** The landing URL's arrival params, captured by `start()`. */
  private readonly arrival = signal<ArrivalParams | null>(null);

  private started = false;
  private sent = false;

  constructor() {
    effect(() => {
      const arrival = this.arrival();
      if (!arrival || this.sent || !this.session.signedIn()) return;
      this.sent = true;
      // Fire-and-forget: a failed beacon costs one arrival, never the page.
      this.http.post(ARRIVAL_BEACON_URL, arrival).subscribe({ error: () => undefined });
    });
  }

  /**
   * Capture the landing URL's arrival params. Idempotent and a no-op on the
   * server. Called once from the root component at bootstrap. `search` is a test
   * seam and defaults to the live `location.search`.
   */
  start(search: string = globalThis.location?.search ?? ''): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;
    this.arrival.set(arrivalFromSearch(search));
  }
}
