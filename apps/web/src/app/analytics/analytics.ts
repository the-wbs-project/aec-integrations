/**
 * Client-side analytics (AECI-239 / §14.1, reworked for the two-mode consent
 * init in AECI-643 / `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, decision D2) — the
 * typed PostHog event API the app calls, plus the boot of the SDK.
 *
 * Shape (mirrors `datadog.provider.ts` + the `search-rum.ts` seam):
 *   - The SDK is reached only through the injectable `POSTHOG_CLIENT_FACTORY`
 *     (default = the real dynamic-`import('posthog-js')`); tests swap a fake so
 *     event payloads are asserted without loading the SDK.
 *   - Every custom event is gated on `'granted'` and merges the `locale`+`theme`
 *     dimensions (§14.1). Pageviews get the same dimensions via the
 *     super-properties the factory registers in PostHog's `loaded` callback.
 *   - Fire-and-forget: `capture` never awaits in a way that can throw into the
 *     caller — analytics MUST NOT break navigation or a form submit.
 *
 * ## Two tiers (§3.3)
 *
 * **Tier 2 — operational, every visitor.** The client boots at app bootstrap
 * for EVERYONE, DNT/GPC browsers included, with memory-only persistence and no
 * identifier. It carries errors, web vitals, and the `app_started` liveness
 * beacon. This is the PostHog counterpart of the consent-independent Datadog
 * RUM that stays live through the dual-run window (§AW-final retires RUM, not
 * this).
 *
 * **Tier 3 — product analytics, banner-gated.** On `consent.state() ===
 * 'granted'` the SAME client is upgraded in place (`upgrade()`): persistence
 * moves to localStorage, `$pageview` starts, and the 8-event catalog unlocks.
 * Decline, DNT and GPC all stay at Tier 2 — see `consent.ts`.
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { analyticsDimensions } from './analytics-dimensions';
import { ConsentService } from './consent';
import {
  POSTHOG_CLIENT_FACTORY,
  TIER_3_PRODUCT_ANALYTICS_CONFIG,
  type PostHogClient,
} from './posthog-client';

/** Where a `product_viewed` was reached from (§14.1). */
export type ProductViewSource = 'search' | 'browse' | 'direct';

/** Catalog index/listing surfaces — arriving from one means `source: 'browse'`. */
const BROWSE_ROOTS = new Set(['products', 'vendors', 'integrations', 'categories']);

/**
 * The Tier 2 liveness beacon (§3.3). Fired once per page load for every
 * visitor, so "did the browser plane reach PostHog at all?" is answerable
 * without waiting for an organic error. The Datadog RUM twin
 * (`aeci.app_started`, `datadog.provider.ts`) stays live through the dual-run.
 */
export const APP_STARTED_EVENT = 'app_started';

@Injectable({ providedIn: 'root' })
export class Analytics {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly consent = inject(ConsentService);
  private readonly factory = inject(POSTHOG_CLIENT_FACTORY);
  private readonly router = inject(Router);

  /** Memoized client boot — runs at most once, in the browser, for all visitors. */
  private bootPromise: Promise<PostHogClient | null> | null = null;

  /** Guards `upgrade()` — the consent effect can re-run; the upgrade must not. */
  private upgraded = false;

  /** The route the visitor was on BEFORE the current one — drives `source`. */
  private previousUrl: string | null = null;
  private currentUrl: string | null = null;

