import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductsListResponse } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { KIND_PATH_SEGMENT, type TaxonomyTermDetail } from '../core/api/taxonomy';
import { BrowseLayout } from '../layouts/browse-layout';
import { NotFound } from '../not-found/not-found';
import { ProductCard } from '../products/product-card';
import { FacetSidebar } from '../shared/facets/facet-sidebar';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';
import { PaginationFooter } from '../shared/pagination/pagination-footer';

/**
 * AECI-61 — shared browse page for `/categories/:slug`, `/audiences/:slug`,
 * and `/phases/:slug`. One component drives all three routes; the taxonomy
 * `kind` arrives via static `route.data` and the resolved term via
 * `route.data['term']` (populated by the matching `*BrowseResolver`).
 *
 *   - `term === null` → the global `aec-not-found` shell (the resolver already
 *     set `RESPONSE_INIT.status = 404` + noindex meta).
 *   - `term` set → `BrowseLayout` with a header strip (breadcrumb + name +
 *     description + count), the API-backed facet sidebar, and the matching
 *     products as a paginated grid.
 *
 * AECI-143 — the filter sidebar (`aec-facet-sidebar`) is locked to this page's
 * own taxonomy (`lockedKind`/`lockedId`) so it cross-filters by the *other* two
 * dimensions, and the static `term.products` table is replaced by a
 * `createPaginatedIndex` grid that fetches `GET /api/products?{kind}_id=<term>`
 * with the cross-filters from the URL. The locked dimension rides `baseParams`
 * (not the URL); the cross-filters ride `passthroughParams`. The resolver is
 * unchanged — it still fetches the term (header, 404, canonical, embedded
 * `product:{slug}` cache tags). The grid + facets fetches run during SSR and are
 * captured in the HTTP transfer cache, same mechanism as `/products`.
 *
 * Cache discipline: the path matcher emits `route:browse` + `{kind}:{slug}`; the
 * resolver pushes `product:{slug}` for every product the term carries onto
 * `ctx.embedded` (a superset of any filtered grid subset), so editing any of
 * those products purges this page. Filters are query params → `<link
 * rel="canonical">` stays on the unfiltered `/{kind}/{slug}` (§20.6).
 */
