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
 * ARCHITECTURE — one root `instantsearch()` whose root index is `products`, plus
 * one nested `index()` widget (`vendors`), all driven by a single shared
 * `searchBox` on the root. That is exactly two index queries batched into one
 * multi-query request per keystroke. Each index owns its own hits + stats +
 * pagination + facets; the per-tab result count is just that index's
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
 * URL/facet policy (§9.2): this controller does NOT use instantsearch's history
 * router. Serializing every facet to the query string is the "query-string
 * explosion" §9.2 warns against. Facet state stays in-memory here; the page
 * syncs only `?q=` (+ `?tab=`) to the URL itself.
 *
 * TESTABILITY — the impure `import('instantsearch.js')` / `import('algoliasearch/lite')`
 * lives in the factory. This class takes a structural `InstantSearchLib` +
 * `searchClient`, so the unit test passes fakes and asserts connector
 * registration, render-state → signal mapping, debounce, and `dispose()` without
 * any network or real SDK.
 *
 * Spec: `STAGE_1_SPEC.md` §4.6 (page UX), §7.1 (record shapes), §7.2 (facets),
 * §7.5 (integration); §9.2 (no facet-in-URL). Mirrors the browser-only,
 * dynamic-import discipline of `apps/web/src/app/datadog.provider.ts`.
 */
import { type Signal, type WritableSignal, signal } from '@angular/core';

import { replicaIndexName, sortReplicasFor } from '@aeci/shared/algolia';
import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import type { RefinementItem } from '../shared/facets/refinement-item';

import type { AlgoliaPublicConfig } from './algolia-config';
import { orderFacetItems } from './search-facet-order';
import {
  emitSearchQuery,
  resultsBucket,
  type ResultsBucket,
  type SearchQueryEmitter,
  type SearchStatus,
} from './search-rum';

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
 * One sort choice on a tab (AECI-175). `value` is the physical Algolia index name
 * `connectSortBy` switches to (the primary for `relevance`, a replica otherwise);
 * `key` is the stable i18n token the page maps to a localized label
 * (`relevance` | `integrations` | `name`).
 */
export interface SortOption {
  readonly value: string;
  readonly key: string;
}

/** Everything one entity tab binds to. `T` is the entity's denormalized record. */
export interface IndexView<T> {
  readonly entity: 'products' | 'vendors';
  readonly hits: Signal<T[]>;
  readonly nbHits: Signal<number>;
  /** Zero-based current page (InstantSearch convention). */
  readonly page: Signal<number>;
  readonly nbPages: Signal<number>;
  refinePage(page: number): void;
  readonly refinementLists: readonly RefinementListView[];
  readonly numericMenus: readonly NumericMenuView[];
  readonly ranges: readonly RangeView[];
  /** The active sort's physical index name (AECI-175); `relevance` = the primary. */
  readonly sortBy: Signal<string>;
  /** Switch the tab's sort (pass a `SortOption.value`, i.e. an index name). */
  refineSort(indexName: string): void;
  /** The tab's available sorts, relevance first. */
  readonly sortOptions: readonly SortOption[];
}

// ─── Structural SDK surface (injected; real impl in the factory) ─────────────

/** Opaque InstantSearch widget handle. */
export type IsWidget = unknown;

/** A target widgets can be added to: the root instance or a nested `index()`. */
export interface WidgetHost {
  addWidgets(widgets: IsWidget[]): unknown;
}

export interface InstantSearchInstance extends WidgetHost {
  start(): void;
  dispose(): void;
  /**
   * Subscribe to the instance error event (AECI-174). A failed search surfaces
   * here, not through any connector render, so this is the only hook for the
   * `status: 'error'` RUM emit. `instantsearch.js` emits `'error'` with the
   * thrown error on the payload.
   */
  on(event: 'error', handler: (payload: { error: Error }) => void): void;
}

