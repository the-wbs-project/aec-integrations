/**
 * The bridge from "there is a Supabase session" to `Analytics.identify()`
 * (AECI-649 / §AW8; contract: `docs/ANALYTICS.md` §8).
 *
 * ## Why this is its own service, and not a line in `SessionStatus`
 *
 * `SessionStatus` is the header's cache-neutral auth probe and already resolves
 * a session post-hydration, so it looks like the obvious host. It is not:
 *
 *   - It answers a **boolean** ("paint the account menu or the sign-in link"),
 *     and it must keep answering that even when analytics is unconfigured. The
 *     identity link needs the user **id**, which is a different question.
 *   - Injecting `Analytics` there would pull the whole analytics graph —
 *     `Router` included — into the auth layer's injector, which several specs
 *     construct without a router. Auth should not acquire an analytics
 *     dependency to satisfy an analytics feature.
 *
 * So the wiring lives here, next to the thing it feeds, and is started from
 * `providePostHog()` beside the `Analytics` boot itself.
 *
 * ## Cost
 *
 * One extra `getSession()` per page load for a signed-in visitor. That is a
 * local read of the cookie-derived session, not a network round-trip, and the
 * `@supabase/ssr` client is memoized inside `AuthService`, so nothing new is
 * downloaded — for an ANONYMOUS visitor the cookie fast-path in
 * `AuthService.currentUserId()` returns before the SDK is imported at all
 * (AECI-221), which is the case that guards the detail-page JS budget.
 *
 * ## Consent
 *
 * Deliberately absent from this file. Resolving the id is a purely local read
 * that sends nothing; whether it may ever be *written* to PostHog is
 * `Analytics`'s decision and belongs in exactly one place (the identity effect
 * there). Duplicating the consent check here would be a second gate to keep in
 * sync — and the ordering problem needs the value to already be recorded when
 * consent lands, so gating the resolve would break the sign-in-then-consent
 * direction outright.
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, afterNextRender, inject } from '@angular/core';

import { AuthService } from '../auth/auth.service';
import { Analytics } from './analytics';

@Injectable({ providedIn: 'root' })
export class AnalyticsIdentity {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(Analytics);

  constructor() {
    // Browser-only, and after the first render: SSR has no session SDK, and a
    // session read during SSR would be visitor state on a cacheable route
    // (§9.1a). Mirrors `SessionStatus`.
    if (!this.isBrowser) return;
    afterNextRender(() => void this.resolve());
  }

  private async resolve(): Promise<void> {
    try {
      const userId = await this.auth.currentUserId();
      if (userId) this.analytics.identify(userId);
    } catch {
      // A failed session probe means "we don't know who this is", which is the
      // same as anonymous. Analytics MUST NOT break the app.
    }
  }
}
