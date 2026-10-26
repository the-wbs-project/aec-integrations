/**
 * The InstantSearch → Angular-signals adapter behind `/search` (AECI-142).
 *
 * THE DEVIATION (documented): spec §7.5 calls for `angular-instantsearch` v4+.
 * That package hard-caps its peer dep at `@angular/core <16`, is deprecated, and
 * Algolia's own docs state it "isn't compatible with the latest Angular
 * versions." This repo is Angular 22 (zoneless, standalone, SSR). The modern
 * path Algolia recommends — and what this controller implements — is
 * **`instantsearch.js` (vanilla) + connectors**, with each connector's render
 * callback pushed into an Angular **signal**. Signal writes schedule change
 * detection, so it's zoneless-safe; the heavy SDK is dynamically `import()`ed in
 * the browser only (see `search-controller.factory.ts`), so it's SSR-safe. ADR
 * 0014 records the rationale.
 *
 * ARCHITECTURE — one root `instantsearch()` with NO index of its own, holding the
 * shared `searchBox`, plus two sibling nested `index()` widgets (`products`,
 * `vendors`). A root without an `indexName` sends no query, so that is exactly
 * two index queries batched into one multi-query request per keystroke. The
 * indexes are siblings, not parent and child, because a nested index inherits
 * its parent's refinements: with `products` as the root, a products category
 * filter was sent to the vendors index too and emptied the Vendors tab. Both
 * siblings still inherit the root's query, which is the one thing they share.
 * Each index owns its own infinite hits + stats + facets; the per-tab result count is just that index's
 * `connectStats.nbHits`. One `dispose()` tears it all down. Tabs in the page are
 * pure show/hide of already-materialized signal slices — switching tabs never
 * re-queries.
 *
 * NOTE — integrations are intentionally NOT queried here (product decision,
 * 2026-06-11): the `{prefix}_integrations` index is still maintained by the API
 * sync, but `/search` does not surface it for now. Re-enable by wiring a third
 * nested `index()` for `config.indexes.integrations` plus its `FACET_CONFIG`
 * entry, and restoring the Integrations tab in `search-page.ts`.
 *
 * URL policy (2026-10-26): this controller does NOT use instantsearch's history
 * router, because the Angular router owns the URL. Instead it reports filter
 * changes (`urlState.onFiltersChange`) for the page to write, and applies the
 * URL's filters on Back/Forward (`setFilters`). The mapping is
 * `search-url-state.ts`. Filters used to stay in memory, after the caching rule's
 * "query-string explosion"; `/search` is uncached and noindex, so that never
 * applied to the URL (ADR 0014 amendment).
 *
 * TESTABILITY — the impure `import('instantsearch.js')` / `import('algoliasearch/lite')`
 * lives in the factory. This class takes a structural `InstantSearchLib` +
 * `searchClient`, so the unit test passes fakes and asserts connector
 * registration, render-state → signal mapping, debounce, and `dispose()` without
 * any network or real SDK.
 *
 * Spec: `STAGE_1_SPEC.md` §4.6 (page UX), §7.1 (record shapes), §7.2 (facets),
 * §7.5 (integration). Mirrors the browser-only,
 * dynamic-import discipline of `apps/web/src/app/analytics/posthog-client.ts`.
 */
import { type Signal, type WritableSignal, signal } from '@angular/core';

import { replicaIndexName, sortReplicasFor } from '@aeci/shared/algolia';
import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import type { RefinementItem } from '../shared/facets/refinement-item';

import type { AlgoliaPublicConfig } from './algolia-config';
import { orderFacetItems } from './search-facet-order';
import {
  emptyFilters,
  filtersFromUiState,
  sameFilters,
  type SearchFilters,
} from './search-url-state';
import { resultsBucket, type ResultsBucket, type SearchStatus } from './search-telemetry';

// ─── Public signal-backed view models ───────────────────────────────────────

// `RefinementItem` now lives in `app/shared/facets/refinement-item.ts` (AECI-143)
// so the API-backed listing sidebar can reuse it without importing this Algolia
// controller. Re-exported here so existing `from '../search-controller'` imports
// keep resolving.
export type { RefinementItem };

