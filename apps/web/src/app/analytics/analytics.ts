/**
 * Client-side product analytics (AECI-239 / §14.1) — the typed PostHog event
 * API the app calls, and the consent-gated boot of the SDK.
 *
 * Shape (mirrors `datadog.provider.ts` + the `search-rum.ts` seam):
 *   - The SDK is reached only through the injectable `POSTHOG_CLIENT_FACTORY`
 *     (default = the real dynamic-`import('posthog-js')`); tests swap a fake so
 *     event payloads are asserted without loading the SDK.
 *   - An `effect` boots PostHog the moment consent becomes `'granted'` (incl. a
 *     returning visitor whose decision is already stored) so the automatic
 *     initial `$pageview` fires without waiting for a custom event.
 *   - Every custom event is gated on `'granted'` and merges the `locale`+`theme`
 *     dimensions (§14.1). Autocaptured pageviews get the same dimensions via the
 *     super-properties the factory registers in PostHog's `loaded` callback.
 *   - Fire-and-forget: `capture` never awaits in a way that can throw into the
 *     caller — analytics MUST NOT break navigation or a form submit.
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { analyticsDimensions } from './analytics-dimensions';
import { ConsentService } from './consent';
import { POSTHOG_CLIENT_FACTORY, type PostHogClient } from './posthog-client';

/** Where a `product_viewed` was reached from (§14.1). */
export type ProductViewSource = 'search' | 'browse' | 'direct';

/** Catalog index/listing surfaces — arriving from one means `source: 'browse'`. */
const BROWSE_ROOTS = new Set(['products', 'vendors', 'integrations', 'categories']);

@Injectable({ providedIn: 'root' })
export class Analytics {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly consent = inject(ConsentService);
  private readonly factory = inject(POSTHOG_CLIENT_FACTORY);
  private readonly router = inject(Router);

  /** Memoized client boot — runs at most once, only after consent is granted. */
  private bootPromise: Promise<PostHogClient | null> | null = null;

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

    // Boot PostHog as soon as consent is granted (or immediately, for a
    // returning visitor whose decision is already stored) so the automatic
    // initial pageview is captured.
    effect(() => {
      if (this.consent.state() === 'granted') void this.boot();
    });
  }

  // ─── Custom events (§14.1) ─────────────────────────────────────────────────

  searchPerformed(input: {
    query: string;
    results_count: number;
    filters_applied: readonly string[];
  }): void {
    this.capture('search_performed', {
      query: input.query,
      results_count: input.results_count,
      filters_applied: [...input.filters_applied],
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
