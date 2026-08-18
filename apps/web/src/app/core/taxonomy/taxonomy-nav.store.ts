import { isPlatformServer } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject } from '@angular/core';

import { type TaxonomyResponse, isPublishedTrade } from '@aeci/shared';

import { TOP_N, byDisplayOrder, topByCount } from './taxonomy-rank';

/**
 * Supplies the primary-nav taxonomy flyouts (desktop bar + mobile overlay) with
 * the top values per facet, ranked by `SORT_KEY`.
 *
 * Browser-only by design: the request reactive returns `undefined` on the
 * server, so `httpResource` stays idle during SSR and never issues the
 * `/api/taxonomy` call. The nav *labels* are SSR-rendered static links to the
 * crawlable facet index pages (`/categories`, `/audiences`, `/phases`,
 * `/trades`); the
 * flyout *values* are a client-only enhancement fetched once after hydration
 * via the same-origin `/api/*` passthrough (edge + KV cached). This deliberately
 * avoids the SSR `/api/*` loopback the codebase shuns (see `core/api/taxonomy.ts`)
 * and keeps cached page HTML free of taxonomy state: because the flyout values
 * are fetched from the browser, no page's edge-cached HTML bakes in the taxonomy
 * term set. `/api/taxonomy` is `private, no-store` at the edge (AECI-43) and
 * read-through cached in the API Worker's KV with a 5-minute TTL, which is its
 * only staleness bound — there is no active KV invalidation (see
 * `routes/taxonomy.ts`), so a taxonomy edit can take up to ~5 min to surface in
 * the flyouts. The SSR taxonomy index pages (`/categories`, `/audiences`,
 * `/phases`, `/trades`) separately carry the `taxonomy` cache-tag and purge
 * immediately.
 *
 * Root singleton: the resource is created once and shared by every nav surface,
 * so the fetch happens a single time per app load. AECI-156.
 */
@Injectable({ providedIn: 'root' })
export class TaxonomyNavStore {
  private readonly platformId = inject(PLATFORM_ID);

  private readonly resource = httpResource<TaxonomyResponse>(() =>
    isPlatformServer(this.platformId) ? undefined : '/api/taxonomy',
  );

  private readonly value = computed<TaxonomyResponse | null>(() =>
    this.resource.hasValue() ? this.resource.value() : null,
  );

  /** Top 10 categories by count (or fewer), descending. */
  readonly categoriesTop10 = computed(() => topByCount(this.value()?.categories, TOP_N));
  /** Top 10 audiences by count (or fewer), descending. */
  readonly audiencesTop10 = computed(() => topByCount(this.value()?.audiences, TOP_N));
  /** All phases, in project-lifecycle order (`display_order` asc), not by count. */
  readonly phasesAll = computed(() => byDisplayOrder(this.value()?.phases));
  /**
   * Top 10 **published** trades by count (AECI-544). Ranked by count like
   * categories/audiences rather than by `display_order` — the trades vocabulary
   * is alphabetical, so lifecycle ordering would carry no signal, and the flyout
   * is a "start here" shortlist.
   *
   * The `TRADE_PUBLISH_MIN_PRODUCTS` floor applies (TRADES_VOCABULARY.md §6):
   * these counts are unscoped, so the floor is meaningful here, and offering a
   * nav shortcut to a page the `/trades` index deliberately omits would be
   * incoherent. "View all trades" still reaches the index.
   */
  readonly tradesTop10 = computed(() =>
    topByCount(this.value()?.trades.filter(isPublishedTrade), TOP_N),
  );

  /** True while the client fetch is in flight; always false during SSR. */
  readonly loading = computed(() => this.resource.isLoading());
  /** The last fetch error, or `undefined`. */
  readonly error = computed(() => this.resource.error());
}