/** A refinement-list facet: its attribute + reactive items + a `refine` toggle. */
export interface RefinementListView {
  readonly attribute: string;
  readonly items: Signal<RefinementItem[]>;
  readonly canRefine: Signal<boolean>;
  refine(value: string): void;
}

/** One bucket in a numeric menu (e.g. integration_count `1–10`). */
export interface NumericMenuItem {
  /** Opaque encoded value the connector round-trips back through `refine`. */
  readonly value: string;
  /** Bucket label from config (`''` marks the "all / no filter" option). */
  readonly label: string;
  readonly isRefined: boolean;
}

/** A numeric menu facet (count buckets over a numeric attribute). */
export interface NumericMenuView {
  readonly attribute: string;
  readonly items: Signal<NumericMenuItem[]>;
  refine(value: string): void;
}

/** A numeric range facet (e.g. vendor `founded_year`). */
export interface RangeView {
  readonly attribute: string;
  /** Index-wide `{ min, max }` bounds for placeholders; `undefined` until loaded. */
  readonly bounds: Signal<{ min?: number; max?: number }>;
  /** Current `[min, max]` refinement; either side `undefined` when open. */
  readonly start: Signal<[number | undefined, number | undefined]>;
  readonly canRefine: Signal<boolean>;
  refine(values: [number | undefined, number | undefined]): void;
}

/**
 * One sort choice on a tab (AECI-175). `value` is the physical Algolia replica
 * index name `connectSortBy` switches to; `key` is the `REPLICA_SORTS` token
 * (`created`, `name`, …) the page maps to a localized label and to `?sort=`.
 */
export interface SortOption {
  readonly value: string;
  readonly key: string;
}

/** Everything one entity tab binds to. `T` is the entity's denormalized record. */
export interface IndexView<T> {
  readonly entity: 'products' | 'vendors';
  /**
   * Every hit loaded so far. `connectInfiniteHits` accumulates pages, so this
   * grows as `loadMore()` runs and resets to page 1 on any query, facet or sort
   * change: the same append-mode listing `/products` uses.
   */
  readonly hits: Signal<T[]>;
  readonly nbHits: Signal<number>;
  /** Whether more pages remain after the ones in `hits`. */
  readonly hasMore: Signal<boolean>;
  /** True from `loadMore()` until the next page lands (drives the footer spinner). */
  readonly loadingMore: Signal<boolean>;
  /** Append the next page. No-op while a page is in flight or none remain. */
  loadMore(): void;
  readonly refinementLists: readonly RefinementListView[];
  readonly numericMenus: readonly NumericMenuView[];
  readonly ranges: readonly RangeView[];
  /** The active sort's physical replica index name (AECI-175). */
  readonly sortBy: Signal<string>;
  /** Switch the tab's sort (pass a `SortOption.value`, i.e. an index name). */
  refineSort(indexName: string): void;
  /** The tab's available sorts, the default first (`sortReplicasFor` order). */
  readonly sortOptions: readonly SortOption[];
}

// ─── Structural SDK surface (injected; real impl in the factory) ─────────────

/** Opaque InstantSearch widget handle. */
export type IsWidget = unknown;

/** A target widgets can be added to: the root instance or a nested `index()`. */
export interface WidgetHost {
  addWidgets(widgets: IsWidget[]): unknown;
}

/** InstantSearch's UI state: one entry per index id (`products`, `vendors`). */
export type UiState = Record<string, Record<string, unknown>>;

export interface InstantSearchInstance extends WidgetHost {
  start(): void;
  dispose(): void;
  /** Replace the UI state (or derive it from the current one) and search. */
  setUiState(next: UiState | ((current: UiState) => UiState)): void;
  /**
   * Subscribe to the instance error event. A failed search surfaces here, not
   * through any connector render, so this is the only hook for the
   * `status: 'error'` emit. `instantsearch.js` emits `'error'` with the thrown
   * error on the payload.
   */
  on(event: 'error', handler: (payload: { error: Error }) => void): void;
}

