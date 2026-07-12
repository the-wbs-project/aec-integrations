import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import type { ProductsListResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { BrowseLayout } from '../layouts/browse-layout';
import { FacetSidebar } from '../shared/facets/facet-sidebar';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';
import { PaginationFooter } from '../shared/pagination/pagination-footer';

import { ProductCard } from './product-card';
import { ProductCardGrid } from './product-card-grid';

type ViewKey = 'cards' | 'table';

/**
 * Phase 2.12 (AECI-58) product index. Composes two features:
 *
 * - AECI-143 — `BrowseLayout` with the API-backed `aec-facet-sidebar` in the
 *   `filters` slot. Taxonomy cross-filters (`category_id` / `audience_id` /
 *   `phase_id`) ride the URL via `passthroughParams`, so the grid re-fetches the
 *   filtered list when the sidebar navigates; those params are in `/products`'
 *   `cacheKeyParams` allowlist so each filter combination caches under its own
 *   edge key.
 * - AECI-190 — inside the `grid` slot, the catalog renders in one of two views,
 *   a buyer-facing card grid (default) or a dense table, switched by a toolbar
 *   toggle, with sort moved from clickable column headers to a `<select>`.
 *
 * The fetch/sort/pagination/error pipeline lives in the shared
 * `createPaginatedIndex` controller (AECI-107), here in **append mode**: the
 * catalog is an infinite-scroll list (`aec-pagination-footer`) that accumulates
 * pages as the reader nears the end. Page 1 still SSRs + edge-caches; later pages
 * append client-side and the page number is driven internally, so it never
 * enters the URL. `?sort=` and the facet params stay URL-owned (cache-safe,
 * shareable, SSR-correct); `?view=` is owned here. Every navigation merges, so
 * they coexist. `view` is deliberately NOT a cookie — `/products` is edge-cached
 * and SSR must stay visitor-state-neutral — and is kept out of the fetch params
 * so it never forks the data cache (the rows are identical in both views).
 * Default sort: `created DESC` (Phase 2 §7.4); `perPage` fixed at 24 (§7.1),
 * hard-clamped at 100 server-side.
 *
 * SSR: cached 5 min at the edge with `Cache-Tag: route:index, index:products`
 * (set by the SSR Worker via `cacheTagInputsForPath`); `withHttpTransferCache`
 * serializes the `/api/products` + `/api/products/facets` responses so the
 * client doesn't re-fetch on hydration. `<link rel="canonical">` stays on the
 * unfiltered `/products` (filters/view are query params, stripped by the meta
 * layer — §20.6). The card grid's "broken-grid" featured lead is gated to page 1
 * at the newest sort (`showFeatured`) so its "Recently added" claim stays
 * truthful even with filters applied.
 */
@Component({
  selector: 'app-products-index',
  imports: [
    RouterLink,
    BrowseLayout,
    FacetSidebar,
    ProductCard,
    ProductCardGrid,
    PaginationFooter,
    MailingListSignup,
  ],
  template: `
    <aec-browse-layout>
      <div slot="header" class="space-y-3">
        <nav i18n-aria-label="@@products.index.breadcrumbs.aria" aria-label="Breadcrumb">
          <ol class="flex items-center gap-2 text-sm text-(--text-secondary)">
            <li>
              <a
                routerLink="/"
                class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@products.index.breadcrumbs.home"
                >Home</a
              >
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li
              class="text-(--text-primary)"
              aria-current="page"
              i18n="@@products.index.breadcrumbs.current"
            >
              Products
            </li>
          </ol>
        </nav>
        <h1
          class="font-display text-4xl font-semibold tracking-tight md:text-5xl"
          i18n="@@products.index.title"
        >
          Products
        </h1>
        @if (idx.total() !== null) {
          <p class="text-(--text-secondary)" i18n="@@products.index.lede">
            Every AEC software product indexed on AEC Integrations ({{ idx.total() }} in total).
          </p>
        } @else {
          <p class="text-(--text-secondary)" i18n="@@products.index.lede.loading">
            Every AEC software product indexed on AEC Integrations.
          </p>
        }
      </div>

      <aec-facet-sidebar slot="filters" [resetsPage]="false" />

      <div slot="grid" class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="inline-flex items-center gap-2">
            <label
              for="aec-products-sort"
              class="text-sm text-(--text-secondary)"
              i18n="@@products.index.sort.label"
              >Sort</label
            >
            <div class="relative">
              <select
                id="aec-products-sort"
                class="appearance-none rounded-(--radius-md) border border-(--border-default)
                  bg-(--surface-base) py-1.5 pe-9 ps-3 text-sm text-(--text-primary)
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                (change)="onSortChange($event)"
              >
                @for (o of sortOptions; track o.value) {
                  <option [value]="o.value" [selected]="o.value === idx.sort()">
                    {{ o.label }}
                  </option>
                }
              </select>
              <svg
                class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          <div
            role="group"
            class="inline-flex gap-1 rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-1"
            i18n-aria-label="@@products.index.view.aria"
            aria-label="Choose a view"
          >
            <button
              type="button"
              [class]="viewBtnClass('cards')"
              [attr.aria-pressed]="view() === 'cards'"
              (click)="setView('cards')"
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect width="7" height="7" x="3" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="14" rx="1" />
                <rect width="7" height="7" x="3" y="14" rx="1" />
              </svg>
              <span i18n="@@products.index.view.cards">Cards</span>
            </button>
            <button
              type="button"
              [class]="viewBtnClass('table')"
              [attr.aria-pressed]="view() === 'table'"
              (click)="setView('table')"
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <line x1="8" x2="21" y1="6" y2="6" />
                <line x1="8" x2="21" y1="12" y2="12" />
                <line x1="8" x2="21" y1="18" y2="18" />
                <line x1="3" x2="3.01" y1="6" y2="6" />
                <line x1="3" x2="3.01" y1="12" y2="12" />
                <line x1="3" x2="3.01" y1="18" y2="18" />
              </svg>
              <span i18n="@@products.index.view.table">Table</span>
            </button>
          </div>
        </div>

        <!-- Append mode: dim only while a filter/sort RESET refetches (page 1),
             keeping the current results on screen (no blank flash). Loading MORE
             pages never dims; the accumulated cards stay bright and only the
             footer shows a spinner. aria-busy announces the in-flight reset. -->
        <div
          class="transition-opacity duration-200"
          [class.opacity-60]="idx.reloading()"
          [class.pointer-events-none]="idx.reloading()"
          [attr.aria-busy]="idx.reloading() ? 'true' : null"
        >
          @if (idx.items().length > 0) {
            @switch (view()) {
              @case ('table') {
                <div class="overflow-x-auto">
                  <table
                    class="w-full border-collapse text-start text-sm md:min-w-[52rem]"
                    i18n-aria-label="@@products.index.table.aria"
                    aria-label="Products"
                  >
                    <thead class="border-b border-(--border-default)">
                      <tr>
                        <th
                          scope="col"
                          class="px-4 py-3 text-start text-xs font-medium tracking-wide text-(--text-secondary)"
                          i18n="@@products.index.col.name"
                        >
                          Name
                        </th>
                        <th
                          scope="col"
                          class="hidden px-4 py-3 text-start text-xs font-medium tracking-wide text-(--text-secondary) md:table-cell"
                          i18n="@@products.index.col.vendor"
                        >
                          Vendor
                        </th>
                        <th
                          scope="col"
                          class="px-4 py-3 text-start text-xs font-medium tracking-wide text-(--text-secondary)"
                          i18n="@@products.index.col.category"
                        >
                          Primary category
                        </th>
                        <th
                          scope="col"
                          class="hidden px-4 py-3 text-end text-xs font-medium tracking-wide text-(--text-secondary) md:table-cell"
                          i18n="@@products.index.col.rating"
                        >
                          Rating
                        </th>
                        <th
                          scope="col"
                          class="px-4 py-3 text-end text-xs font-medium tracking-wide text-(--text-secondary)"
                          i18n="@@products.index.col.integrations"
                        >
                          Integrations
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-(--border-default)">
                      @for (product of idx.items(); track product.id) {
                        <tr aec-product-card [product]="product"></tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              @default {
                <aec-product-card-grid [products]="idx.items()" [featuredLead]="showFeatured()" />
              }
            }

            <aec-pagination-footer
              class="mt-6 block border-t border-(--border-default) pt-6"
              [loadedCount]="idx.loadedCount()"
              [total]="idx.total()"
              [hasMore]="idx.hasMore()"
              [pending]="idx.pending()"
              [nextHref]="nextHref()"
              (loadMore)="idx.loadMore()"
            />
          } @else if (idx.pending()) {
            <p
              class="py-12 text-center text-(--text-secondary)"
              aria-busy="true"
              i18n="@@products.index.loading"
            >
              Loading products…
            </p>
          } @else if (idx.error()) {
            <p class="py-12 text-center text-(--text-secondary)" i18n="@@products.index.error">
              Couldn't load products. Refresh to try again.
            </p>
          } @else {
            <p
              class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-center text-sm text-(--text-secondary)"
              i18n="@@products.index.empty"
            >
              No products match these filters.
            </p>
          }
        </div>
      </div>
    </aec-browse-layout>

    <aec-mailing-list-signup />
  `,
})
export class ProductsIndex {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly queryParamMap = toSignal(this.route.queryParamMap, { requireSync: true });

  protected readonly idx = createPaginatedIndex<ProductsListResponse>({
    apiPath: '/api/products',
    validSorts: new Set(['created', 'name', 'updated', 'rating', 'reviews']),
    defaultSort: 'created',
    // Accumulate pages for the scroll-based listing UX (page 1 still SSRs +
    // edge-caches; pages 2..N append client-side). See createPaginatedIndex.
    mode: 'append',
    // AECI-143 — taxonomy cross-filters set by the facet sidebar ride the URL.
    passthroughParams: ['category_id', 'audience_id', 'phase_id'],
    meta: {
      entity: 'index',
      name: $localize`:@@products.index.metaName:Products`,
      description: $localize`:@@products.index.metaDescription:The directory of every AEC software product on AEC Integrations. Sortable by name, recency, last update, rating, and review count.`,
      canonical: canonicalUrl('/products'),
    },
  });

  protected readonly sortOptions = [
    { value: 'created', label: $localize`:@@products.index.sort.newest:Newest` },
    { value: 'name', label: $localize`:@@products.index.sort.name:Name (A–Z)` },
    { value: 'updated', label: $localize`:@@products.index.sort.updated:Recently updated` },
    { value: 'rating', label: $localize`:@@products.index.sort.rating:Highest rated` },
    { value: 'reviews', label: $localize`:@@products.index.sort.reviews:Most reviewed` },
  ];

  protected readonly view = computed<ViewKey>(() =>
    this.queryParamMap().get('view') === 'table' ? 'table' : 'cards',
  );

  /** Featured lead only when truthful: the buffer starts at page 1 at the newest sort. */
  protected readonly showFeatured = computed(
    () => this.idx.sort() === 'created' && this.idx.firstPage() === 1,
  );

  /** Absolute `?page=N+1` URL (current params merged) for the footer's real anchor / no-JS path. */
  protected readonly nextHref = computed<string | null>(() => {
    if (!this.idx.hasMore()) return null;
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: { page: this.idx.highestPage() + 1 },
      queryParamsHandling: 'merge',
    });
    return this.router.serializeUrl(tree);
  });

  protected setView(value: ViewKey): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: value },
      queryParamsHandling: 'merge',
    });
  }

  protected onSortChange(event: Event): void {
    this.idx.onSortChange((event.target as HTMLSelectElement).value);
  }

  protected viewBtnClass(value: ViewKey): string {
    const base =
      'inline-flex items-center gap-1.5 rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return this.view() === value
      ? `${base} bg-(--accent-primary) text-(--surface-base)`
      : `${base} text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
