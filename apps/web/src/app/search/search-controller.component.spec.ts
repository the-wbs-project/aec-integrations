import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type InstantSearchLib,
  type IsWidget,
  SearchController,
  type UiState,
} from './search-controller';
import { emptyFilters, type SearchFilters } from './search-url-state';
import type { AlgoliaPublicConfig } from './algolia-config';

/**
 * Runs under `ng test` (`.component.spec.ts`) because `SearchController` uses
 * `@angular/core` signals, which the plain-node Vitest config can't load — but
 * NO TestBed is needed: the controller takes a structural `InstantSearchLib` +
 * search client, so a fake records connector registration and lets us drive each
 * connector's render callback to assert the render-state → signal mapping,
 * debounce, and `dispose()` — with zero network and no real SDK.
 */

interface Captured {
  renderFn: (state: unknown, isFirstRender: boolean) => void;
  params: Record<string, unknown>;
}

function makeFakeLib() {
  const calls = {
    instantsearch: [] as {
      indexName?: string;
      initialUiState?: UiState;
      onStateChange?: (p: { uiState: UiState; setUiState: (next: UiState) => void }) => void;
      future?: { preserveSharedStateOnUnmount?: boolean };
    }[],
    index: [] as { indexName: string; indexId?: string; widgets: IsWidget[] }[],
    /** Widgets added straight onto the root instance. */
    rootWidgets: [] as IsWidget[],
    configure: [] as Record<string, unknown>[],
    searchBox: [] as Captured[],
    hits: [] as Captured[],
    stats: [] as Captured[],
    refinementList: [] as Captured[],
    numericMenu: [] as Captured[],
    range: [] as Captured[],
    sortBy: [] as Captured[],
  };
  const instance = {
    started: 0,
    disposed: 0,
    /** Captured `on('error', …)` handlers (AECI-174). */
    errorHandlers: [] as ((payload: { error: Error }) => void)[],
    /** Every `setUiState` call, resolved against `uiState`. */
    uiStates: [] as UiState[],
    uiState: {} as UiState,
    setUiState: (next: UiState | ((current: UiState) => UiState)) => {
      instance.uiState = typeof next === 'function' ? next(instance.uiState) : next;
      instance.uiStates.push(instance.uiState);
    },
    addWidgets: (w: IsWidget[]) => {
      calls.rootWidgets.push(...w);
      return instance;
    },
    start: () => {
      instance.started++;
    },
    dispose: () => {
      instance.disposed++;
    },
    on: (_event: 'error', handler: (payload: { error: Error }) => void) => {
      instance.errorHandlers.push(handler);
    },
    /** Test helper: fire the captured error handlers. */
    triggerError: () => {
      for (const h of instance.errorHandlers) h({ error: new Error('search failed') });
    },
  };
  const connector =
    (bucket: Captured[]) =>
    (renderFn: Captured['renderFn']) =>
    (params: Record<string, unknown> = {}) => {
      bucket.push({ renderFn, params });
      return { __bucket: bucket } as IsWidget;
    };

  const lib: InstantSearchLib = {
    instantsearch: (opts) => {
      calls.instantsearch.push(opts);
      return instance;
    },
    index: (opts) => {
      const entry = { indexName: opts.indexName, indexId: opts.indexId, widgets: [] as IsWidget[] };
      calls.index.push(entry);
      return {
        __index: entry,
        addWidgets: (w: IsWidget[]) => {
          entry.widgets.push(...w);
          return {};
        },
      };
    },
    configure: (params) => {
      calls.configure.push(params);
      return { __configure: true } as IsWidget;
    },
    connectSearchBox: connector(calls.searchBox) as unknown as InstantSearchLib['connectSearchBox'],
    connectInfiniteHits: connector(
      calls.hits,
    ) as unknown as InstantSearchLib['connectInfiniteHits'],
    connectStats: connector(calls.stats) as unknown as InstantSearchLib['connectStats'],
    connectRefinementList: connector(
      calls.refinementList,
    ) as unknown as InstantSearchLib['connectRefinementList'],
    connectNumericMenu: connector(
      calls.numericMenu,
    ) as unknown as InstantSearchLib['connectNumericMenu'],
    connectRange: connector(calls.range) as unknown as InstantSearchLib['connectRange'],
    connectSortBy: connector(calls.sortBy) as unknown as InstantSearchLib['connectSortBy'],
  };

  return { lib, calls, instance };
}

const CONFIG: AlgoliaPublicConfig = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p_idx', vendors: 'v_idx', integrations: 'i_idx' },
};

