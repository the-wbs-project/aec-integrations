import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductsListResponse } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { KIND_PATH_SEGMENT, type TaxonomyTermDetail } from '../core/api/taxonomy';
import { BROWSE_HEADER_CLASS } from '../layouts/browse-header';
import { BrowseLayout } from '../layouts/browse-layout';
import { NotFound } from '../not-found/not-found';
import { ProductCardGrid } from '../products/product-card-grid';
import { ProductTable } from '../products/product-table';
import { EmptyState } from '../shared/empty-state/empty-state';
import { FacetSidebar } from '../shared/facets/facet-sidebar';
import { FILTER_LINK_CLASS } from '../shared/facets/filter-row';
import { ListingToolbar } from '../shared/listing-toolbar/listing-toolbar';
import { createListingView } from '../shared/listing-toolbar/listing-view';
import {
  PRODUCT_DEFAULT_SORT,
  productSortOptions,
} from '../shared/listing-toolbar/product-sort-options';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';

import { taxonomyBrowseIndexRequest } from './taxonomy-browse.config';
import { PaginationFooter } from '../shared/pagination/pagination-footer';
import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';

/**
 * AECI-61 / AECI-544 — shared browse page for `/categories/:slug`,
 * `/audiences/:slug`, `/phases/:slug`, and `/trades/:slug`. One component drives
 * all four routes; the taxonomy `kind` arrives via static `route.data` and the
 * resolved term via `route.data['term']` (populated by the matching
 * `*BrowseResolver`).
 *
 *   - `term === null` → the global `aec-not-found` shell (the resolver already
 *     set `RESPONSE_INIT.status = 404` + noindex meta).
 *   - `term.product_count === 0` → header + an honest "nothing tagged yet"
 *     panel, no sidebar and no table (AECI-544). Reachable mainly on trades,
 *     whose closed 34-term vocabulary is seeded ahead of the tagging and whose
 *     sub-floor terms stay linkable even though the `/trades` index omits them.
 *     Filter chrome over an empty set is noise, and the generic "No products
 *     match these filters" row is a lie when no filter is applied.
 *   - `term` set with products → `BrowseLayout` with a header strip (breadcrumb
 *     + name + description + count), the API-backed facet sidebar, and the
 *     matching products as a paginated grid.
 *
 * AECI-657 — the grid slot leads with `aec-listing-toolbar`, the same sort +
 * cards/table control `/products` carries, and renders `ProductCardGrid` in the
 * cards view (the default, matching `/products`) or the shared
 * `aec-product-table` in the table view (AECI-1793). Loading, error and "no
 * match" read the same in both views, as on `/products`. Until AECI-657 this
 * page had NO toolbar: `STAGE_1_SPEC.md` §4.5 asks
 * for a "Product grid with sort options (alphabetical, most integrations, most
 * reviewed)" and it shipped with a table and no sort, because AECI-190's
 * redesign was scoped to `/products` and gave this page only the upgraded row.
 * `?sort=` worked all along — `createPaginatedIndex` reads it off the URL — it
 * was simply undiscoverable. `?view=` is owned by the shared
 * `createListingView`; both params are already in `LISTING_CACHE_KEY_PARAMS`
 * (`CACHE_STRATEGY.md` §4a), and neither reaches the canonical, which the
 * resolver builds from path segments alone.
 *
 * AECI-143 — the filter sidebar (`aec-facet-sidebar`) is locked to this page's
 * own taxonomy (`lockedKind`/`lockedId`) so it cross-filters by the *other* two
 * dimensions, and the static `term.products` table is replaced by a
 * `createPaginatedIndex` grid that fetches `GET /api/products?{kind}_slug=<term>`
 * (`{kind}_id` until AECI-1508) with the cross-filters from the URL. The locked
 * dimension rides `baseParams` (not the URL); the cross-filters ride
 * `passthroughParams`. The resolver fetches the term (header, 404, canonical,
 * embedded `product:{slug}` cache tags) and, in parallel, the grid's first page
 * into `TransferState` (AECI-746, AECI-1508).
 *
 * Cache discipline: the path matcher emits `route:browse` + `{kind}:{slug}`; the
 * resolver pushes `product:{slug}` for every product the term carries onto
 * `ctx.embedded` (a superset of any filtered grid subset), so editing any of
 * those products purges this page. Filters are query params → `<link
 * rel="canonical">` stays on the unfiltered `/{kind}/{slug}` (§20.6).
 */
