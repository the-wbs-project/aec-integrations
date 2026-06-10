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
 * two nested `index()` widgets (`vendors`, `integrations`), all driven by a
 * single shared `searchBox` on the root. That is exactly three index queries
 * batched into one multi-query request per keystroke. Each index owns its own
 * hits + stats + pagination + facets; the per-tab result count is just that
 * index's `connectStats.nbHits`. One `dispose()` tears it all down. Tabs in the
 * page are pure show/hide of already-materialized signal slices — switching tabs
 * never re-queries.
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

import type {
  AlgoliaIntegrationRecord,
  AlgoliaProductRecord,
  AlgoliaVendorRecord,
} from '@aeci/shared/algolia-records';

import type { AlgoliaPublicConfig } from './algolia-config';

// ─── Public signal-backed view models ───────────────────────────────────────

/** One value in a refinement list (a faceted attribute's distinct values). */
export interface RefinementItem {
  /** The facet value — for AECi records this is the display name (categories,
   *  audiences, vendor/product names) or a boolean string (`has_api_docs`). */
  readonly value: string;
  /** Algolia's display label; equals `value` for our records. */
  readonly label: string;
  /** Match count for this value under the current query. */
  readonly count: number;
  /** Whether this value is currently selected. */
  readonly isRefined: boolean;
}

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

/** Everything one entity tab binds to. `T` is the entity's denormalized record. */
export interface IndexView<T> {
  readonly entity: 'products' | 'vendors' | 'integrations';
  readonly hits: Signal<T[]>;
  readonly nbHits: Signal<number>;
  /** Zero-based current page (InstantSearch convention). */
  readonly page: Signal<number>;
  readonly nbPages: Signal<number>;
  refinePage(page: number): void;
  readonly refinementLists: readonly RefinementListView[];
  readonly numericMenus: readonly NumericMenuView[];
  readonly ranges: readonly RangeView[];
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

type Renderer<S> = (state: S, isFirstRender: boolean) => void;
type Connector<S, P> = (renderFn: Renderer<S>, unmountFn?: () => void) => (params: P) => IsWidget;

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
  numericMenus: readonly { attribute: string; items: { label: string; start?: number; end?: number }[] }[];
  ranges: readonly string[];
}

/**
 * Per-entity facets, matching `INDEX_SETTINGS.attributesForFaceting` in
 * `packages/shared/src/algolia.ts` exactly (§7.2). `has_api_docs` is faceted as
 * a boolean refinement list; the page maps its `true`/`false` values to a
 * localized yes/no.
 */
const FACET_CONFIG: Record<'products' | 'vendors' | 'integrations', FacetConfig> = {
  products: {
    refinementLists: ['categories', 'audiences', 'phases', 'vendor_name', 'has_api_docs'],
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
  integrations: {
    refinementLists: [
      'mechanism_kind',
      'direction',
      'source_product_name',
      'target_product_name',
    ],
    numericMenus: [],
    ranges: [],
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

  readonly products: IndexView<AlgoliaProductRecord>;
  readonly vendors: IndexView<AlgoliaVendorRecord>;
  readonly integrations: IndexView<AlgoliaIntegrationRecord>;

  private readonly search: InstantSearchInstance;
  private searchBoxRefine: ((value: string) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly lib: InstantSearchLib,
    searchClient: unknown,
    config: AlgoliaPublicConfig,
    initialQuery = '',
  ) {
    this.query = signal(initialQuery);

    // Root index = products. The shared searchBox + the products widgets attach
    // to the root; vendors/integrations attach as nested `index()` widgets. That
    // is three index queries (no wasted 4th).
    this.search = lib.instantsearch({
      indexName: config.indexes.products,
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

    this.products = this.wireIndex<AlgoliaProductRecord>(this.search, 'products');
    const vendorsHost = lib.index({ indexName: config.indexes.vendors });
    this.vendors = this.wireIndex<AlgoliaVendorRecord>(vendorsHost, 'vendors');
    const integrationsHost = lib.index({ indexName: config.indexes.integrations });
    this.integrations = this.wireIndex<AlgoliaIntegrationRecord>(integrationsHost, 'integrations');

    // Root gets: the shared searchBox + products widgets (already attached to
    // `this.search` by `wireIndex`) + the two nested index widgets.
    this.search.addWidgets([searchBox, vendorsHost as IsWidget, integrationsHost as IsWidget]);
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
   * Build one index's widget set (hits, stats, pagination, configure, facets),
   * attach them to `host` (the root instance for products; a nested `index()`
   * for vendors/integrations), and return the signal-backed view.
   */
  private wireIndex<T>(
    host: WidgetHost,
    entity: 'products' | 'vendors' | 'integrations',
  ): IndexView<T> {
    const { lib } = this;
    const facets = FACET_CONFIG[entity];

    const hits = signal<T[]>([]);
    const nbHits = signal(0);
    const page = signal(0);
    const nbPages = signal(0);
    let pageRefine: ((p: number) => void) | null = null;

    const widgets: IsWidget[] = [
      lib.configure({ hitsPerPage: HITS_PER_PAGE }),
      lib.connectHits((state) => hits.set(state.items as T[]))({}),
      lib.connectStats((state) => nbHits.set(state.nbHits))({}),
      lib.connectPagination((state) => {
        page.set(state.currentRefinement);
        nbPages.set(state.nbPages);
        pageRefine = state.refine;
      })({}),
    ];

    const refinementLists: RefinementListView[] = facets.refinementLists.map((attribute) => {
      const items = signal<RefinementItem[]>([]);
      const canRefine = signal(false);
      let refineFn: ((value: string) => void) | null = null;
      widgets.push(
        lib.connectRefinementList((state) => {
          items.set([...state.items]);
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
    };
  }
}

// AECI-142 follow-up — DEFERRED per-tab sort dropdown (tracked as AECI-175). No
// Algolia *replicas* exist yet, so a sort control has nothing to switch to; ship
// the relevance default (§7.3 `customRanking`). When replicas land (AECI-175:
// `replicas` in `IndexSettings`/`INDEX_SETTINGS` + provision/apply scripts +
// `forwardToReplicas`), add a `connectSortBy` per index here — register it in
// each `wireIndex` widget set keyed by the index's replica names — and surface a
// `sortBy` signal + `refineSort()` on `IndexView`.