function build(
  initialQuery = '',
  initialSort: Partial<Record<'products' | 'vendors', string>> = {},
  initialFilters?: SearchFilters,
) {
  const fake = makeFakeLib();
  const onSearch = vi.fn();
  const onFiltersChange = vi.fn();
  const controller = new SearchController(
    fake.lib,
    {},
    CONFIG,
    initialQuery,
    initialSort,
    onSearch,
    { initialFilters, onFiltersChange },
  );
  return { ...fake, controller, onSearch, onFiltersChange };
}

describe('SearchController URL filter state', () => {
  const withCategory: SearchFilters = {
    ...emptyFilters(),
    products: { refinementList: { categories: ['Scheduling'] }, numericMenu: {}, range: {} },
  };

  it('starts InstantSearch on the URL filters, keyed by stable index ids', () => {
    const { calls } = build('', {}, withCategory);
    expect(calls.instantsearch[0].initialUiState?.['products']).toMatchObject({
      refinementList: { categories: ['Scheduling'] },
    });
    expect(calls.index.map((i) => i.indexId)).toEqual(['products', 'vendors']);
  });

  it('reports a filter change, but not typing or paging', () => {
    const { calls, instance, onFiltersChange } = build();
    const onStateChange = calls.instantsearch[0].onStateChange!;
    const pass = (uiState: UiState) => onStateChange({ uiState, setUiState: instance.setUiState });

    pass({ '': { query: 'rev' }, products: { page: 2 } });
    expect(onFiltersChange).not.toHaveBeenCalled();
    // The state still reaches InstantSearch: this is a pass-through.
    expect(instance.uiStates).toHaveLength(1);

    pass({ products: { refinementList: { categories: ['Scheduling'] } } });
    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange.mock.calls[0]![0].products.refinementList).toEqual({
      categories: ['Scheduling'],
    });
  });

  it('applies Back/Forward filters without echoing them back', () => {
    const { controller, calls, instance, onFiltersChange } = build();
    controller.start();
    instance.uiState = { products: { sortBy: 'p_idx_name_asc', page: 3 }, vendors: {} };
    controller.setFilters(withCategory);
    expect(instance.uiState['products']).toMatchObject({
      sortBy: 'p_idx_name_asc',
      refinementList: { categories: ['Scheduling'] },
      page: undefined,
    });
    // InstantSearch calls onStateChange for setUiState too; it must not loop.
    calls.instantsearch[0].onStateChange!({
      uiState: instance.uiState,
      setUiState: instance.setUiState,
    });
    expect(onFiltersChange).not.toHaveBeenCalled();
    // The same filters again: no new search.
    const count = instance.uiStates.length;
    controller.setFilters(withCategory);
    expect(instance.uiStates).toHaveLength(count);
  });
});

afterEach(() => vi.useRealTimers());