/** Render-state shapes (the subset of each connector's output we consume). */
export interface SearchBoxRenderState {
  query: string;
  refine(query: string): void;
  isSearchStalled: boolean;
}
export interface InfiniteHitsRenderState {
  /** Hits for every page loaded so far, in order. */
  items: readonly unknown[];
  isLastPage: boolean;
  showMore(): void;
  /** The response these items came from; a new object only when a search lands. */
  results?: unknown;
}
export interface StatsRenderState {
  nbHits: number;
  /** Algolia server-side processing time, ms — `search_performed.duration_ms`. */
  processingTimeMS: number;
}
export interface RefinementListRenderState {
  items: readonly RefinementItem[];
  canRefine: boolean;
  refine(value: string): void;
}
export interface NumericMenuRenderState {
  items: readonly NumericMenuItem[];
  refine(value: string): void;
}
export interface RangeRenderState {
  start: readonly [number | undefined, number | undefined];
  range: { min?: number; max?: number };
  canRefine: boolean;
  refine(values: readonly [number | undefined, number | undefined]): void;
}
export interface SortByRenderState {
  /** The currently-active index name (the primary, or a replica). */
  currentRefinement: string;
  options: readonly { label: string; value: string }[];
  refine(value: string): void;
}

type Renderer<S> = (state: S, isFirstRender: boolean) => void;
type Connector<S, P> = (renderFn: Renderer<S>, unmountFn?: () => void) => (params: P) => IsWidget;

/**
 * Payload for the PostHog `search_performed` event (§14.1, AECI-239).
 *
 * `status` / `duration_ms` / `results_bucket` were re-homed here from the
 * `aeci.search.query` Datadog RUM action (AECI-643,
 * `docs/POSTHOG_MIGRATION_SPEC.md` §3.9). AECI-651 then deleted that action
 * along with the rest of the Datadog leg, so this event is now the ONLY carrier
 * of the signal.
 *
 * Two accepted narrowings, both recorded in §3.8 rather than discovered later:
 *   - the RUM action saw EVERY search; this event only reaches the consented
 *     slice (`Analytics.capture` gates on `'granted'`);
 *   - RUM emitted per index with that index's `nbHits`; this event is federated,
 *     so `results_bucket` buckets `results_count` (products + vendors) through
 *     the same `resultsBucket()` helper, and `duration_ms` is the products
 *     index's `processingTimeMS`.
 *
 * The per-index narrowing is largely closed by `results_products` /
 * `results_vendors` (AECI-649 follow-up), which carry each index's own
 * `nbHits` on the SAME event. That deliberately is NOT the RUM shape: RUM fired
 * once *per index*, so restoring it literally would mean two events per search
 * and `search_performed` would stop meaning "a search" — which is the first step
 * of the activation funnel (`docs/ANALYTICS.md` §6). One event with per-index
 * counts answers the question RUM's `index` dimension answered ("which entity
 * type did this query find?") without changing what the event counts.
 *
 * Note there are only TWO indexes here, not three: this controller runs the
 * products and vendors indexes. Integrations are not searched from
 * `/search`, so there is no `results_integrations`.
 */
export interface SearchPerformedEvent {
  readonly query: string;
  /** Best-effort federated total (products + vendors `nbHits`). */
  readonly results_count: number;
  /** The products index's own `nbHits` — the per-index split RUM used to carry. */
  readonly results_products: number;
  /** The vendors index's own `nbHits`. */
  readonly results_vendors: number;
  /** Distinct facet attributes with an active refinement at search time. */
  readonly filters_applied: readonly string[];
  /** Whether the query settled or the multi-query failed as a unit. */
  readonly status: SearchStatus;
  /** Algolia `processingTimeMS` for the products index; 0 for a failure. */
  readonly duration_ms: number;
  /** Coarse bucket over `results_count`, keeping the property low-cardinality. */
  readonly results_bucket: ResultsBucket;
}

/** Emit seam for `search_performed` — injectable so tests assert without the SDK. */
export type SearchPerformedEmitter = (event: SearchPerformedEvent) => void;

