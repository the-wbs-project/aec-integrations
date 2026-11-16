/**
 * `/search` — the faceted, tabbed search experience (AECI-142 / Phase 3.9).
 *
 * Search runs BROWSER-SIDE against Algolia with the search-only key (the API
 * Worker is not in the read path, §7.5). The SSR shell paints meta (noindex) +
 * the search box (seeded from `?q=`) + the entity tablist + an initial state;
 * after hydration, `afterNextRender` reads the injected public config
 * (`window.__AECI_ALGOLIA__`), dynamically loads the search SDK, and starts
 * `SearchController`, which maps InstantSearch connector render state into
 * signals this template binds. Switching tabs is pure show/hide of
 * already-materialized signal slices — it never re-queries.
 *
 * Graceful degradation: when the public config is absent (local dev without
 * Algolia secrets, or any env where search isn't provisioned) the page renders
 * the shell + a "temporarily unavailable" notice and never constructs the
 * controller. This is also the path CI/local-bound e2e exercises (no provisioned
 * key).
 *
 * Caching: `/search` is non-cacheable (`private, no-store`) — it is NOT in
 * `server-runtime.ts`'s `ROUTE_CACHE_PATTERNS`, so it hits the fail-closed
 * default — and `MetaService.setSearchMeta` adds `robots: noindex` (§4.6: search
 * results aren't canonical content).
 *
 * Layout: the page renders inside the shared `BrowseLayout` with the filter rail
 * in the shared `aec-facet-panel`, the same shell, rail width, mobile "Filters"
 * disclosure and card-grid breakpoints as `/products`. It used to hand-roll its
 * own grid, which missed the browse-page fixes (min-width-0 columns, the mobile
 * disclosure) and overflowed at tablet widths.
 *
 * The deliberate §7.5 deviation (`angular-instantsearch` → `instantsearch.js` +
 * connectors → signals) is documented in `search-controller.ts` and ADR 0014.
 * The per-tab sort dropdown (AECI-175 / §4.6) is `aec-listing-sort-select`, the
 * same control `/products` carries, backed by Algolia replica indexes; `?sort=`
 * mirrors it. It offers the `/products` sorts with the same default, and no
 * Relevance (2026-10-26).
 */
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  type ElementRef,
  inject,
  type OnDestroy,
  signal,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  NavigationStart,
  Router,
  RouterLink,
} from '@angular/router';

import { replicaIndexName, sortReplicasFor } from '@aeci/shared/algolia';
import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { Analytics } from '../analytics/analytics';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { BrowseLayout } from '../layouts/browse-layout';
import type { ProductRow } from '../products/product-card';
import { ProductTable, TABLE_HEADER_CELL_CLASS } from '../products/product-table';
import { AecCard } from '../shared/card/card';
import { CompanyFactsNote } from '../shared/company-facts-note/company-facts-note';
import { EmptyState } from '../shared/empty-state/empty-state';
import { FacetPanel } from '../shared/facets/facet-panel';
import { FILTER_LINK_CLASS } from '../shared/facets/filter-row';
import {
  ListingSortSelect,
  type ListingSortOption,
} from '../shared/listing-toolbar/listing-sort-select';
import { createListingView } from '../shared/listing-toolbar/listing-view';
import { ListingViewToggle } from '../shared/listing-toolbar/listing-view-toggle';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { PaginationFooter } from '../shared/pagination/pagination-footer';