describe('SearchController wiring', () => {
  it('creates one index-less root instantsearch with the shared-state future flag', () => {
    const { calls } = build();
    expect(calls.instantsearch).toHaveLength(1);
    // No indexName: the root sends no query of its own.
    expect(calls.instantsearch[0].indexName).toBeUndefined();
    expect(calls.instantsearch[0].future?.preserveSharedStateOnUnmount).toBe(true);
  });

  it('nests products and vendors as SIBLINGS so neither inherits the other filters', () => {
    const { calls } = build();
    // Two queries total (integrations excluded).
    // Each starts on its default sort replica (Newest, Name A–Z).
    expect(calls.index.map((i) => i.indexName)).toEqual(['p_idx_created_desc', 'v_idx_name_asc']);
    // A nested index inherits its parent's refinements. Both index widgets hang
    // off the root, and no facet widget sits on the root itself, so a products
    // category filter can never reach the vendors query.
    expect(calls.rootWidgets).toHaveLength(3);
    expect(calls.rootWidgets.filter((w) => (w as { __index?: unknown }).__index)).toHaveLength(2);
    expect(calls.rootWidgets).not.toContainEqual(
      expect.objectContaining({ __bucket: calls.refinementList }),
    );
    expect(calls.index[0].widgets.length).toBeGreaterThan(0);
    expect(calls.index[1].widgets.length).toBeGreaterThan(0);
  });

  it('registers one shared searchBox and infinite hits/stats/configure per index', () => {
    const { calls } = build();
    expect(calls.searchBox).toHaveLength(1);
    expect(calls.hits).toHaveLength(2);
    expect(calls.stats).toHaveLength(2);
    expect(calls.configure).toHaveLength(2);
    // 24, the /products page size, so both listings page alike.
    expect(calls.configure[0]).toEqual({ hitsPerPage: 24 });
  });

  it('registers the §7.2 refinement lists / numeric menus / ranges per index', () => {
    const { calls } = build();
    expect(calls.refinementList.map((c) => c.params['attribute'])).toEqual([
      // products
      'categories',
      'audiences',
      'phases',
      'trades',
      'vendor_name',
      'has_api_docs',
      // vendors: none. headquarters is free text and was removed (2026-10-24).
      // integrations intentionally excluded from /search (see search-controller.ts)
    ]);
    expect(calls.numericMenu.map((c) => c.params['attribute'])).toEqual([
      'integration_count', // products
      'product_count', // vendors
      'integration_count', // vendors
    ]);
    expect(calls.range.map((c) => c.params['attribute'])).toEqual(['founded_year']);
  });

  it('leaves every refinement list on the connector default (no sortBy)', () => {
    const { calls } = build();
    // Only phases is reordered, and that happens post-render via orderFacetItems
    // — no facet passes a sortBy to the connector.
    for (const c of calls.refinementList) {
      expect(c.params['sortBy']).toBeUndefined();
    }
  });

  it('re-orders the phases facet into project-lifecycle order on render', () => {
    const { calls, controller } = build();
    const phasesIdx = calls.refinementList.findIndex((c) => c.params['attribute'] === 'phases');
    // Count-shuffled items arrive; lifecycle order must win.
    const items = [
      { value: 'Construction', label: 'Construction', count: 50, isRefined: false },
      { value: 'Concept & Planning', label: 'Concept & Planning', count: 1, isRefined: false },
      { value: 'Design', label: 'Design', count: 9, isRefined: false },
    ];
    calls.refinementList[phasesIdx].renderFn({ items, canRefine: true, refine: vi.fn() }, true);
    const phasesView = controller.products.refinementLists.find((r) => r.attribute === 'phases');
    expect(phasesView?.items().map((i) => i.value)).toEqual([
      'Concept & Planning',
      'Design',
      'Construction',
    ]);
  });
});

describe('SearchController — AECI-175 sort (replicas)', () => {
  it('registers one connectSortBy per index (products + vendors)', () => {
    const { calls } = build();
    expect(calls.sortBy).toHaveLength(2);
  });

  // Relevance (the primary) was dropped on 2026-10-26: the options are the
  // replicas alone, so /search offers exactly the /products sorts.
  it('builds the per-tab sort options from the replicas alone, no primary', () => {
    const { controller } = build();
    // Products: the five /products sorts, same tokens and order.
    expect(controller.products.sortOptions).toEqual([
      { value: 'p_idx_created_desc', key: 'created' },
      { value: 'p_idx_name_asc', key: 'name' },
      { value: 'p_idx_updated_desc', key: 'updated' },
      { value: 'p_idx_rating_desc', key: 'rating' },
      { value: 'p_idx_reviews_desc', key: 'reviews' },
    ]);
    expect(controller.vendors.sortOptions).toEqual([{ value: 'v_idx_name_asc', key: 'name' }]);
  });

  it('passes the replica index names as connectSortBy items', () => {
    const { calls } = build();
    expect(calls.sortBy[1].params['items']).toEqual([{ label: 'name', value: 'v_idx_name_asc' }]);
    expect(calls.sortBy[0].params['items']).toContainEqual({
      label: 'rating',
      value: 'p_idx_rating_desc',
    });
  });

  it('defaults sortBy to the first replica and maps currentRefinement on render', () => {
    const { calls, controller } = build();
    expect(controller.products.sortBy()).toBe('p_idx_created_desc');
    expect(controller.vendors.sortBy()).toBe('v_idx_name_asc');
    const refine = vi.fn();
    calls.sortBy[0].renderFn({ currentRefinement: 'p_idx_name_asc', options: [], refine }, true);
    expect(controller.products.sortBy()).toBe('p_idx_name_asc');
    controller.products.refineSort('p_idx_created_desc');
    expect(refine).toHaveBeenCalledWith('p_idx_created_desc');
  });

  it('seeds the index widgets + sortBy signal from initialSort (inbound ?sort=)', () => {
    const { calls, controller } = build('', { vendors: 'v_idx_name_asc' });
    // The products index starts on its default replica, never the primary…
    expect(calls.index[0].indexName).toBe('p_idx_created_desc');
    expect(controller.products.sortBy()).toBe('p_idx_created_desc');
    // …while the vendors index starts on the seeded replica.
    expect(calls.index[1].indexName).toBe('v_idx_name_asc');
    expect(controller.vendors.sortBy()).toBe('v_idx_name_asc');
  });
});

