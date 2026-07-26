/**
 * Client for the landing lead-capture endpoints (AECI-275) — backs the shared
 * mailing-list signup band (`shared/mailing-list-signup`, mounted on the home
 * closing-CTA plus the directory + detail pages, AECI-327) and the home feedback
 * form. The third browser-side mutation surface in `apps/web` after the vendor
 * request forms (`requests/requests-api.ts`) and the review form
 * (`reviews/reviews-api.ts`), and it follows the same shape.
 *
 * The SSR Worker proxies `/api/*` to the private API Worker over the service
 * binding (`server-runtime.ts`'s `/api/*` passthrough), so these same-origin
 * POSTs reach the existing D1-backed handlers (`apps/api/src/routes/landing-forms.ts`
 * → `mailing_list` / `feedback`, shipped in AECI-257). POSTs are excluded from
 * the hydration transfer cache (`withHttpTransferCacheOptions({ includePostRequests:
 * false })`, `app.config.ts`) and only ever run from a user action, never during
 * render — so the cacheable `/` route stays edge-cache-neutral.
 *
 * Geo (country / city / region / …) is enriched server-side: the SSR proxy copies
 * `request.cf` onto the trusted `LANDING_CF_HEADERS` before forwarding (the browser
 * can't read `request.cf`). The island only supplies the body — `email` / feedback
 * text plus the UTM + referrer attribution it reads from the live URL (see
 * `buildAttribution`).
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  FeedbackSubmit,
  LandingSubmitResult,
  SubscribeSubmit,
  UnsubscribeResult,
} from '@aeci/shared';

/**
 * UTM + referrer attribution the island carries in the request body. Geo fields
 * are NOT included here — they are enriched from `request.cf` on the trusted
 * `LANDING_CF_HEADERS` by the SSR proxy. The shape is the nullish attribution
 * subset shared by `SubscribeSubmitSchema` (+ `referrer` on both schemas).
 */
export interface LeadAttribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer: string | null;
}

const EMPTY_ATTRIBUTION: LeadAttribution = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  referrer: null,
};

/**
 * Read campaign attribution from the live browser context at submit time:
 * `utm_*` from the current URL's query string and `referrer` from
 * `document.referrer`. Browser-only — returns all-null under SSR (no `document`),
 * which is correct because the form only POSTs from a user action in the browser.
 *
 * The `utm_*` params survive in the real URL even though `cacheKeyUrl`
 * (`server-runtime.ts`) strips them from the edge-cache key: the SSR HTML is
 * intentionally UTM-independent, and the island reads the actual URL here.
 */
export function buildAttribution(): LeadAttribution {
  if (typeof document === 'undefined' || typeof globalThis.location === 'undefined') {
    return { ...EMPTY_ATTRIBUTION };
  }
  const params = new URLSearchParams(globalThis.location.search);
  return {
    utm_source: trimToNull(params.get('utm_source')),
    utm_medium: trimToNull(params.get('utm_medium')),
    utm_campaign: trimToNull(params.get('utm_campaign')),
    referrer: trimToNull(document.referrer),
  };
}

function trimToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable({ providedIn: 'root' })
export class LandingApi {
  private readonly http = inject(HttpClient);

  /**
   * Mailing-list signup. `created: false` means the email was already on the
   * list (`ON CONFLICT DO NOTHING` no-op), which the caller surfaces as
   * "already on the list".
   */
  subscribe(input: SubscribeSubmit): Promise<LandingSubmitResult> {
    return firstValueFrom(this.http.post<LandingSubmitResult>('/api/subscribe', input));
  }

  /** Free-text product/tool feedback. Always returns `created: true`. */
  submitFeedback(input: FeedbackSubmit): Promise<LandingSubmitResult> {
    return firstValueFrom(this.http.post<LandingSubmitResult>('/api/feedback', input));
  }

  /**
   * Mailing-list opt-out by the tokenized link from the welcome email (AECI-537).
   * `ok: true` = the token matched a subscriber who is now suppressed (idempotent);
   * `ok: false` = the token matched no one (invalid/expired link).
   */
  unsubscribe(token: string): Promise<UnsubscribeResult> {
    return firstValueFrom(this.http.post<UnsubscribeResult>('/api/unsubscribe', { token }));
  }
}