import type { AlgoliaPublicConfig } from './algolia-config';
import { readAlgoliaConfig } from './algolia-config';
import { SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import { type IndexView, SearchController } from './search-controller';
import { SearchProductCard } from './search-product-card';
import { SearchVendorCard } from './search-vendor-card';
import { filtersFromParams, filtersToParams, type SearchFilters } from './search-url-state';
import { SearchVendorRow } from './search-vendor-row';
import { SearchNumericMenu } from './widgets/search-numeric-menu';
import { SearchRangeInput } from './widgets/search-range-input';
import { SearchRefinementList } from './widgets/search-refinement-list';
import { isReplayedEvent } from '../core/event-replay';
import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';
import { BROWSE_HEADER_CLASS } from '../layouts/browse-header';
import { FIELD_INPUT_CLASS } from '../shared/form-field/form-field-classes';
import { AecIcon } from '../shared/icon/icon';

// Integrations are intentionally excluded from `/search` for now (product
// decision, 2026-06-11). The `{prefix}_integrations` Algolia index is still
// maintained; to re-enable, add `'integrations'` back here, restore the
// `@case ('integrations')` panel + `tabLabel` branch below, and re-wire the
// integrations index in `search-controller.ts`. See STAGE_1_SPEC.md §7.5.
type EntityTab = 'products' | 'vendors';

const TABS: readonly EntityTab[] = ['products', 'vendors'];

/** Selected refinements on one tab: checked values, a non-"All" bucket, each set range. */
function countFilters(
  view: Pick<IndexView<unknown>, 'refinementLists' | 'numericMenus' | 'ranges'> | null,
): number {
  if (!view) return 0;
  let count = 0;
  for (const rl of view.refinementLists) count += rl.items().filter((i) => i.isRefined).length;
  for (const nm of view.numericMenus) {
    if (nm.items().some((i) => i.isRefined && i.label !== '')) count += 1;
  }
  for (const rg of view.ranges) {
    if (isRangeSet(rg.start())) count += 1;
  }
  return count;
}

/** An Algolia product record in the `/products` table row's shape. */
function toProductRow(record: AlgoliaProductRecord): ProductRow {
  return {
    slug: record.slug,
    name: record.name,
    logo_url: record.logo_url,
    integration_count: record.integration_count,
    review_count: record.review_count,
    rating_overall_avg: record.rating_overall_avg,
    vendor:
      record.vendor_name && record.vendor_slug
        ? { name: record.vendor_name, slug: record.vendor_slug }
        : null,
  };
}

/**
 * True when either side of a range refinement is set. `connectRange` reports an
 * open bound as `undefined` or as `±Infinity`, so both count as unset.
 */
function isRangeSet([min, max]: readonly [number | undefined, number | undefined]): boolean {
  return Number.isFinite(min) || Number.isFinite(max);
}

/** Debounce for mirroring `?q=` into the URL (separate from the search debounce). */
const URL_SYNC_DEBOUNCE_MS = 350;

@Component({
  selector: 'app-search-page',
  imports: [
    AecBreadcrumb,
    AecIcon,
    NgTemplateOutlet,
    RouterLink,
    AecCard,
    BrowseLayout,
    CompanyFactsNote,
    FacetPanel,
    MailingListSignup,
    SearchProductCard,
    SearchVendorCard,
    SearchRefinementList,
    SearchNumericMenu,
    SearchRangeInput,
    PaginationFooter,
    ListingSortSelect,
    ListingViewToggle,
    EmptyState,
    ProductTable,
    SearchVendorRow,
  ],
  template: `
    <aec-browse-layout>
      <!-- The shared browse header (browse-header.ts): breadcrumb, then the h1
           16px below it, sized by the global h1 rule. Then the query box and
           the tabs, both in the header (mock-up 10). -->
      <div slot="header">
        <aec-breadcrumb [items]="crumbs" />
        <h1 [class]="headerClass.title" i18n="@@search.title">Search</h1>
        <!-- The query box on the shared field edge (.aec-field-control, 3:1),
             44px, with a leading search glyph (AECI-1850). The glyph is
             decorative: the label names the field. -->
        <form
          class="relative mt-6 max-w-2xl"
          role="search"
          action="/search"
          method="get"
          (submit)="onSubmit($event)"
        >
          <label class="sr-only" for="search-input" i18n="@@search.input.label"
            >Search the directory</label
          >
          <span
            class="pointer-events-none absolute start-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)"
          >
            <aec-icon name="search" decorative [size]="5" />
          </span>
          <input
            id="search-input"
            name="q"
            type="search"
            autocomplete="off"
            [value]="inputValue()"
            (input)="onQueryInput($event)"
            i18n-placeholder="@@search.input.placeholder"
            placeholder="Search products and vendors"
            [class]="queryInputClass"
          />
        </form>

        @if (!degraded()) {
          <!-- The tablist sits on the header's bottom rule (negative margin = the
               header's bottom padding), so the active tab's underline lands on
               it instead of drawing a second rule. It scrolls sideways rather
               than overflowing the viewport if the labels ever outgrow it. The
               underline colour comes from .aec-nav-tab in styles.css, because
               border-colour utilities lose to the unlayered * rule there.
               Selected: the Forest underline and weight 600, so colour is not
               the only cue (ruling 9 of 2026-11-16). 44px tall. -->
          <div
            role="tablist"
            class="mt-6 -mb-8 flex gap-1 overflow-x-auto md:-mb-10"
            aria-label="Search results by type"
            i18n-aria-label="@@search.tablist.aria"
          >
            @for (tab of tabs; track tab) {
              <button
                #tabBtn
                type="button"
                role="tab"
                [id]="tabId(tab)"
                [attr.aria-selected]="activeTab() === tab"
                [attr.aria-controls]="panelId"
                [tabindex]="activeTab() === tab ? 0 : -1"
                (click)="selectTab(tab)"
                (keydown)="onTabKeydown($event)"
                class="aec-nav-tab min-h-11 shrink-0 cursor-pointer border-b-2 px-4 py-2.5 text-t-14 whitespace-nowrap transition-colors hover:text-(--text-primary) focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--accent-primary)"
                [class.text-(--text-secondary)]="activeTab() !== tab"
                [class.text-(--text-primary)]="activeTab() === tab"
                [class.font-semibold]="activeTab() === tab"
              >
                {{ tabLabel(tab) }}
                @if (countFor(tab); as count) {
                  <span class="ms-1.5 font-normal tabular-nums text-(--text-secondary)">{{
                    count
                  }}</span>
                }
              </button>
            }
          </div>
        }
      </div>

      @if (!degraded()) {
        <aec-facet-panel
          slot="filters"
          panelId="search-facet-panel"
          [activeCount]="activeFilterCount()"
        >
          @if (showSkeleton()) {
            <ng-container [ngTemplateOutlet]="facetsSkeleton" />
          } @else if (currentFacets(); as facets) {
            @for (rl of facets.refinementLists; track rl.attribute) {
              <aec-search-refinement-list
                [label]="facetLabel(rl.attribute)"
                [items]="rl.items()"
                (refine)="rl.refine($event)"
              />
            }
            @for (nm of facets.numericMenus; track nm.attribute) {
              <aec-search-numeric-menu
                [label]="facetLabel(nm.attribute)"
                [name]="activeTab() + ':' + nm.attribute"
                [allLabel]="allLabel"
                [items]="nm.items()"
                (refine)="nm.refine($event)"
              />
            }
            @for (rg of facets.ranges; track rg.attribute) {
              <aec-search-range-input
                [label]="facetLabel(rg.attribute)"
                [name]="activeTab() + ':' + rg.attribute"
                [bounds]="rg.bounds()"
                [start]="rg.start()"
                (refine)="rg.refine($event)"
              />
            }
            @if (anyFilterCount() > 0) {
              <button
                type="button"
                [class]="clearClass"
                (click)="clearFilters()"
                i18n="@@listing.filters.clear"
              >
                Clear filters
              </button>
            }
          }
        </aec-facet-panel>
      }

      <div slot="grid">
        @if (degraded()) {
          <div
            class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) px-6 py-10 text-center"
            role="status"
          >
            <p
              class="text-base font-semibold text-(--text-primary)"
              i18n="@@search.unavailable.title"
            >
              Search is temporarily unavailable.
            </p>
            <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@search.unavailable.body">
              Please try again later, or browse the directory by category.
            </p>
          </div>
        } @else {
          <div
            role="tabpanel"
            [id]="panelId"
            [attr.aria-labelledby]="tabId(activeTab())"
            tabindex="0"
            class="space-y-6 focus-visible:outline-none"
          >
            <!-- Toolbar row, same placement and 44px height as aec-listing-toolbar
                 on /products. min-h reserves it before the controller mounts so
                 the grid does not jump when the sort control appears. -->
            <div class="flex min-h-11 flex-wrap items-center justify-between gap-3">
              @if (controller(); as ctrl) {
                <aec-listing-sort-select
                  [options]="sortUiOptions()"
                  [value]="ctrl[activeTab()].sortBy()"
                  (sortChange)="onSortChange($event)"
                />
              }
              <!-- The /products cards/table toggle, on the end edge as there.
                 ms-auto keeps it right-aligned while the sort control mounts. -->
              <aec-listing-view-toggle
                class="ms-auto"
                [view]="listingView.view()"
                (viewChange)="listingView.set($event)"
              />
            </div>

            <div>
              @if (controller(); as ctrl) {
                <p class="sr-only" role="status" aria-live="polite">
                  {{ resultsStatus() }}
                </p>
                @if (ctrl.ready()) {
                  @switch (activeTab()) {
                    @case ('products') {
                      @if (ctrl.products.hits(); as hits) {
                        @if (hits.length) {
                          <div
                            class="transition-opacity duration-200"
                            [class.opacity-60]="resetting()"
                            [class.pointer-events-none]="resetting()"
                            [attr.aria-busy]="resetting() ? 'true' : null"
                          >
                            @switch (listingView.view()) {
                              @case ('table') {
                                <aec-product-table [rows]="productRows()" />
                              }
                              @default {
                                <ul role="list" class="aec-card-grid">
                                  @for (hit of hits; track hit.objectID) {
                                    <li class="min-w-0">
                                      <aec-search-product-card [record]="hit" />
                                    </li>
                                  }
                                </ul>
                              }
                            }
                          </div>
                          <aec-pagination-footer
                            class="mt-6 block border-t border-(--border-default) pt-6"
                            [loadedCount]="hits.length"
                            [total]="ctrl.products.nbHits()"
                            [hasMore]="ctrl.products.hasMore()"
                            [pending]="ctrl.products.loadingMore()"
                            (loadMore)="ctrl.products.loadMore()"
                          />
                        } @else if (ctrl.error()) {
                          <ng-container [ngTemplateOutlet]="errorState" />
                        } @else {
                          <ng-container [ngTemplateOutlet]="emptyState" />
                        }
                      }
                    }
                    @case ('vendors') {
                      @if (ctrl.vendors.hits(); as hits) {
                        @if (hits.length) {
                          <div
                            class="transition-opacity duration-200"
                            [class.opacity-60]="resetting()"
                            [class.pointer-events-none]="resetting()"
                            [attr.aria-busy]="resetting() ? 'true' : null"
                          >
                            @switch (listingView.view()) {
                              @case ('table') {
                                <!-- The shared product table's frame (product-table.ts):
                                     hairlines only, a rule above the header, one under
                                     it and one under each row (the row draws its own),
                                     header cells at the Label role. -->
                                <div class="overflow-x-auto border-t">
                                  <table
                                    class="w-full border-collapse text-start text-t-14 md:min-w-[36rem]"
                                    i18n-aria-label="@@search.vendors.table.aria"
                                    aria-label="Vendors"
                                  >
                                    <thead>
                                      <tr class="border-b">
                                        <th
                                          scope="col"
                                          [class]="thStart"
                                          i18n="@@search.vendors.col.name"
                                        >
                                          Name
                                        </th>
                                        <th
                                          scope="col"
                                          [class]="thStart + ' hidden md:table-cell'"
                                          i18n="@@search.vendors.col.headquarters"
                                        >
                                          Headquarters
                                        </th>
                                        <th
                                          scope="col"
                                          [class]="thEnd"
                                          i18n="@@search.vendors.col.integrations"
                                        >
                                          Integrations
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      @for (hit of hits; track hit.objectID) {
                                        <tr aec-search-vendor-row [record]="hit"></tr>
                                      }
                                    </tbody>
                                  </table>
                                </div>
                              }
                              @default {
                                <ul role="list" class="aec-card-grid">
                                  @for (hit of hits; track hit.objectID) {
                                    <li class="min-w-0">
                                      <aec-search-vendor-card [record]="hit" />
                                    </li>
                                  }
                                </ul>
                              }
                            }
                          </div>
                          <aec-pagination-footer
                            class="mt-6 block border-t border-(--border-default) pt-6"
                            [loadedCount]="hits.length"
                            [total]="ctrl.vendors.nbHits()"
                            [hasMore]="ctrl.vendors.hasMore()"
                            [pending]="ctrl.vendors.loadingMore()"
                            (loadMore)="ctrl.vendors.loadMore()"
                          />
                        } @else if (ctrl.error()) {
                          <ng-container [ngTemplateOutlet]="errorState" />
                        } @else {
                          <ng-container [ngTemplateOutlet]="emptyState" />
                        }
                      }
                    }
                  }
                } @else if (ctrl.error()) {
                  <!-- The first search failed: nothing will replace the skeleton. -->
                  <ng-container [ngTemplateOutlet]="errorState" />
                } @else {
                  <!-- Mounted, first response pending: reserve space (no aria-busy;
                       the controller-null branch below owns the live-region). -->
                  <ng-container [ngTemplateOutlet]="resultsSkeleton" />
                }
              } @else {
                <!-- SSR + pre-mount. Ships the skeleton in the initial HTML so the
                     height is reserved from first paint and the page is already
                     scrollable. sr-only status carries the busy state for AT. -->
                <p class="sr-only" role="status" aria-busy="true" i18n="@@search.loading">
                  Loading search…
                </p>
                <ng-container [ngTemplateOutlet]="resultsSkeleton" />
              }
            </div>
          </div>
        }

        <aec-company-facts-note class="mt-8 block" />
      </div>
    </aec-browse-layout>

    <aec-mailing-list-signup />

    <!-- Same words and placement as /products' failed load. -->
    <ng-template #errorState>
      <p class="py-12 text-center text-(--text-secondary)" role="alert" i18n="@@search.error">
        Couldn't load results. Refresh to try again.
      </p>
    </ng-template>

    <ng-template #emptyState>
      <aec-empty-state>
        <p i18n="@@search.empty">
          No results. Try a broader search or
          <a routerLink="/categories" [class]="inTextLinkClass">browse by category</a>.
        </p>
      </aec-empty-state>
    </ng-template>

    <!--
      Loading skeletons (AECI-228). Purely decorative (aria-hidden); the sr-only
      status region announces loading/result counts. Each card mirrors the real
      product/vendor card's box (the same aecCard frame, padding and gap) with a
      min height so the skeleton≈real swap barely moves. The pagination footer slot and
      the facet rail reserve their height too, so the first response settles in
      place instead of shoving the page. animate-pulse is auto-neutralized under
      prefers-reduced-motion (styles.css).
    -->
    <ng-template #resultsSkeleton>
      <div aria-hidden="true">
        <ul class="aec-card-grid">
          @for (card of skeletonCards; track card) {
            <li>
              <div aecCard class="flex min-h-32 flex-col gap-4 p-6">
                <div class="flex items-start justify-between gap-3">
                  <div
                    class="h-9 w-9 shrink-0 animate-pulse rounded-(--radius-md) bg-(--surface-sunken)"
                  ></div>
                  <div
                    class="h-6 w-24 animate-pulse rounded-(--radius-sm) bg-(--surface-sunken)"
                  ></div>
                </div>
                <div class="h-6 w-2/3 animate-pulse rounded bg-(--surface-sunken)"></div>
                <div class="h-4 w-1/2 animate-pulse rounded bg-(--surface-sunken)"></div>
              </div>
            </li>
          }
        </ul>
        <div class="mt-6 flex justify-center border-t border-(--border-default) pt-6">
          <div class="h-9 w-48 animate-pulse rounded-(--radius-md) bg-(--surface-sunken)"></div>
        </div>
      </div>
    </ng-template>

    <ng-template #facetsSkeleton>
      <div aria-hidden="true" class="space-y-6">
        @for (group of skeletonFacetGroups; track group) {
          <div class="space-y-2.5">
            <div class="h-4 w-24 animate-pulse rounded bg-(--surface-sunken)"></div>
            @for (row of skeletonFacetRows; track row) {
              <div class="h-3 w-full animate-pulse rounded bg-(--surface-sunken)"></div>
            }
          </div>
        }
      </div>
    </ng-template>
  `,
})
export class SearchPage implements OnDestroy {
  /** The shared browse header parts (AECI-1794). */
  protected readonly headerClass = BROWSE_HEADER_CLASS;

  /**
   * The query box: the shared field recipe (the 3:1 field edge, 44px, 12px
   * radius, 16px text), with 48px start padding for the search glyph
   * (AECI-1850). `ps-12` sorts after the recipe's `px-4`, so it wins.
   */
  protected readonly queryInputClass = `${FIELD_INPUT_CLASS} min-w-0 ps-12`;

  /** The Vendors table's header cells, the shared product table's (`product-table.ts`). */
  protected readonly thStart = `${TABLE_HEADER_CELL_CLASS} text-start`;
  protected readonly thEnd = `${TABLE_HEADER_CELL_CLASS} text-end`;

  /**
   * The empty state's link: the in-text link role (DESIGN.md, the Link Treatment
   * Rule). Underlined at rest, not only on hover, so colour is not its only cue.
   */
  protected readonly inTextLinkClass =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

  /** "Clear filters", the shared filter-panel link (AECI-1793). */
  protected readonly clearClass = FILTER_LINK_CLASS;

  protected readonly crumbs: BreadcrumbItem[] = [
    homeCrumb(),
    { label: $localize`:@@search.breadcrumbs.current:Search` },
  ];

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);
  private readonly engineFactory = inject(SEARCH_ENGINE_FACTORY);
  private readonly analytics = inject(Analytics);

  protected readonly tabs = TABS;
  protected readonly panelId = 'search-tabpanel';
  /** Localized "all / no filter" label shared by every numeric menu. */
  protected readonly allLabel = $localize`:@@search.facet.all:All`;

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  /** Seeded once from `?q=` for the SSR `[value]` and the controller's first query. */
  private readonly initialQuery = this.route.snapshot.queryParamMap.get('q')?.trim() ?? '';

  /** Seeded once from `?sort=` (a sort token, applied to the initial active tab). */
  private readonly initialSortToken = this.route.snapshot.queryParamMap.get('sort')?.trim() ?? '';

  /**
   * Buffers keystrokes typed before the controller mounts. The search SDK loads
   * asynchronously (`afterNextRender` → dynamic `import()`), so for a beat after
   * hydration there is no controller to drive. Seeded equal to `initialQuery`;
   * `onQueryInput` writes here while the controller is null, and the controller
   * replays it on mount so early input is never silently dropped (AECI-227).
   */
  private readonly pendingQuery = signal(this.initialQuery);

  protected readonly controller = signal<SearchController | null>(null);
  /** True once we know the public Algolia config is absent (browser-only). */
  protected readonly degraded = signal(false);
  protected readonly activeTab = signal<EntityTab>(this.initialTab());

  private urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /** Input value: the controller's live query once started, else the buffered input. */
  protected readonly inputValue = computed(() => this.controller()?.query() ?? this.pendingQuery());

  /** The active tab's facet views (same shape across entities). */
  protected readonly currentFacets = computed(() => {
    const ctrl = this.controller();
    return ctrl ? ctrl[this.activeTab()] : null;
  });

  /**
   * True while the results region should render skeletons rather than real
   * facets/results — i.e. before the controller mounts (SSR + pre-mount) AND
   * after it mounts but before the first response settles. Reserving the
   * height across both windows is what keeps the first paint from shifting
   * (AECI-228).
   */
  protected readonly showSkeleton = computed(() => {
    const ctrl = this.controller();
    return !ctrl || !ctrl.ready();
  });

  /**
   * Selected refinements on the active tab: checked list values, a non-"All"
   * numeric bucket, and each bound of a range. Drives the mobile "Filters"
   * badge and the "Clear filters" action, as `aec-facet-sidebar` does on
   * `/products`.
   */
  protected readonly activeFilterCount = computed(() => countFilters(this.currentFacets()));

  /**
   * Selected refinements across BOTH tabs. Shows "Clear filters", which clears
   * both, so a filter left on the hidden tab can still be cleared from here.
   */
  protected readonly anyFilterCount = computed(() => {
    const ctrl = this.controller();
    return ctrl ? countFilters(ctrl.products) + countFilters(ctrl.vendors) : 0;
  });

  /** `?view=` cards/table, shared with `/products` and the browse pages. */
  protected readonly listingView = createListingView();

  /** Products hits in the `/products` table row's shape, for the table view. */
  protected readonly productRows = computed<ProductRow[]>(() => {
    const ctrl = this.controller();
    return ctrl ? ctrl.products.hits().map(toProductRow) : [];
  });

  /**
   * Dim the grid only while a query, facet or sort change re-runs page 1, as
   * `/products` does for its reset refetch. Loading MORE pages never dims: the
   * loaded cards stay bright and only the footer shows a spinner.
   */
  protected readonly resetting = computed(() => {
    const ctrl = this.controller();
    return !!ctrl && ctrl.stalled() && !ctrl[this.activeTab()].loadingMore();
  });

  /** Fixed-length arrays driving the skeleton `@for` loops (index = track key). */
  protected readonly skeletonCards = [0, 1, 2, 3, 4, 5];
  protected readonly skeletonFacetGroups = [0, 1, 2, 3];
  protected readonly skeletonFacetRows = [0, 1, 2, 3];

  protected readonly resultsStatus = computed(() => {
    const ctrl = this.controller();
    if (!ctrl) return '';
    const count = ctrl[this.activeTab()].nbHits();
    return $localize`:@@search.results.status:${count}:COUNT: results`;
  });

  /** The active tab's sort options, with the `key` token mapped to a localized
   *  label, for the sort control (AECI-175). Empty until the controller mounts. */
  protected readonly sortUiOptions = computed<readonly ListingSortOption[]>(() => {
    const ctrl = this.controller();
    if (!ctrl) return [];
    return ctrl[this.activeTab()].sortOptions.map((option) => ({
      value: option.value,
      label: this.sortLabel(option.key),
    }));
  });

  constructor() {
    // SSR + client: set the noindex/title/canonical so it ships in the initial
    // HTML head and is refreshed on an in-app nav onto /search.
    this.meta.setSearchMeta({ canonical: canonicalUrl('/search') });

    // Back / Forward: the URL changed under us, so bring the search to it. Only
    // on popstate. Our own navigations already match the state they wrote,
    // and a debounced `?q=` write must never pull the box back mid-typing.
    let popstate = false;
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) popstate = event.navigationTrigger === 'popstate';
      else if (event instanceof NavigationEnd && popstate) {
        popstate = false;
        this.restoreFromUrl();
      }
    });

    // Browser-only: read the injected public config, load the SDK, start search.
    afterNextRender(() => {
      const config = readAlgoliaConfig();
      if (!config) {
        this.degraded.set(true);
        return;
      }
      void this.engineFactory(config)
        .then(({ lib, searchClient }) => {
          if (this.destroyed) return;
          const controller = new SearchController(
            lib,
            searchClient,
            config,
            this.initialQuery,
            this.initialSort(config),
            (event) => this.analytics.searchPerformed(event),
            {
              initialFilters: filtersFromParams(this.route.snapshot.queryParamMap),
              onFiltersChange: (filters) => this.writeFilters(filters),
            },
          );
          controller.start();
          // Replay anything typed while the SDK was loading. `onQueryInput`
          // buffered it in `pendingQuery` because there was no controller yet.
          // Replay BEFORE exposing the controller signal so `inputValue` reads
          // the controller's query as `pending` (no flicker back to the seed).
          const pending = this.pendingQuery();
          if (pending !== this.initialQuery) controller.setQuery(pending);
          this.controller.set(controller);
        })
        .catch((error: unknown) => {
          // Search must never break the page — degrade to the unavailable notice.
          console.warn('Search failed to initialise', error);
          this.degraded.set(true);
        });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.controller()?.dispose();
  }

  protected onQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const controller = this.controller();
    if (controller) {
      controller.setQuery(value);
    } else {
      // SDK still loading — buffer the input; the controller replays it on mount.
      this.pendingQuery.set(value);
    }
    this.scheduleUrlSync(value);
  }

  /** Native form submit (no-JS fallback navigates to `/search?q=`). */
  protected onSubmit(event: Event): void {
    if (isReplayedEvent(event)) return; // the native default already ran
    event.preventDefault();
  }

  protected selectTab(tab: EntityTab): void {
    if (this.activeTab() === tab) return;
    this.activeTab.set(tab);
    // Default tab (products) drops `?tab=`; others set it. `?sort=` is per-tab, so
    // it re-points at the newly-active tab's current sort (its default → cleared).
    const sort = this.currentSortToken(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        tab: tab === 'products' ? null : tab,
        sort: sort === defaultSortToken(tab) ? null : sort,
      },
      queryParamsHandling: 'merge',
      // A history step, so Back returns to the previous tab, as Back steps
      // through filter and sort changes on /products. No scroll jump.
      scroll: 'manual',
    });
  }

  /**
   * Drop every refinement on BOTH tabs, as "Clear filters" on `/products` clears
   * everything. Each connector's own `refine` does the work: toggling a checked
   * value unchecks it, the empty-label bucket is the numeric menu's "All", and
   * an open range clears it. InstantSearch batches the resulting state changes
   * into one search.
   */
  protected clearFilters(): void {
    const ctrl = this.controller();
    if (!ctrl) return;
    for (const view of [ctrl.products, ctrl.vendors]) {
      for (const rl of view.refinementLists) {
        for (const item of rl.items()) if (item.isRefined) rl.refine(item.value);
      }
      for (const nm of view.numericMenus) {
        const all = nm.items().find((i) => i.label === '');
        if (all && !all.isRefined) nm.refine(all.value);
      }
      for (const rg of view.ranges) {
        if (isRangeSet(rg.start())) rg.refine([undefined, undefined]);
      }
    }
  }

  /** Apply a sort to the active tab and mirror it to `?sort=` (AECI-175). */
  protected onSortChange(indexName: string): void {
    const ctrl = this.controller();
    if (!ctrl) return;
    const view = ctrl[this.activeTab()];
    view.refineSort(indexName);
    const tab = this.activeTab();
    const token =
      view.sortOptions.find((option) => option.value === indexName)?.key ?? defaultSortToken(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sort: token === defaultSortToken(tab) ? null : token },
      queryParamsHandling: 'merge',
      // A history step, as on /products. No scroll jump.
      scroll: 'manual',
    });
  }

  /** The active sort token for a tab (a `REPLICA_SORTS` token). */
  private currentSortToken(tab: EntityTab): string {
    const ctrl = this.controller();
    if (!ctrl) return defaultSortToken(tab);
    const view = ctrl[tab];
    return (
      view.sortOptions.find((option) => option.value === view.sortBy())?.key ??
      defaultSortToken(tab)
    );
  }

  /** Localized label for a sort token. */
  private sortLabel(key: string): string {
    switch (key) {
      // The /products labels and ids, so the same sort reads the same on both
      // pages (`productSortOptions()`).
      case 'name':
        return $localize`:@@listing.sort.name:Name (A–Z)`;
      case 'created':
        return $localize`:@@listing.sort.newest:Newest`;
      case 'updated':
        return $localize`:@@listing.sort.updated:Recently updated`;
      case 'rating':
        return $localize`:@@listing.sort.rating:Highest rated`;
      case 'reviews':
        return $localize`:@@listing.sort.reviews:Most reviewed`;
      default:
        return key;
    }
  }

  /**
   * Resolve the inbound `?sort=` token into a per-tab initial index name for the
   * controller, applied to the initial active tab only (the URL carries one sort,
   * scoped to the visible tab). An absent or unknown token seeds nothing, so the
   * controller starts the tab on its default replica. That is how a retired
   * token such as `integrations` (AECI-636 PR-B) or `relevance` (2026-10-26)
   * falls back to the default sort without an error.
   */
  private initialSort(config: AlgoliaPublicConfig): Partial<Record<EntityTab, string>> {
    const tab = this.activeTab();
    const token = this.initialSortToken;
    if (!token) return {};
    const replica = sortReplicasFor(tab).find((sort) => sort.sort === token);
    if (!replica) return {};
    return { [tab]: replicaIndexName(config.indexes[tab], replica.suffix) };
  }

  /** APG tabs: ←/→ move + activate, Home/End jump to the ends. */
  protected onTabKeydown(event: KeyboardEvent): void {
    if (isReplayedEvent(event)) return; // the native default already ran
    const current = this.tabs.indexOf(this.activeTab());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % this.tabs.length;
        break;
      case 'ArrowLeft':
        next = (current - 1 + this.tabs.length) % this.tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectTab(this.tabs[next]);
    this.tabButtons()[next]?.nativeElement.focus();
  }

  protected countFor(tab: EntityTab): number | null {
    const ctrl = this.controller();
    return ctrl ? ctrl[tab].nbHits() : null;
  }

  protected tabId(tab: EntityTab): string {
    return `search-tab-${tab}`;
  }

  protected tabLabel(tab: EntityTab): string {
    switch (tab) {
      case 'products':
        return $localize`:@@search.tab.products:Products`;
      case 'vendors':
        return $localize`:@@search.tab.vendors:Vendors`;
    }
  }

  /** Localized facet heading for a faceting attribute (§7.2). */
  protected facetLabel(attribute: string): string {
    switch (attribute) {
      case 'categories':
        return $localize`:@@search.facet.categories:Categories`;
      case 'audiences':
        return $localize`:@@search.facet.audiences:Audiences`;
      case 'phases':
        return $localize`:@@search.facet.phases:Phases`;
      case 'trades':
        return $localize`:@@search.facet.trades:Trades`;
      case 'vendor_name':
        return $localize`:@@search.facet.vendor:Vendor`;
      case 'founded_year':
        return $localize`:@@search.facet.founded:Founded`;
      case 'product_count':
        return $localize`:@@search.facet.products:Products`;
      case 'integration_count':
        return $localize`:@@search.facet.integrations:Integrations`;
      case 'mechanism_kind':
        return $localize`:@@search.facet.mechanism:Mechanism`;
      case 'direction':
        return $localize`:@@search.facet.direction:Direction`;
      case 'source_product_name':
        return $localize`:@@search.facet.sourceProduct:Source product`;
      case 'target_product_name':
        return $localize`:@@search.facet.targetProduct:Target product`;
      default:
        return attribute;
    }
  }

  /** A filter change from the search: one history step, no scroll jump. */
  private writeFilters(filters: SearchFilters): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filtersToParams(filters),
      queryParamsHandling: 'merge',
      scroll: 'manual',
    });
  }

  /**
   * After Back / Forward, apply the URL's tab, query, sort and filters. Each
   * part is compared first, so an unchanged part triggers no search.
   */
  private restoreFromUrl(): void {
    const params = this.route.snapshot.queryParamMap;
    const tab: EntityTab = params.get('tab') === 'vendors' ? 'vendors' : 'products';
    this.activeTab.set(tab);
    const ctrl = this.controller();
    if (!ctrl) return;
    const q = params.get('q')?.trim() ?? '';
    if (q !== ctrl.query()) ctrl.setQuery(q);
    const view = ctrl[tab];
    // An absent or unknown token restores the default, the first option.
    const token = params.get('sort');
    const target = view.sortOptions.find((option) => option.key === token) ?? view.sortOptions[0];
    if (target && target.value !== view.sortBy()) view.refineSort(target.value);
    ctrl.setFilters(filtersFromParams(params));
  }

  private initialTab(): EntityTab {
    const raw = this.route.snapshot.queryParamMap.get('tab');
    return raw === 'vendors' ? raw : 'products';
  }

  private scheduleUrlSync(value: string): void {
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.urlSyncTimer = setTimeout(() => {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { q: value || null },
        queryParamsHandling: 'merge',
        // Typing replaces the entry: Back should not step through every pause.
        replaceUrl: true,
        scroll: 'manual',
      });
    }, URL_SYNC_DEBOUNCE_MS);
  }
}

/**
 * A tab's default sort token: its first replica, so `/search` opens on the same
 * sort as `/products` (`created`, Newest) and the Vendors tab on `name`. The URL
 * omits `?sort=` only for this token.
 */
function defaultSortToken(tab: EntityTab): string {
  return sortReplicasFor(tab)[0]?.sort ?? '';
}