@Component({
  selector: 'aec-taxonomy-browse',
  imports: [
    AecBreadcrumb,
    BrowseLayout,
    FacetSidebar,
    ListingToolbar,
    MailingListSignup,
    NgTemplateOutlet,
    NotFound,
    EmptyState,
    PaginationFooter,
    ProductCardGrid,
    ProductTable,
    RouterLink,
  ],
  template: `
    <!--
      Header strip, shared by the populated and empty-term branches below so the
      breadcrumb / title / description markup has exactly one definition. The
      term rides the outlet context rather than the outer \`@let\`, so the
      template never depends on where it is instantiated.
    -->
    <ng-template #pageHeader let-t>
      <aec-breadcrumb [items]="crumbs()" />

      <h1 [class]="headerClass.title">{{ t.name }}</h1>

      @if (t.description) {
        <p [class]="headerClass.lede">{{ t.description }}</p>
      }
    </ng-template>

    @let t = term();
    @if (t === null) {
      <aec-not-found />
    } @else if (t.product_count === 0) {
      <!--
        Nothing tagged yet. No sidebar (there is nothing to cross-filter) and no
        table: just the header and an honest panel out to the products index.
        BrowseLayout without the rail, so both states share one header and wrap.
      -->
      <aec-browse-layout [filters]="false">
        <div slot="header">
          <ng-container
            [ngTemplateOutlet]="pageHeader"
            [ngTemplateOutletContext]="{ $implicit: t }"
          />
        </div>

        <!-- Mock-up 10, the empty term: a lead line at 16px and 600 in primary
             ink, the sentence under it, then "Browse all products" as the
             standalone link role with a 44px target. Same words as before. -->
        <aec-empty-state slot="grid">
          <p class="max-w-2xl font-semibold text-(--text-primary)">{{ emptyTermHeadline() }}</p>
          <p class="mt-1 max-w-2xl" i18n="@@taxonomy.browse.emptyTerm.body">
            As the catalog grows, this page fills in on its own.
          </p>
          <a
            routerLink="/products"
            [class]="emptyLinkClass"
            class="mt-2"
            i18n="@@taxonomy.browse.emptyTerm.cta"
            >Browse all products</a
          >
        </aec-empty-state>
      </aec-browse-layout>

      <aec-mailing-list-signup />
    } @else {
      <aec-browse-layout>
        <div slot="header">
          <ng-container
            [ngTemplateOutlet]="pageHeader"
            [ngTemplateOutletContext]="{ $implicit: t }"
          />

          <p [class]="headerClass.count">{{ productCountLabel() }}</p>
        </div>

        <aec-facet-sidebar
          slot="filters"
          [lockedKind]="kind()"
          [lockedId]="t.id"
          [resetsPage]="false"
        />

        <div slot="grid" class="space-y-6">
          <aec-listing-toolbar
            [sortOptions]="sortOptions"
            [sort]="idx.sort()"
            [view]="listingView.view()"
            (sortChange)="idx.onSortChange($event)"
            (viewChange)="listingView.set($event)"
          />

          <!-- Append mode: dim only while a filter/sort RESET refetches (page 1),
               keeping the current rows on screen (no blank flash). Loading MORE
               pages never dims; the footer shows its own spinner. -->
          <div
            class="space-y-8 transition-opacity duration-200"
            [class.opacity-60]="idx.reloading()"
            [class.pointer-events-none]="idx.reloading()"
            [attr.aria-busy]="idx.reloading() ? 'true' : null"
          >
            @if (idx.items().length > 0) {
              @if (listingView.view() === 'table') {
                <aec-product-table [rows]="idx.items()" />
              } @else {
                <aec-product-card-grid [products]="idx.items()" [featuredLead]="showFeatured()" />
              }
            } @else if (idx.pending()) {
              <p
                class="py-12 text-center text-(--text-secondary)"
                aria-busy="true"
                i18n="@@taxonomy.browse.cards.loading"
              >
                Loading products…
              </p>
            } @else if (idx.error()) {
              <p
                class="py-12 text-center text-(--text-secondary)"
                i18n="@@taxonomy.browse.cards.error"
              >
                Couldn't load products. Refresh to try again.
              </p>
            } @else {
              <aec-empty-state>
                <p i18n="@@taxonomy.browse.cards.empty">No products match these filters.</p>
              </aec-empty-state>
            }
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

      <aec-mailing-list-signup />
    }
  `,
})
export class TaxonomyBrowsePage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly headerClass = BROWSE_HEADER_CLASS;
  /** The standalone link role, the same spelling as the filter panel's links. */
  protected readonly emptyLinkClass = FILTER_LINK_CLASS;

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

  /** Toolbar options + `?view=` ownership, shared with `/products` (AECI-657). */
  protected readonly sortOptions = productSortOptions();
  protected readonly listingView = createListingView();

  /**
   * Filtered products grid. Locks this page's own dimension via `baseParams`
   * (`{kind}_slug=<term.slug>`, never a URL param) and lets the facet sidebar drive
   * the other three dimensions through the URL (`passthroughParams`). `enabled`
   * gates the fetch on a resolved term so a 404 doesn't query the whole catalog.
   * Meta is owned by the resolver, so none is passed here.
   */
  protected readonly idx = createPaginatedIndex<ProductsListResponse>({
    // Shared with `taxonomyBrowseResolver`'s SSR prefetch so the request line the
    // server fetched is the one this asks for (AECI-746).
    ...taxonomyBrowseIndexRequest(
      () => this.kind(),
      () => this.term()?.slug,
    ),
    // Infinite-scroll list: page 1 SSRs via the resolver + edge-caches, later
    // pages append client-side (the page number stays out of the URL).
    mode: 'append',
    enabled: () => this.term() !== null,
  });

  /**
   * The card grid's "Recently added" featured lead, gated exactly as on
   * `/products`: only when the buffer starts at page 1 at the newest sort, so
   * the eyebrow's claim stays true under a filter or a re-sort.
   */
  protected readonly showFeatured = computed(
    () => this.idx.sort() === PRODUCT_DEFAULT_SORT && this.idx.firstPage() === 1,
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

  /** Breadcrumb ancestor label per kind (e.g. "Categories"). */
  protected readonly parentLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@taxonomy.browse.breadcrumbs.categories:Categories`;
      case 'audience':
        return $localize`:@@taxonomy.browse.breadcrumbs.audiences:Audiences`;
      case 'phase':
        return $localize`:@@taxonomy.browse.breadcrumbs.phases:Phases`;
      case 'trade':
        return $localize`:@@taxonomy.browse.breadcrumbs.trades:Trades`;
    }
  });

  /**
   * Breadcrumb ancestor link. All three facets have a flat index page since
   * AECI-157 (`/categories`, `/audiences`, `/phases`), so the ancestor always
   * links.
   */
  protected readonly parentLink = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  /** Home, the facet index, then the term. The term is the current page. */
  protected readonly crumbs = computed<BreadcrumbItem[]>(() => [
    homeCrumb(),
    { label: this.parentLabel(), link: this.parentLink() },
    { label: this.term()?.name ?? '' },
  ]);

  protected readonly productCountLabel = computed(() => {
    const count = this.term()?.product_count ?? 0;
    return $localize`:@@taxonomy.browse.products.count:${count}:INTERPOLATION: products`;
  });

  /**
   * Headline for the "nothing tagged yet" panel. Built in TS with `$localize`
   * (not an `i18n` attribute with `{{ }}`) because the term name is dynamic —
   * the same reason `productCountLabel` above lives here.
   */
  protected readonly emptyTermHeadline = computed(() => {
    const name = this.term()?.name ?? '';
    return $localize`:@@taxonomy.browse.emptyTerm.headline:No products are tagged ${name}:NAME: yet.`;
  });
}