describe('SearchController render-state → signal mapping', () => {
  it('maps connectInfiniteHits items onto the per-index hits signal', () => {
    const { calls, controller } = build();
    const products = [{ objectID: 'a' }, { objectID: 'b' }];
    calls.hits[0].renderFn({ items: products }, true);
    expect(controller.products.hits()).toEqual(products);
    // vendors stays empty until its own render fires.
    expect(controller.vendors.hits()).toEqual([]);
  });

  it('flips `ready` only on the first non-initial connectInfiniteHits render (AECI-228)', () => {
    const { calls, controller } = build();
    // Starts false: pre-search, `hits()` is `[]` — indistinguishable from a real
    // zero-result search, so the page must keep showing skeletons.
    expect(controller.ready()).toBe(false);
    // The synchronous init render (isFirstRender=true, empty items) must NOT flip
    // it — the first response hasn't landed yet.
    calls.hits[0].renderFn({ items: [] }, true);
    expect(controller.ready()).toBe(false);
    // The first response render (isFirstRender=false) flips it — even with zero
    // hits, the search has now settled.
    calls.hits[0].renderFn({ items: [] }, false);
    expect(controller.ready()).toBe(true);
  });

  it('maps connectStats nbHits onto the per-index count signal', () => {
    const { calls, controller } = build();
    calls.stats[1].renderFn({ nbHits: 42 }, true);
    expect(controller.vendors.nbHits()).toBe(42);
  });

  it('maps isLastPage onto hasMore and appends via showMore', () => {
    const { calls, controller } = build();
    const showMore = vi.fn();
    const page1 = { items: [{ objectID: 'a' }], isLastPage: false, showMore, results: {} };
    calls.hits[0].renderFn(page1, false);
    expect(controller.products.hasMore()).toBe(true);
    controller.products.loadMore();
    expect(showMore).toHaveBeenCalledTimes(1);
    expect(controller.products.loadingMore()).toBe(true);
    // InstantSearch re-renders straight away with the OLD results when the
    // search starts. That is not the page landing, so the spinner must hold;
    // clearing it here hid the pending phase from the footer's re-arm.
    calls.hits[0].renderFn(page1, false);
    expect(controller.products.loadingMore()).toBe(true);
    // A second trigger while the page is in flight (scroll sentinel + click) is
    // swallowed, so one page never loads twice.
    controller.products.loadMore();
    expect(showMore).toHaveBeenCalledTimes(1);
    // The appended page lands: the accumulated items replace the signal and the
    // spinner clears.
    const items = [{ objectID: 'a' }, { objectID: 'b' }];
    calls.hits[0].renderFn({ items, isLastPage: true, showMore, results: {} }, false);
    expect(controller.products.hits()).toEqual(items);
    expect(controller.products.loadingMore()).toBe(false);
    expect(controller.products.hasMore()).toBe(false);
    controller.products.loadMore();
    expect(showMore).toHaveBeenCalledTimes(1);
  });

  it('clears loadingMore when the search fails, so the footer can retry', () => {
    const { calls, controller, instance } = build();
    const showMore = vi.fn();
    calls.hits[1].renderFn({ items: [{ objectID: 'v' }], isLastPage: false, showMore }, false);
    controller.vendors.loadMore();
    expect(controller.vendors.loadingMore()).toBe(true);
    instance.triggerError();
    expect(controller.vendors.loadingMore()).toBe(false);
    controller.vendors.loadMore();
    expect(showMore).toHaveBeenCalledTimes(2);
  });

  it('flags error on a failed search and clears it when the next response lands', () => {
    const { calls, controller, instance } = build();
    const showMore = vi.fn();
    const first = { items: [], isLastPage: true, showMore, results: {} };
    calls.hits[0].renderFn(first, false);
    expect(controller.error()).toBe(false);
    instance.triggerError();
    expect(controller.error()).toBe(true);
    // A re-render with the SAME results is not a new response.
    calls.hits[0].renderFn(first, false);
    expect(controller.error()).toBe(true);
    calls.hits[0].renderFn({ ...first, results: {} }, false);
    expect(controller.error()).toBe(false);
  });

  it('maps refinement-list items and forwards refine', () => {
    const { calls, controller } = build();
    const refine = vi.fn();
    const items = [{ value: 'PM', label: 'PM', count: 3, isRefined: false }];
    calls.refinementList[0].renderFn({ items, canRefine: true, refine }, true);
    expect(controller.products.refinementLists[0].items()).toEqual(items);
    expect(controller.products.refinementLists[0].canRefine()).toBe(true);
    controller.products.refinementLists[0].refine('PM');
    expect(refine).toHaveBeenCalledWith('PM');
  });

  it('maps range bounds/start and forwards refine (vendors founded_year)', () => {
    const { calls, controller } = build();
    const refine = vi.fn();
    calls.range[0].renderFn(
      { start: [2000, 2010], range: { min: 1990, max: 2020 }, canRefine: true, refine },
      true,
    );
    expect(controller.vendors.ranges[0].bounds()).toEqual({ min: 1990, max: 2020 });
    expect(controller.vendors.ranges[0].start()).toEqual([2000, 2010]);
    controller.vendors.ranges[0].refine([1995, 2005]);
    expect(refine).toHaveBeenCalledWith([1995, 2005]);
  });
});

