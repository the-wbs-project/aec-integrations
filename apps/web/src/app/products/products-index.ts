import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import type { ProductsListResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { BrowseLayout } from '../layouts/browse-layout';
import { FacetSidebar } from '../shared/facets/facet-sidebar';
import { ListingToolbar } from '../shared/listing-toolbar/listing-toolbar';
import { createListingView } from '../shared/listing-toolbar/listing-view';
import { productSortOptions } from '../shared/listing-toolbar/product-sort-options';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';

import { PRODUCTS_INDEX_REQUEST } from './products-index.config';
import { PaginationFooter } from '../shared/pagination/pagination-footer';

import { ProductCard } from './product-card';
import { ProductCardGrid } from './product-card-grid';

/**
 * Phase 2.12 (AECI-58) product index. Composes two features:
 *
 * - AECI-143 — `BrowseLayout` with the API-backed `aec-facet-sidebar` in the
 *   `filters` slot. Taxonomy cross-filters (`category_id` / `audience_id` /
 *   `phase_id`) ride the URL via `passthroughParams`, so the grid re-fetches the
 *   filtered list when the sidebar navigates; each filter combination is a
 *   distinct query string, so the native Workers Cache keys each under its own
 *   edge entry.
 * - AECI-190 — inside the `grid` slot, the catalog renders in one of two views,
 *   a buyer-facing card grid (default) or a dense table, switched by a toolbar
 *   toggle, with sort moved from clickable column headers to a `<select>`.
 *   AECI-657 lifted that toolbar out to `aec-listing-toolbar` + the shared
 *   `createListingView` / `productSortOptions` pair, because the taxonomy browse
 *   pages needed the same control and had shipped without one (STAGE_1_SPEC.md
 *   §4.5). This page's behaviour is unchanged by the move; the sort list gained
 *   "Most integrations", the third option §4.5 named.
 *
 * The fetch/sort/pagination/error pipeline lives in the shared
 * `createPaginatedIndex` controller (AECI-107), here in **append mode**: the
 * catalog is an infinite-scroll list (`aec-pagination-footer`) that accumulates
 * pages as the reader nears the end. Page 1 SSRs (via `productsIndexResolver`)
 * and edge-caches; later pages
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
 * (set by the SSR Worker via `cacheTagInputsForPath`). Page 1 is prefetched by
 * `productsIndexResolver` through the service binding and handed to the grid via
 * `TransferState` (AECI-746) — until that shipped, this route server-rendered its
 * "Couldn't load products" branch to every crawler. `<link rel="canonical">` stays on the
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
    ListingToolbar,
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
        <aec-listing-toolbar
          [sortOptions]="sortOptions"
          [sort]="idx.sort()"
          [view]="listingView.view()"
          (sortChange)="idx.onSortChange($event)"
          (viewChange)="listingView.set($event)"
        />

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
            @switch (listingView.view()) {
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

  /** `?view=` ownership — shared with the taxonomy browse pages (AECI-657). */
  protected readonly listingView = createListingView();

  protected readonly idx = createPaginatedIndex<ProductsListResponse>({
    ...PRODUCTS_INDEX_REQUEST,
    // Accumulate pages for the scroll-based listing UX (page 1 SSRs via
    // `productsIndexResolver` + edge-caches; pages 2..N append client-side).
    mode: 'append',
    meta: {
      entity: 'index',
      name: $localize`:@@products.index.metaName:Products`,
      description: $localize`:@@products.index.metaDescription:The directory of every AEC software product on AEC Integrations. Sortable by name, recency, last update, rating, and review count.`,
      canonical: canonicalUrl('/products'),
    },
  });

  protected readonly sortOptions = productSortOptions();

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
}