/** Render-state shapes (the subset of each connector's output we consume). */
export interface SearchBoxRenderState {
  query: string;
  refine(query: string): void;
  isSearchStalled: boolean;
}
export interface HitsRenderState {
  items: readonly unknown[];
}
export interface StatsRenderState {
  nbHits: number;
  /** Algolia server-side processing time, ms — the `aeci.search.query` duration. */
  processingTimeMS: number;
}
export interface PaginationRenderState {
  currentRefinement: number;
  nbPages: number;
  refine(page: number): void;
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
 * retired `aeci.search.query` Datadog RUM action (AECI-643,
 * `docs/POSTHOG_MIGRATION_SPEC.md` §3.9). The RUM emit itself is UNCHANGED and
 * still fires alongside — Datadog RUM stays live until §AW-final.
 *
 * Two accepted narrowings, both recorded in §3.8 rather than discovered later:
 *   - the RUM action saw EVERY search; this event only reaches the consented
 *     slice (`Analytics.capture` gates on `'granted'`);
 *   - RUM emitted per index with that index's `nbHits`; this event is federated,
 *     so `results_bucket` buckets `results_count` (products + vendors) through
 *     the same `resultsBucket()` helper, and `duration_ms` is the root
 *     (products) index's `processingTimeMS`.
 */
export interface SearchPerformedEvent {
  readonly query: string;
  /** Best-effort federated total (products + vendors `nbHits`). */
  readonly results_count: number;
  /** Distinct facet attributes with an active refinement at search time. */
  readonly filters_applied: readonly string[];
  /** Whether the query settled or the multi-query failed as a unit. */
  readonly status: SearchStatus;
  /** Algolia `processingTimeMS` for the root index; 0 for a failure. */
  readonly duration_ms: number;
  /** Coarse bucket over `results_count`, keeping the property low-cardinality. */
  readonly results_bucket: ResultsBucket;
}

/** Emit seam for `search_performed` — injectable so tests assert without the SDK. */
export type SearchPerformedEmitter = (event: SearchPerformedEvent) => void;

/** The minimal `instantsearch.js` surface this controller drives. */
export interface InstantSearchLib {
  instantsearch(opts: {
    indexName: string;
    searchClient: unknown;
    future?: { preserveSharedStateOnUnmount?: boolean };
  }): InstantSearchInstance;
  index(opts: { indexName: string }): WidgetHost;
  configure(params: Record<string, unknown>): IsWidget;
  connectSearchBox: Connector<
    SearchBoxRenderState,
    { queryHook?: (query: string, search: (value: string) => void) => void }
  >;
  connectHits: Connector<HitsRenderState, Record<string, unknown>>;
  connectStats: Connector<StatsRenderState, Record<string, unknown>>;
  connectPagination: Connector<PaginationRenderState, { padding?: number }>;
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
 * `packages/shared/src/algolia.ts` exactly (§7.2). `has_api_docs` is faceted as
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
    refinementLists: ['headquarters'],
    numericMenus: [
      { attribute: 'product_count', items: COUNT_BUCKETS },
      { attribute: 'integration_count', items: COUNT_BUCKETS },
    ],
    ranges: ['founded_year'],
  },
};

/** Page size per entity tab. */
const HITS_PER_PAGE = 12;
/** Search-as-you-type debounce, ms (§ plan: ~150–200ms). */
const QUERY_DEBOUNCE_MS = 200;
/** Refinement-list value cap before "show more" would be needed (kept simple). */
const REFINEMENT_LIST_LIMIT = 12;

// ─── Controller ──────────────────────────────────────────────────────────────