describe('SearchController query + lifecycle', () => {
  it('debounces the network search via the searchBox queryHook', () => {
    vi.useFakeTimers();
    const { calls } = build();
    const queryHook = calls.searchBox[0].params['queryHook'] as (
      q: string,
      run: (v: string) => void,
    ) => void;
    const runSearch = vi.fn();
    queryHook('rev', runSearch);
    expect(runSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(runSearch).toHaveBeenCalledWith('rev');
  });

  it('setQuery mirrors the signal immediately and refines through the searchBox', () => {
    const { calls, controller } = build();
    const refine = vi.fn();
    calls.searchBox[0].renderFn({ query: '', refine, isSearchStalled: false }, true);
    controller.setQuery('autodesk');
    expect(controller.query()).toBe('autodesk');
    expect(refine).toHaveBeenCalledWith('autodesk');
  });

  it('reflects the searchBox stalled flag', () => {
    const { calls, controller } = build();
    calls.searchBox[0].renderFn({ query: '', refine: vi.fn(), isSearchStalled: true }, true);
    expect(controller.stalled()).toBe(true);
  });

  it('start() is idempotent and seeds an initial query', () => {
    const { calls, instance, controller } = build('revit');
    const refine = vi.fn();
    calls.searchBox[0].renderFn({ query: '', refine, isSearchStalled: false }, true);
    controller.start();
    controller.start();
    expect(instance.started).toBe(1);
    // The seeded ?q= is pushed through after start.
    expect(refine).toHaveBeenCalledWith('revit');
  });

  it('dispose() tears down once and guards double-dispose', () => {
    const { instance, controller } = build();
    controller.dispose();
    controller.dispose();
    expect(instance.disposed).toBe(1);
  });
});

describe('SearchController — AECI-239 search_performed emit', () => {
  /** Drive a non-initial root (products) stats render at a given query. */
  function settle(
    fake: ReturnType<typeof build>,
    query: string,
    nbHits = { products: 0, vendors: 0 },
  ): void {
    fake.controller.setQuery(query);
    // vendors stats first so its nbHits is current when products settles.
    fake.calls.stats[1].renderFn({ nbHits: nbHits.vendors, processingTimeMS: 4 }, false);
    fake.calls.stats[0].renderFn({ nbHits: nbHits.products, processingTimeMS: 7 }, false);
  }

  it('emits once per query from the ROOT stats render with the federated count', () => {
    const fake = build();
    settle(fake, 'revit', { products: 5, vendors: 3 });
    expect(fake.onSearch).toHaveBeenCalledExactlyOnceWith({
      query: 'revit',
      results_count: 8,
      results_products: 5,
      results_vendors: 3,
      filters_applied: [],
      status: 'ok',
      duration_ms: 7,
      results_bucket: '6-20',
    });
  });

  it('splits the federated count into per-index results (AECI-649 follow-up)', () => {
    const fake = build();
    settle(fake, 'revit', { products: 5, vendors: 3 });
    const [payload] = fake.onSearch.mock.calls[0];
    // The point of the split: results_count alone cannot tell you WHICH entity
    // type the query found. 8 hits could be 8 products or 8 vendors, and those
    // are different demand signals. This is the half of the retired RUM
    // `index` dimension worth keeping (POSTHOG_MIGRATION_SPEC.md §8.10).
    expect(payload.results_products).toBe(5);
    expect(payload.results_vendors).toBe(3);
    expect(payload.results_products + payload.results_vendors).toBe(payload.results_count);
  });

  it('does NOT emit from the nested (vendors) stats render', () => {
    const fake = build();
    fake.controller.setQuery('revit');
    fake.calls.stats[1].renderFn({ nbHits: 3, processingTimeMS: 4 }, false);
    expect(fake.onSearch).not.toHaveBeenCalled();
  });

  it('does NOT emit on the synchronous init (isFirstRender) stats render', () => {
    const fake = build();
    fake.controller.setQuery('revit');
    fake.calls.stats[0].renderFn({ nbHits: 1, processingTimeMS: 0 }, true);
    expect(fake.onSearch).not.toHaveBeenCalled();
  });

  it('dedupes: re-rendering the same query (e.g. pagination) does not re-emit', () => {
    const fake = build();
    settle(fake, 'revit', { products: 5, vendors: 0 });
    settle(fake, 'revit', { products: 5, vendors: 0 });
    expect(fake.onSearch).toHaveBeenCalledTimes(1);
  });

  it('emits again once the query text changes', () => {
    const fake = build();
    settle(fake, 'revit', { products: 5, vendors: 0 });
    settle(fake, 'autocad', { products: 2, vendors: 0 });
    expect(fake.onSearch).toHaveBeenCalledTimes(2);
    expect(fake.onSearch).toHaveBeenLastCalledWith({
      query: 'autocad',
      results_count: 2,
      results_products: 2,
      results_vendors: 0,
      filters_applied: [],
      status: 'ok',
      duration_ms: 7,
      results_bucket: '1-5',
    });
  });

  it('does NOT emit for the empty query (initial /search load, or clearing the box)', () => {
    const fake = build();
    settle(fake, '', { products: 40, vendors: 12 });
    expect(fake.onSearch).not.toHaveBeenCalled();
  });

  it('emits the first real query after an empty initial search', () => {
    const fake = build();
    settle(fake, '', { products: 40, vendors: 12 });
    settle(fake, 'revit', { products: 5, vendors: 3 });
    expect(fake.onSearch).toHaveBeenCalledExactlyOnceWith({
      query: 'revit',
      results_count: 8,
      results_products: 5,
      results_vendors: 3,
      filters_applied: [],
      status: 'ok',
      duration_ms: 7,
      results_bucket: '6-20',
    });
  });

  it('reports the distinct refined facet attributes in filters_applied', () => {
    const fake = build();
    // Refine the products `categories` list + the vendors `founded_year` range.
    const categories = fake.calls.refinementList.find(
      (c) => c.params['attribute'] === 'categories',
    );
    categories?.renderFn(
      {
        items: [{ value: 'BIM', label: 'BIM', count: 3, isRefined: true }],
        canRefine: true,
        refine: vi.fn(),
      },
      true,
    );
    const range = fake.calls.range.find((c) => c.params['attribute'] === 'founded_year');
    range?.renderFn(
      { start: [2000, undefined], range: {}, canRefine: true, refine: vi.fn() },
      true,
    );

    settle(fake, 'revit', { products: 5, vendors: 0 });
    expect(fake.onSearch).toHaveBeenCalledExactlyOnceWith({
      query: 'revit',
      results_count: 5,
      results_products: 5,
      results_vendors: 0,
      filters_applied: ['categories', 'founded_year'],
      status: 'ok',
      duration_ms: 7,
      results_bucket: '1-5',
    });
  });

  it('emits a status:"error" row from the instance error event (AECI-643 / §3.9)', () => {
    const fake = build();
    fake.controller.setQuery('revit');
    fake.instance.triggerError();
    expect(fake.onSearch).toHaveBeenCalledExactlyOnceWith({
      query: 'revit',
      results_count: 0,
      results_products: 0,
      results_vendors: 0,
      filters_applied: [],
      status: 'error',
      duration_ms: 0,
      results_bucket: 'none',
    });
  });

  it('does NOT emit an error row for the empty query', () => {
    const fake = build();
    fake.instance.triggerError();
    expect(fake.onSearch).not.toHaveBeenCalled();
  });

  it('a failure does not suppress the "ok" row when the same query is retried', () => {
    const fake = build();
    fake.controller.setQuery('revit');
    fake.instance.triggerError();
    settle(fake, 'revit', { products: 5, vendors: 0 });
    expect(fake.onSearch).toHaveBeenCalledTimes(2);
    expect(fake.onSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'revit', status: 'ok' }),
    );
  });
});