/** The minimal `instantsearch.js` surface this controller drives. */
export interface InstantSearchLib {
  instantsearch(opts: {
    /** Omitted on `/search`: the root holds only the shared search box. */
    indexName?: string;
    searchClient: unknown;
    future?: { preserveSharedStateOnUnmount?: boolean };
    /** Filters to start on, from the URL. */
    initialUiState?: UiState;
    /** Called on every UI-state change; must pass the state on via `setUiState`. */
    onStateChange?: (params: { uiState: UiState; setUiState: (next: UiState) => void }) => void;
  }): InstantSearchInstance;
  /** `indexId` keys the index in the UI state; it stays put when a sort swaps `indexName`. */
  index(opts: { indexName: string; indexId?: string }): WidgetHost;
  configure(params: Record<string, unknown>): IsWidget;
  connectSearchBox: Connector<
    SearchBoxRenderState,
    { queryHook?: (query: string, search: (value: string) => void) => void }
  >;
  connectInfiniteHits: Connector<InfiniteHitsRenderState, Record<string, unknown>>;
  connectStats: Connector<StatsRenderState, Record<string, unknown>>;
  connectRefinementList: Connector<
    RefinementListRenderState,
    { attribute: string; limit?: number; operator?: 'or' | 'and'; sortBy?: string[] }
  >;
  connectNumericMenu: Connector<
    NumericMenuRenderState,
    { attribute: string; items: { label: string; start?: number; end?: number }[] }
  >;
  connectRange: Connector<RangeRenderState, { attribute: string }>;
  connectSortBy: Connector<SortByRenderState, { items: { label: string; value: string }[] }>;
}

// ─── Facet configuration (§7.2) ──────────────────────────────────────────────

/**
 * §7.2 integration/product/vendor count buckets `0 / 1–10 / 11–50 / 51+`, plus a
 * leading "all" option (empty label → the widget renders a localized "All").
 * Numbers/punctuation only, so the labels are data, not translatable prose.
 */
const COUNT_BUCKETS: { label: string; start?: number; end?: number }[] = [
  { label: '' },
  { label: '0', start: 0, end: 0 },
  { label: '1–10', start: 1, end: 10 },
  { label: '11–50', start: 11, end: 50 },
  { label: '51+', start: 51 },
];

interface FacetConfig {
  refinementLists: readonly string[];
  numericMenus: readonly {
    attribute: string;
    items: { label: string; start?: number; end?: number }[];
  }[];
  ranges: readonly string[];
}

/**
 * Per-entity facets, matching `INDEX_SETTINGS.attributesForFaceting` in
 * `packages/shared/src/algolia.ts` (§7.2), with one deliberate omission:
 * vendor `headquarters` stays faceted in the index but has no filter here
 * (removed 2026-10-24). The values are free text, so one city appeared as
 * "San Francisco, CA", "San Francisco, USA" and "San Francisco, United States".
 * Restore it once headquarters is normalized upstream. `has_api_docs` is faceted as
 * a boolean refinement list; the page maps its `true`/`false` values to a
 * localized yes/no.
 *
 * `trades` is the fourth taxonomy facet (AECI-545 / §5.5a) and sits fourth here
 * for the same reason it sits fourth in the settings. It is NOT gated by the
 * `TRADE_PUBLISH_MIN_PRODUCTS` publication floor: Algolia facet values are
 * query-scoped (a trade only appears when it actually matches the current
 * results) and `/search` is `noindex` + `no-store`, so the floor's SEO rationale
 * doesn't apply. The floor governs the API-backed sidebar and nav instead
 * (AECI-546, `TRADES_VOCABULARY.md` §6). Note `trade_aliases` is deliberately
 * absent — it is searchable-only matching metadata, never a facet.
 */
const FACET_CONFIG: Record<'products' | 'vendors', FacetConfig> = {
  products: {
    refinementLists: ['categories', 'audiences', 'phases', 'trades', 'vendor_name', 'has_api_docs'],
    numericMenus: [{ attribute: 'integration_count', items: COUNT_BUCKETS }],
    ranges: [],
  },
  vendors: {
    refinementLists: [],
    numericMenus: [
      { attribute: 'product_count', items: COUNT_BUCKETS },
      { attribute: 'integration_count', items: COUNT_BUCKETS },
    ],
    ranges: ['founded_year'],
  },
};

/** The facet attributes a tab exposes, by widget kind (for the URL mapping). */
export function facetAttributesFor(entity: 'products' | 'vendors'): {
  refinementLists: readonly string[];
  numericMenus: readonly string[];
  ranges: readonly string[];
} {
  const config = FACET_CONFIG[entity];
  return {
    refinementLists: config.refinementLists,
    numericMenus: config.numericMenus.map((menu) => menu.attribute),
    ranges: config.ranges,
  };
}

