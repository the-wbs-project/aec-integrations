import { isPlatformServer } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject } from '@angular/core';

import { type TaxonomyResponse } from '@aeci/shared';

import { buildBrowseMenu } from './browse-menu-model';
import { TOP_N, topByCount } from './taxonomy-rank';

/**
 * Supplies the Browse menu (desktop panel + mobile overlay, `browse-menu-model.ts`)
 * and the home hero's category fallback (`categoriesTop10`).
 *
 * Browser-only by design: the request reactive returns `undefined` on the
 * server, so `httpResource` stays idle during SSR and never issues the
 * `/api/taxonomy` call. The nav *labels* are SSR-rendered static links to the
 * crawlable facet index pages (`/categories`, `/audiences`, `/phases`,
 * `/trades`); the
 * menu *terms and counts* are a client-only enhancement fetched once after hydration
 * via the same-origin `/api/*` passthrough (edge + KV cached). This deliberately
 * avoids the SSR `/api/*` loopback the codebase shuns (see `core/api/taxonomy.ts`)
 * and keeps cached page HTML free of taxonomy state: because the menu terms
 * are fetched from the browser, no page's edge-cached HTML bakes in the taxonomy
 * term set. `/api/taxonomy` is `private, no-store` at the edge (AECI-43) and
 * read-through cached in the API Worker's KV with a 5-minute TTL, which is its
 * only staleness bound — there is no active KV invalidation (see
 * `routes/taxonomy.ts`), so a taxonomy edit can take up to ~5 min to surface in
 * the menu. The SSR taxonomy index pages (`/categories`, `/audiences`,
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

  /** Top 10 categories by count (or fewer), descending. The home hero's fallback row. */
  readonly categoriesTop10 = computed(() => topByCount(this.value()?.categories, TOP_N));
  /**
   * The Browse menu's columns (AECI-1774): key categories, then categories, phases,
   * audiences and trades, each in its documented order. One model feeds the desktop
   * panel and the mobile menu, so the two cannot disagree. Empty during SSR and
   * until the fetch lands. If the fetch fails it stays empty: the panel still shows
   * "All products", each column label and its "See all" link, so nothing in the
   * header depends on the API answering.
   */
  readonly browse = computed(() => buildBrowseMenu(this.value()));

  /** True while the client fetch is in flight; always false during SSR. */
  readonly loading = computed(() => this.resource.isLoading());
  /** The last fetch error, or `undefined`. */
  readonly error = computed(() => this.resource.error());
}