  constructor() {
    if (!this.isBrowser) return;

    // Track the previous in-app route so `productViewed` can classify its
    // source. NavigationEnd lands before the detail component's afterNextRender,
    // so `previousUrl` already reflects the prior route when the event fires.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.previousUrl = this.currentUrl;
        this.currentUrl = e.urlAfterRedirects;
      });

    // Tier 2 (§3.3): boot immediately, unconditionally, for every visitor —
    // no consent check, no DNT check. This is the operational slice.
    void this.boot()
      .then((client) => client?.capture(APP_STARTED_EVENT, { ...analyticsDimensions() }))
      .catch(() => undefined);

    // Tier 3 (§3.3): upgrade the SAME client the moment consent is granted (or
    // immediately, for a returning visitor whose decision is already stored).
    effect(() => {
      if (this.consent.state() === 'granted') void this.upgrade();
    });
  }

  // ─── Custom events (§14.1) ─────────────────────────────────────────────────

  /**
   * §14.1's `search_performed`, carrying the three fields re-homed from the
   * retired `aeci.search.query` Datadog RUM action (§3.9). Accepted narrowing,
   * stated in §3.8: the RUM action saw EVERY search; this event sees the
   * consented slice only.
   */
  searchPerformed(input: {
    query: string;
    results_count: number;
    filters_applied: readonly string[];
    status: string;
    duration_ms: number;
    results_bucket: string;
  }): void {
    this.capture('search_performed', {
      query: input.query,
      results_count: input.results_count,
      filters_applied: [...input.filters_applied],
      status: input.status,
      duration_ms: input.duration_ms,
      results_bucket: input.results_bucket,
    });
  }

  productViewed(productId: string): void {
    this.capture('product_viewed', { product_id: productId, source: this.navigationSource() });
  }

  integrationViewed(integrationId: string): void {
    this.capture('integration_viewed', { integration_id: integrationId });
  }

  reviewSubmitted(productId: string): void {
    this.capture('review_submitted', { product_id: productId });
  }

  /** §14.1 names `vendor_id`, but the request form holds only `(target_type,
   *  slug)` and the response returns only `request_id` — so we record the
   *  honest client-available identifier (documented deviation, OBSERVABILITY.md). */
  claimRequested(input: { target_type: string; slug: string; request_id: string }): void {
    this.capture('claim_requested', { ...input });
  }

  correctionRequested(input: { target_type: string; slug: string; request_id: string }): void {
    this.capture('correction_requested', { ...input });
  }

  externalLinkClicked(input: { destination: string; source: string }): void {
    this.capture('external_link_clicked', { ...input });
  }

  /**
   * A successful mailing-list signup (`POST /api/subscribe` → `created`), fired
   * from the shared mailing-list signup band (AECI-326, extracted in AECI-327).
   * Consent-gated like every other event, so it records the *consented* funnel
   * only — the `mailing_list` D1 table and `aeci.email.send{template:landing-signup}`
   * remain the authoritative, consent-independent signup count. `source` identifies
   * the capture surface: `'home_closing_cta'` for the home band, `'mailing_list_band'`
   * for the directory + detail mounts.
   */
  mailingListSignup(input: { source: string }): void {
    this.capture('mailing_list_signup', { source: input.source });
  }

  // ─── Tier 2 operational API (NOT consent-gated) ────────────────────────────

  /**
   * Report an application error as a PostHog `$exception` (§3.3, Tier 2).
   *
   * Deliberately NOT consent-gated: this is operational telemetry, the direct
   * analogue of the consent-independent Datadog RUM error stream, and it is
   * disclosed as strictly-necessary in the privacy policy. It carries no
   * identifier — Tier 2 persistence is memory-only.
   *
   * Called by `PosthogErrorHandler`; fire-and-forget and failure-swallowing,
   * because an error reporter that throws turns one bug into two.
   */
  captureException(error: unknown): void {
    if (!this.isBrowser) return;
    void this.boot()
      .then((client) => client?.captureException(error))
      .catch(() => undefined);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Gate on browser + consent, merge the required dimensions, fire-and-forget. */
  private capture(event: string, properties: Record<string, unknown>): void {
    if (!this.isBrowser || this.consent.state() !== 'granted') return;
    const enriched = { ...properties, ...analyticsDimensions() };
    void this.boot()
      .then((client) => client?.capture(event, enriched))
      .catch(() => undefined);
  }

  private boot(): Promise<PostHogClient | null> {
    return (this.bootPromise ??= this.factory());
  }

  /**
   * Tier 2 → Tier 3 upgrade, IN PLACE on the already-running client (§3.3): no
   * re-init, so the anonymous id and super-properties survive the switch to
   * localStorage persistence.
   *
   * `set_config` alone is not enough for pageviews. Verified against
   * `posthog-js@1.393.0`: `HistoryAutocapture.startIfEnabled()` is only called
   * from `initialize()`, and `_captureInitialPageview()` only from `_loaded()`
   * / `opt_in_capturing()`. So the upgrade explicitly (a) starts the history
   * patch — idempotent, it checks `__posthog_wrapped__` — and (b) captures the
   * page the visitor consented on.
   *
   * Known minor edge: `HistoryAutocapture._lastPathname` was seeded at init, so
   * navigating BACK to the page the SDK booted on right after granting consent
   * is suppressed as a same-path change. Every other navigation is captured.
   */
  private async upgrade(): Promise<void> {
    if (this.upgraded) return;
    this.upgraded = true;
    try {
      const client = await this.boot();
      if (!client) return;
      client.set_config({ ...TIER_3_PRODUCT_ANALYTICS_CONFIG });
      client.historyAutocapture?.startIfEnabled();
      client.capture('$pageview', { ...analyticsDimensions() });
    } catch {
      // Analytics MUST NOT break the app.
    }
  }

  private navigationSource(): ProductViewSource {
    const prev = this.previousUrl;
    if (!prev) return 'direct';
    const path = prev.split(/[?#]/, 1)[0] || '/';
    if (path === '/search' || path.startsWith('/search/')) return 'search';
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return 'browse'; // home
    if (segments.length === 1 && BROWSE_ROOTS.has(segments[0])) return 'browse';
    return 'direct';
  }
}