/** Page size per entity tab: 24, the same as `/products` (`STAGE_1_PHASE_2_SPEC.md` §7.1). */
const HITS_PER_PAGE = 24;
/** Search-as-you-type debounce, ms (§ plan: ~150–200ms). */
const QUERY_DEBOUNCE_MS = 200;
/**
 * Values Algolia returns per refinement list: 100, Algolia's default
 * `maxValuesPerFacet`, so the cap is the index's and not ours. The widget shows
 * the top 10 and "Show more" reveals the rest (2026-10-26). It was 12, which
 * silently dropped the 13th category onward with no way to reach it. Only
 * `vendor_name` can exceed 100; past that it shows the 100 vendors with the
 * most matching products.
 */
const REFINEMENT_LIST_LIMIT = 100;

// ─── Controller ──────────────────────────────────────────────────────────────

/**
 * Owns the root `instantsearch()` + the two index views and maps every
 * connector's render callback into a signal. NOT `providedIn:'root'` — it is
 * constructed only in the browser (inside `afterNextRender`), so SSR never
 * builds it.
 */
export class SearchController {
  /** Current search text (mirrored eagerly on input; see `setQuery`). */
  readonly query: WritableSignal<string>;
  /** True while a search is taking long enough to be flagged stalled. */
  readonly stalled = signal(false);
  /**
   * True after a search fails, until the next response lands. The page shows
   * the `/products` "Couldn't load" message when there are no results on
   * screen; a failed load of a LATER page keeps the loaded results instead.
   */
  readonly error = signal(false);
  /**
   * Flips `true` once the first search RESPONSE has landed (the first
   * non-initial `connectInfiniteHits` render). Until then `hits()` is `[]` — which is
   * indistinguishable from a genuine zero-result search — so the page would
   * otherwise flash the empty-state before results arrive. The page gates its
   * skeletons on this so it reserves space until results actually settle
   * (AECI-228).
   */
  readonly ready = signal(false);

  readonly products: IndexView<AlgoliaProductRecord>;
  readonly vendors: IndexView<AlgoliaVendorRecord>;

  private readonly search: InstantSearchInstance;
  private searchBoxRefine: ((value: string) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  /** Last query a `search_performed` was emitted for — dedupes to one per query. */
  private lastSearchEmittedFor: string | null = null;
  /** One per index: clears its `loadingMore` when a search fails. */
  private readonly loadingMoreResets: (() => void)[] = [];
  private readonly onFiltersChange: (filters: SearchFilters) => void;
  /** The filters last seen or applied, to tell a filter change from any other. */
  private lastFilters: SearchFilters;

  constructor(
    private readonly lib: InstantSearchLib,
    searchClient: unknown,
    config: AlgoliaPublicConfig,
    initialQuery = '',
    /**
     * Initial sort per tab (AECI-175): a physical index name to start that tab's
     * index widget on, so an inbound `?sort=` renders the right order on first
     * paint. Omitted entries default to the entity's first replica (Newest for
     * products, Name for vendors). The page resolves the `?sort=` token → index
     * name before passing it here.
     */
    initialSort: Partial<Record<'products' | 'vendors', string>> = {},
    /** PostHog `search_performed` emit seam (AECI-239); defaults to a no-op so
     *  the controller stays decoupled from Angular DI (the page wires it). */
    private readonly onSearch: SearchPerformedEmitter = () => undefined,
    /**
     * The URL half of the filter state (2026-10-26): the filters to start on,
     * and a callback for each filter change, which the page writes to the URL.
     * Typing, paging and sort changes do not call it; only filters do.
     */
    urlState: {
      initialFilters?: SearchFilters;
      onFiltersChange?: (filters: SearchFilters) => void;
    } = {},
  ) {
    this.query = signal(initialQuery);
    this.onFiltersChange = urlState.onFiltersChange ?? (() => undefined);
    // Start from the URL's filters (or none), so the first keystroke, which
    // also changes the UI state, is not mistaken for a filter change.
    this.lastFilters = urlState.initialFilters ?? emptyFilters();

    // The root has no index (it sends no query); products and vendors are
    // sibling nested `index()` widgets so neither inherits the other's filters
    // (see file header). That is two index queries (integrations intentionally
    // not queried). Each index widget STARTS on a replica: the one `?sort=` asked
    // for, else the entity's default. Never the primary, which has no sort option
    // (2026-10-26) and would leave `connectSortBy` on an index it does not list.
    const productsStart =
      initialSort.products ?? defaultSortIndex(config.indexes.products, 'products');
    const vendorsStart = initialSort.vendors ?? defaultSortIndex(config.indexes.vendors, 'vendors');
    const initial = urlState.initialFilters;
    this.search = lib.instantsearch({
      searchClient,
      future: { preserveSharedStateOnUnmount: true },
      ...(initial
        ? {
            initialUiState: {
              products: { ...initial.products },
              vendors: { ...initial.vendors },
            },
          }
        : {}),
      // Pass every change straight through, and tell the page when the FILTER
      // part moved. Comparing against the last known filters keeps typing,
      // paging, sorting and our own `setFilters` from firing it.
      onStateChange: ({ uiState, setUiState }) => {
        setUiState(uiState);
        const filters = filtersFromUiState(uiState);
        if (sameFilters(filters, this.lastFilters)) return;
        this.lastFilters = filters;
        this.onFiltersChange(filters);
      },
    });

    const searchBox = lib.connectSearchBox((state) => {
      // Capture `refine` (and the stalled flag); we drive the query signal from
      // `setQuery` directly so the input never lags behind the debounced search.
      this.searchBoxRefine = state.refine;
      this.stalled.set(state.isSearchStalled);
    })({
      // Debounce the *network* search; `refine(value)` routes through this hook,
      // so the input updates instantly while queries coalesce.
      queryHook: (value, runSearch) => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => runSearch(value), QUERY_DEBOUNCE_MS);
      },
    });