/**
 * Owns the root `instantsearch()` + the three index views and maps every
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
   * Flips `true` once the first search RESPONSE has landed (the first
   * non-initial `connectHits` render). Until then `hits()` is `[]` — which is
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

  constructor(
    private readonly lib: InstantSearchLib,
    searchClient: unknown,
    config: AlgoliaPublicConfig,
    initialQuery = '',
    /**
     * Initial sort per tab (AECI-175): a physical index name to start that tab's
     * index widget on, so an inbound `?sort=` renders the right order on first
     * paint. Omitted entries default to the entity's primary (relevance). The
     * page resolves the `?sort=` token → index name before passing it here.
     */
    initialSort: Partial<Record<'products' | 'vendors', string>> = {},
    /** RUM emit seam (AECI-174); injectable so tests assert without the SDK. */
    private readonly emit: SearchQueryEmitter = emitSearchQuery,
    /** PostHog `search_performed` emit seam (AECI-239); defaults to a no-op so
     *  the controller stays decoupled from Angular DI (the page wires it). */
    private readonly onSearch: SearchPerformedEmitter = () => undefined,
  ) {
    this.query = signal(initialQuery);

    // Root index = products. The shared searchBox + the products widgets attach
    // to the root; vendors attaches as a nested `index()` widget. That is two
    // index queries (integrations intentionally not queried — see file header).
    // Each index widget STARTS on its initial-sort index (a replica when `?sort=`
    // asked for one), which `connectSortBy` then switches; `relevance` = primary.
    const productsStart = initialSort.products ?? config.indexes.products;
    const vendorsStart = initialSort.vendors ?? config.indexes.vendors;
    this.search = lib.instantsearch({
      indexName: productsStart,
      searchClient,
      future: { preserveSharedStateOnUnmount: true },
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

    this.products = this.wireIndex<AlgoliaProductRecord>(
      this.search,
      'products',
      config.indexes.products,
      productsStart,
    );
    const vendorsHost = lib.index({ indexName: vendorsStart });
    this.vendors = this.wireIndex<AlgoliaVendorRecord>(
      vendorsHost,
      'vendors',
      config.indexes.vendors,
      vendorsStart,
    );

    // Root gets: the shared searchBox + products widgets (already attached to
    // `this.search` by `wireIndex`) + the one nested index widget.
    this.search.addWidgets([searchBox, vendorsHost as IsWidget]);

    // AECI-174 — a failed search never reaches a connector render, so the
    // `status:'error'` RUM signal is emitted from the instance error event. The
    // batched products+vendors multi-query fails as a unit ⇒ one `federated`
    // emit. `duration_ms` isn't meaningful for a failure (the latency widget
    // filters `status:ok`), so it is 0.
    this.search.on('error', () => {
      this.emit({
        index: 'federated',
        status: 'error',
        duration_ms: 0,
        results_bucket: 'none',
      });
      // AECI-643 / §3.9 — the same failure, on the PostHog side. The RUM emit
      // above is untouched and stays live until §AW-final.
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
   * `durationMs` is the root index's `processingTimeMS` (AECI-643 / §3.9).
   */
  private maybeEmitSearchPerformed(durationMs: number): void {
    const query = this.query();
    // Skip the empty query: `start()` runs an initial empty-query search on every
    // /search load, and clearing the box returns to empty — neither is a search
    // the user performed, so they'd pollute the funnel.
    if (!query || query === this.lastSearchEmittedFor) return;
    this.lastSearchEmittedFor = query;
    const resultsCount = this.products.nbHits() + this.vendors.nbHits();
    this.onSearch({
      query,
      results_count: resultsCount,
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
   * Build one index's widget set (hits, stats, pagination, configure, facets),
   * attach them to `host` (the root instance for products; a nested `index()`
   * for vendors/integrations), and return the signal-backed view.
   */
  private wireIndex<T>(
    host: WidgetHost,
    entity: 'products' | 'vendors',
    /** The entity's primary (relevance) index name — the `relevance` option's value. */
    baseIndexName: string,
    /** The index this widget starts on (a replica when `?sort=` seeded one). */
    initialSortIndex: string,
  ): IndexView<T> {
    const { lib } = this;
    const facets = FACET_CONFIG[entity];

    const hits = signal<T[]>([]);
    const nbHits = signal(0);
    const page = signal(0);
    const nbPages = signal(0);
    let pageRefine: ((p: number) => void) | null = null;

    // Sort (AECI-175): relevance = the primary index, then one replica per
    // non-relevance sort. `connectSortBy` switches this index widget between them;
    // its `currentRefinement` (an index name) drives `sortBy`. The page maps each
    // option's `key` token to a localized label.
    const sortOptions: SortOption[] = [
      { value: baseIndexName, key: 'relevance' },
      ...sortReplicasFor(entity).map((replica) => ({
        value: replicaIndexName(baseIndexName, replica.suffix),
        key: replica.sort,
      })),
    ];
    const sortBy = signal<string>(initialSortIndex);
    let sortRefine: ((value: string) => void) | null = null;

    const widgets: IsWidget[] = [
      lib.configure({ hitsPerPage: HITS_PER_PAGE }),
      lib.connectHits((state, isFirstRender) => {
        hits.set(state.items as T[]);
        // The init render (isFirstRender) fires synchronously on start() with
        // empty items, before any network. The first response is the first
        // non-initial render — that's when results have actually settled.
        if (!isFirstRender) this.ready.set(true);
      })({}),
      lib.connectStats((state, isFirstRender) => {
        nbHits.set(state.nbHits);
        // AECI-174 — emit the per-index `aeci.search.query` RUM action once a
        // search RESPONSE has settled. Like `connectHits` above, the init render
        // (isFirstRender) fires synchronously on start() before any network, so
        // it is skipped; every later render corresponds to a real Algolia query.
        if (!isFirstRender) {
          this.emit({
            index: entity,
            status: 'ok',
            duration_ms: Math.round(state.processingTimeMS),
            results_bucket: resultsBucket(state.nbHits),
          });
          // §14.1 `search_performed`: one event per distinct settled query. Gated
          // to the root (products) index so a batched products+vendors response
          // emits once, not per index. Carries the re-homed RUM fields (§3.9).
          if (entity === 'products') {
            this.maybeEmitSearchPerformed(Math.round(state.processingTimeMS));
          }
        }
      })({}),
      lib.connectPagination((state) => {
        page.set(state.currentRefinement);
        nbPages.set(state.nbPages);
        pageRefine = state.refine;
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
      page,
      nbPages,
      refinePage: (p: number) => pageRefine?.(p),
      refinementLists,
      numericMenus,
      ranges,
      sortBy,
      refineSort: (indexName: string) => sortRefine?.(indexName),
      sortOptions,
    };
  }
}