@Component({
  selector: 'aec-taxonomy-browse',
  imports: [BrowseLayout, FacetSidebar, NotFound, PaginationFooter, ProductCard, RouterLink],
  template: `
    @let t = term();
    @if (t === null) {
      <aec-not-found />
    } @else {
      <aec-browse-layout>
        <div slot="header" class="space-y-4">
          <nav i18n-aria-label="@@taxonomy.browse.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)">
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@taxonomy.browse.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-secondary)">›</li>
              <li>
                @if (parentLink(); as link) {
                  <a
                    [routerLink]="link"
                    class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    >{{ parentLabel() }}</a
                  >
                } @else {
                  <span>{{ parentLabel() }}</span>
                }
              </li>
              <li aria-hidden="true" class="text-(--text-secondary)">›</li>
              <li class="text-(--text-primary)" aria-current="page">{{ t.name }}</li>
            </ol>
          </nav>

          <h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">
            {{ t.name }}
          </h1>

          @if (t.description) {
            <p class="max-w-prose text-(--text-secondary)">{{ t.description }}</p>
          }

          <p class="text-sm text-(--text-secondary)">{{ productCountLabel() }}</p>
        </div>

        <aec-facet-sidebar
          slot="filters"
          [lockedKind]="kind()"
          [lockedId]="t.id"
          [resetsPage]="false"
        />

        <!-- Append mode: dim only while a filter/sort RESET refetches (page 1),
             keeping the current rows on screen (no blank flash). Loading MORE
             pages never dims; the footer shows its own spinner. -->
        <div
          slot="grid"
          class="space-y-8 transition-opacity duration-200"
          [class.opacity-60]="idx.reloading()"
          [class.pointer-events-none]="idx.reloading()"
          [attr.aria-busy]="idx.reloading() ? 'true' : null"
        >
          <div class="overflow-x-auto">
            <table
              class="w-full border-collapse text-start text-sm md:min-w-[52rem]"
              i18n-aria-label="@@taxonomy.browse.table.aria"
              aria-label="Products"
            >
              <thead
                class="border-b border-(--border-default) text-xs font-medium tracking-wide text-(--text-secondary)"
              >
                <tr>
                  <th scope="col" class="px-4 py-3 font-medium" i18n="@@taxonomy.browse.col.name">
                    Name
                  </th>
                  <th
                    scope="col"
                    class="hidden px-4 py-3 font-medium md:table-cell"
                    i18n="@@taxonomy.browse.col.vendor"
                  >
                    Vendor
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 font-medium"
                    i18n="@@taxonomy.browse.col.category"
                  >
                    Primary category
                  </th>
                  <th
                    scope="col"
                    class="hidden px-4 py-3 text-end font-medium md:table-cell"
                    i18n="@@taxonomy.browse.col.rating"
                  >
                    Rating
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-end font-medium"
                    i18n="@@taxonomy.browse.col.integrations"
                  >
                    Integrations
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-(--border-default)">
                @if (idx.items().length === 0 && idx.pending()) {
                  <tr aria-busy="true">
                    <td
                      colspan="4"
                      class="px-4 py-12 text-center text-(--text-secondary)"
                      i18n="@@taxonomy.browse.loading"
                    >
                      Loading products…
                    </td>
                  </tr>
                } @else if (idx.items().length === 0 && idx.error()) {
                  <tr>
                    <td
                      colspan="4"
                      class="px-4 py-12 text-center text-(--text-secondary)"
                      i18n="@@taxonomy.browse.error"
                    >
                      Couldn't load products. Refresh to try again.
                    </td>
                  </tr>
                } @else {
                  @for (product of idx.items(); track product.id) {
                    <tr aec-product-card [product]="product"></tr>
                  } @empty {
                    <tr>
                      <td
                        colspan="4"
                        class="px-4 py-12 text-center text-(--text-secondary)"
                        i18n="@@taxonomy.browse.empty"
                      >
                        No products match these filters.
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>

          @if (idx.items().length > 0) {
            <aec-pagination-footer
              class="block border-t border-(--border-default) pt-6"
              [loadedCount]="idx.loadedCount()"
              [total]="idx.total()"
              [hasMore]="idx.hasMore()"
              [pending]="idx.pending()"
              [nextHref]="nextHref()"
              (loadMore)="idx.loadMore()"
            />
          }
        </div>
      </aec-browse-layout>
    }
  `,
})
export class TaxonomyBrowsePage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Taxonomy kind for this route — static `data: { kind }` in `app.routes.ts`. */
  protected readonly kind = computed<TaxonomyKind>(
    () => this.route.snapshot.data['kind'] as TaxonomyKind,
  );

  /**
   * Resolved term. `*BrowseResolver` runs server-side and on hydration reads
   * from `TransferState`; the snapshot value is the SSR-resolved term (or null
   * on NOT_FOUND).
   */
  protected readonly term = toSignal<TaxonomyTermDetail | null, TaxonomyTermDetail | null>(
    this.route.data.pipe(map((d) => (d['term'] ?? null) as TaxonomyTermDetail | null)),
    { initialValue: (this.route.snapshot.data['term'] ?? null) as TaxonomyTermDetail | null },
  );

  /**
   * Filtered products grid. Locks this page's own dimension via `baseParams`
   * (`{kind}_id=<term.id>`, never a URL param) and lets the facet sidebar drive
   * the other two dimensions through the URL (`passthroughParams`). `enabled`
   * gates the fetch on a resolved term so a 404 doesn't query the whole catalog.
   * Meta is owned by the resolver, so none is passed here.
   */
  protected readonly idx = createPaginatedIndex<ProductsListResponse>({
    apiPath: '/api/products',
    validSorts: new Set(['created', 'name', 'updated']),
    defaultSort: 'created',
    // Infinite-scroll list: page 1 SSRs + edge-caches, later pages append
    // client-side (the page number stays out of the URL). See createPaginatedIndex.
    mode: 'append',
    baseParams: () => ({ [`${this.kind()}_id`]: this.term()?.id }),
    passthroughParams: (['category_id', 'audience_id', 'phase_id'] as const).filter(
      (param) => param !== `${this.kind()}_id`,
    ),
    enabled: () => this.term() !== null,
  });

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

  /** Breadcrumb ancestor label per kind (e.g. "Categories"). */
  protected readonly parentLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@taxonomy.browse.breadcrumbs.categories:Categories`;
      case 'audience':
        return $localize`:@@taxonomy.browse.breadcrumbs.audiences:Audiences`;
      case 'phase':
        return $localize`:@@taxonomy.browse.breadcrumbs.phases:Phases`;
    }
  });

  /**
   * Breadcrumb ancestor link. All three facets have a flat index page since
   * AECI-157 (`/categories`, `/audiences`, `/phases`), so the ancestor always
   * links.
   */
  protected readonly parentLink = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  protected readonly productCountLabel = computed(() => {
    const count = this.term()?.product_count ?? 0;
    return $localize`:@@taxonomy.browse.products.count:${count}:INTERPOLATION: products`;
  });
}