    const productsHost = lib.index({ indexName: productsStart, indexId: 'products' });
    this.products = this.wireIndex<AlgoliaProductRecord>(
      productsHost,
      'products',
      config.indexes.products,
      productsStart,
    );
    const vendorsHost = lib.index({ indexName: vendorsStart, indexId: 'vendors' });
    this.vendors = this.wireIndex<AlgoliaVendorRecord>(
      vendorsHost,
      'vendors',
      config.indexes.vendors,
      vendorsStart,
    );

    // Root gets: the shared searchBox + the two sibling index widgets.
    this.search.addWidgets([searchBox, productsHost as IsWidget, vendorsHost as IsWidget]);

    // A failed search never reaches a connector render, so the `status:'error'`
    // signal is emitted from the instance error event. The batched
    // products+vendors multi-query fails as a unit ⇒ one event per failure.
    this.search.on('error', () => {
      // A failed page never renders, so release the footer's spinner here or it
      // would stay busy and block the next scroll-triggered load.
      for (const reset of this.loadingMoreResets) reset();
      this.error.set(true);
      this.emitSearchFailed();
    });
  }

  /** Construct + run the initial search. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.search.start();
    // Seed `?q=` after start so the first (empty or seeded) search runs with it.
    const initial = this.query();
    if (initial) this.setQuery(initial);
  }

  /**
   * Apply filters from the URL (the Back and Forward buttons). Replaces both
   * tabs' refinements, keeps the query and sorts, and starts each list again
   * from its first page. Does not call `onFiltersChange` back.
   */
  setFilters(filters: SearchFilters): void {
    if (!this.started || this.disposed) return;
    if (sameFilters(filters, this.lastFilters)) return;
    this.lastFilters = filters;
    this.search.setUiState((current) => ({
      ...current,
      products: { ...current['products'], ...filters.products, page: undefined },
      vendors: { ...current['vendors'], ...filters.vendors, page: undefined },
    }));
  }

  /** Update the query: mirror to the signal now, run the (debounced) search. */
  setQuery(value: string): void {
    this.query.set(value);
    this.searchBoxRefine?.(value);
  }

  /** Tear down the InstantSearch instance + timers. Guards double-dispose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.search.dispose();
  }

  /**
   * Emit `search_performed` once per distinct query (deduped on the query text),
   * with the best-effort federated result count and the active facet attributes.
   * Pagination / filter-only re-queries that keep the same query text don't
   * re-emit — the event tracks the user's search, not every Algolia round-trip.
   *
   * `durationMs` is the products index's `processingTimeMS` (AECI-643 / §3.9).
   */
  private maybeEmitSearchPerformed(durationMs: number): void {
    const query = this.query();
    // Skip the empty query: `start()` runs an initial empty-query search on every
    // /search load, and clearing the box returns to empty — neither is a search
    // the user performed, so they'd pollute the funnel.
    if (!query || query === this.lastSearchEmittedFor) return;
    this.lastSearchEmittedFor = query;
    const productHits = this.products.nbHits();
    const vendorHits = this.vendors.nbHits();
    const resultsCount = productHits + vendorHits;
    this.onSearch({
      query,
      results_count: resultsCount,
      results_products: productHits,
      results_vendors: vendorHits,
      filters_applied: this.appliedFilters(),
      status: 'ok',
      duration_ms: durationMs,
      results_bucket: resultsBucket(resultsCount),
    });
  }

  /**
   * The failure half of the re-homed RUM signal (AECI-643 / §3.9): a failed
   * multi-query never reaches a connector render, so without this the
   * `status` property would be a constant `'ok'` and the search error rate
   * would be unrecoverable from the event stream.
   *
   * Deliberately does NOT set `lastSearchEmittedFor`, so a retry of the same
   * query that succeeds still emits its `'ok'` row.
   */
  private emitSearchFailed(): void {
    const query = this.query();
    if (!query) return;
    this.onSearch({
      query,
      results_count: 0,
      // The multi-query failed as a unit, so neither index reported hits.
      // Zero rather than omitted, so a reader never has to distinguish "no
      // results" from "property missing on the error rows".
      results_products: 0,
      results_vendors: 0,
      filters_applied: this.appliedFilters(),
      status: 'error',
      // Not meaningful for a failure; latency reads filter on `status:'ok'`.
      duration_ms: 0,
      results_bucket: 'none',
    });
  }

  /** Distinct facet attributes with an active refinement across both indexes. */
  private appliedFilters(): string[] {
    const attributes = new Set<string>();
    for (const view of [this.products, this.vendors]) {
      for (const list of view.refinementLists) {
        if (list.items().some((item) => item.isRefined)) attributes.add(list.attribute);
      }
      for (const menu of view.numericMenus) {
        if (menu.items().some((item) => item.isRefined)) attributes.add(menu.attribute);
      }
      for (const range of view.ranges) {
        const [min, max] = range.start();
        if (min !== undefined || max !== undefined) attributes.add(range.attribute);
      }
    }
    return [...attributes];
  }

  /**
   * Build one index's widget set (infinite hits, stats, configure, facets),
   * attach them to `host` (a nested `index()` under the index-less root), and
   * return the signal-backed view.
   */
  private wireIndex<T>(
    host: WidgetHost,
    entity: 'products' | 'vendors',
    /** The entity's primary index name, which each replica name derives from. */
    baseIndexName: string,
    /** The replica this widget starts on. */
    initialSortIndex: string,
  ): IndexView<T> {
    const { lib } = this;
    const facets = FACET_CONFIG[entity];

    const hits = signal<T[]>([]);
    const nbHits = signal(0);
    const hasMore = signal(false);
    const loadingMore = signal(false);
    let showMore: (() => void) | null = null;
    let lastResults: unknown;
    let resultsAtLoad: unknown;
    this.loadingMoreResets.push(() => loadingMore.set(false));

    // Sort (AECI-175): one replica per sort, the same set and order as
    // `/products`. The primary is not an option: Relevance was dropped on
    // 2026-10-26. `connectSortBy` switches this index widget between the
    // replicas; its `currentRefinement` (an index name) drives `sortBy`. The page
    // maps each option's `key` token to a localized label.
    const sortOptions: SortOption[] = sortReplicasFor(entity).map((replica) => ({
      value: replicaIndexName(baseIndexName, replica.suffix),
      key: replica.sort,
    }));
    const sortBy = signal<string>(initialSortIndex);
    let sortRefine: ((value: string) => void) | null = null;

    const widgets: IsWidget[] = [
      lib.configure({ hitsPerPage: HITS_PER_PAGE }),
      lib.connectInfiniteHits((state, isFirstRender) => {
        hits.set(state.items as T[]);
        hasMore.set(!state.isLastPage);
        showMore = state.showMore;
        // A new results object means a search landed, which ends an error.
        if (state.results && state.results !== lastResults) this.error.set(false);
        lastResults = state.results;
        // The init render (isFirstRender) fires synchronously on start() with
        // empty items, before any network. The first response is the first
        // non-initial render — that's when results have actually settled.
        if (!isFirstRender) this.ready.set(true);
        // `showMore()` triggers an immediate re-render with the OLD results, so
        // only a new `results` object means the page landed. Clearing on any
        // render made the footer's pending phase invisible, and its scroll
        // observer never re-armed after the first append.
        if (state.results !== resultsAtLoad) loadingMore.set(false);
      })({}),
      lib.connectStats((state, isFirstRender) => {
        nbHits.set(state.nbHits);
        // Like `connectHits` above, the init render (isFirstRender) fires
        // synchronously on start() before any network, so it is skipped; every
        // later render corresponds to a real Algolia query.
        //
        // §14.1 `search_performed`: one event per distinct settled query. Gated
        // to the products index so a batched products+vendors response
        // emits once, not per index. Carries the fields re-homed from the
        // retired `aeci.search.query` RUM action (§3.9).
        if (!isFirstRender && entity === 'products') {
          this.maybeEmitSearchPerformed(Math.round(state.processingTimeMS));
        }
      })({}),
      lib.connectSortBy((state) => {
        sortBy.set(state.currentRefinement);
        sortRefine = state.refine;
      })({ items: sortOptions.map((option) => ({ label: option.key, value: option.value })) }),
    ];

    const refinementLists: RefinementListView[] = facets.refinementLists.map((attribute) => {
      const items = signal<RefinementItem[]>([]);
      const canRefine = signal(false);
      let refineFn: ((value: string) => void) | null = null;
      widgets.push(
        lib.connectRefinementList((state) => {
          items.set(orderFacetItems(attribute, state.items));
          canRefine.set(state.canRefine);
          refineFn = state.refine;
        })({ attribute, limit: REFINEMENT_LIST_LIMIT, operator: 'or' }),
      );
      return {
        attribute,
        items,
        canRefine,
        refine: (value: string) => refineFn?.(value),
      };
    });

    const numericMenus: NumericMenuView[] = facets.numericMenus.map(({ attribute, items: cfg }) => {
      const items = signal<NumericMenuItem[]>([]);
      let refineFn: ((value: string) => void) | null = null;
      widgets.push(
        lib.connectNumericMenu((state) => {
          items.set([...state.items]);
          refineFn = state.refine;
        })({ attribute, items: cfg }),
      );
      return {
        attribute,
        items,
        refine: (value: string) => refineFn?.(value),
      };
    });

    const ranges: RangeView[] = facets.ranges.map((attribute) => {
      const bounds = signal<{ min?: number; max?: number }>({});
      const start = signal<[number | undefined, number | undefined]>([undefined, undefined]);
      const canRefine = signal(false);
      let refineFn: ((values: [number | undefined, number | undefined]) => void) | null = null;
      widgets.push(
        lib.connectRange((state) => {
          bounds.set(state.range);
          start.set([state.start[0], state.start[1]]);
          canRefine.set(state.canRefine);
          refineFn = state.refine;
        })({ attribute }),
      );
      return {
        attribute,
        bounds,
        start,
        canRefine,
        refine: (values: [number | undefined, number | undefined]) => refineFn?.(values),
      };
    });

    host.addWidgets(widgets);

    return {
      entity,
      hits,
      nbHits,
      hasMore,
      loadingMore,
      loadMore: () => {
        if (loadingMore() || !hasMore() || !showMore) return;
        loadingMore.set(true);
        resultsAtLoad = lastResults;
        showMore();
      },
      refinementLists,
      numericMenus,
      ranges,
      sortBy,
      refineSort: (indexName: string) => sortRefine?.(indexName),
      sortOptions,
    };
  }
}

/** An entity's default sort index: its first replica (`sortReplicasFor` order). */
function defaultSortIndex(baseIndexName: string, entity: 'products' | 'vendors'): string {
  const [first] = sortReplicasFor(entity);
  return first ? replicaIndexName(baseIndexName, first.suffix) : baseIndexName;
}
