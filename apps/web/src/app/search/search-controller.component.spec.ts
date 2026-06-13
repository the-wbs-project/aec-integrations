import { afterEach, describe, expect, it, vi } from 'vitest';

import { type InstantSearchLib, type IsWidget, SearchController } from './search-controller';
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
      indexName: string;
      future?: { preserveSharedStateOnUnmount?: boolean };
    }[],
    index: [] as { indexName: string }[],
    configure: [] as Record<string, unknown>[],
    searchBox: [] as Captured[],
    hits: [] as Captured[],
    stats: [] as Captured[],
    pagination: [] as Captured[],
    refinementList: [] as Captured[],
    numericMenu: [] as Captured[],
    range: [] as Captured[],
  };
  const instance = {
    started: 0,
    disposed: 0,
    /** Captured `on('error', …)` handlers (AECI-174). */
    errorHandlers: [] as ((payload: { error: Error }) => void)[],
    addWidgets: (_w: IsWidget[]) => instance,
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
      calls.index.push(opts);
      return { addWidgets: (_w: IsWidget[]) => ({}) };
    },
    configure: (params) => {
      calls.configure.push(params);
      return { __configure: true } as IsWidget;
    },
    connectSearchBox: connector(calls.searchBox) as unknown as InstantSearchLib['connectSearchBox'],
    connectHits: connector(calls.hits) as unknown as InstantSearchLib['connectHits'],
    connectStats: connector(calls.stats) as unknown as InstantSearchLib['connectStats'],
    connectPagination: connector(
      calls.pagination,
    ) as unknown as InstantSearchLib['connectPagination'],
    connectRefinementList: connector(
      calls.refinementList,
    ) as unknown as InstantSearchLib['connectRefinementList'],
    connectNumericMenu: connector(
      calls.numericMenu,
    ) as unknown as InstantSearchLib['connectNumericMenu'],
    connectRange: connector(calls.range) as unknown as InstantSearchLib['connectRange'],
  };

  return { lib, calls, instance };
}

const CONFIG: AlgoliaPublicConfig = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p_idx', vendors: 'v_idx', integrations: 'i_idx' },
};

function build(initialQuery = '') {
  const fake = makeFakeLib();
  const emit = vi.fn();
  const controller = new SearchController(fake.lib, {}, CONFIG, initialQuery, emit);
  return { ...fake, controller, emit };
}

afterEach(() => vi.useRealTimers());

describe('SearchController wiring', () => {
  it('creates one root instantsearch on the products index with shared-state future flag', () => {
    const { calls } = build();
    expect(calls.instantsearch).toHaveLength(1);
    expect(calls.instantsearch[0].indexName).toBe('p_idx');
    expect(calls.instantsearch[0].future?.preserveSharedStateOnUnmount).toBe(true);
  });

  it('adds exactly one nested index (vendors) — two queries total (integrations excluded)', () => {
    const { calls } = build();
    expect(calls.index.map((i) => i.indexName)).toEqual(['v_idx']);
  });

  it('registers one shared searchBox and hits/stats/pagination/configure per index', () => {
    const { calls } = build();
    expect(calls.searchBox).toHaveLength(1);
    expect(calls.hits).toHaveLength(2);
    expect(calls.stats).toHaveLength(2);
    expect(calls.pagination).toHaveLength(2);
    expect(calls.configure).toHaveLength(2);
    expect(calls.configure[0]).toEqual({ hitsPerPage: 12 });
  });

  it('registers the §7.2 refinement lists / numeric menus / ranges per index', () => {
    const { calls } = build();
    expect(calls.refinementList.map((c) => c.params['attribute'])).toEqual([
      // products
      'categories',
      'audiences',
      'phases',
      'vendor_name',
      'has_api_docs',
      // vendors
      'headquarters',
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

describe('SearchController render-state → signal mapping', () => {
  it('maps connectHits items onto the per-index hits signal', () => {
    const { calls, controller } = build();
    const products = [{ objectID: 'a' }, { objectID: 'b' }];
    calls.hits[0].renderFn({ items: products }, true);
    expect(controller.products.hits()).toEqual(products);
    // vendors stays empty until its own render fires.
    expect(controller.vendors.hits()).toEqual([]);
  });

  it('flips `ready` only on the first non-initial connectHits render (AECI-228)', () => {
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

  it('maps pagination state and forwards refinePage to the connector', () => {
    const { calls, controller } = build();
    const refine = vi.fn();
    calls.pagination[0].renderFn({ currentRefinement: 2, nbPages: 5, refine }, true);
    expect(controller.products.page()).toBe(2);
    expect(controller.products.nbPages()).toBe(5);
    controller.products.refinePage(3);
    expect(refine).toHaveBeenCalledWith(3);
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

describe('SearchController — AECI-174 RUM emit', () => {
  it('emits a per-index ok action on a non-initial stats render (products)', () => {
    const { calls, emit } = build();
    calls.stats[0].renderFn({ nbHits: 3, processingTimeMS: 12.7 }, false);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      index: 'products',
      status: 'ok',
      duration_ms: 13, // rounded
      results_bucket: '1-5',
    });
  });

  it('tags the emit with the vendors index for the nested stats connector', () => {
    const { calls, emit } = build();
    calls.stats[1].renderFn({ nbHits: 0, processingTimeMS: 5 }, false);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ index: 'vendors', status: 'ok', results_bucket: 'none' }),
    );
  });

  it('does NOT emit on the synchronous init (isFirstRender) stats render', () => {
    const { calls, emit } = build();
    calls.stats[0].renderFn({ nbHits: 0, processingTimeMS: 0 }, true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits one federated error action from the instance error event', () => {
    const { instance, emit } = build();
    instance.triggerError();
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      index: 'federated',
      status: 'error',
      duration_ms: 0,
      results_bucket: 'none',
    });
  });
});
