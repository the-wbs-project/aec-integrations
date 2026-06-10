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
    addWidgets: (_w: IsWidget[]) => instance,
    start: () => {
      instance.started++;
    },
    dispose: () => {
      instance.disposed++;
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
  const controller = new SearchController(fake.lib, {}, CONFIG, initialQuery);
  return { ...fake, controller };
}

afterEach(() => vi.useRealTimers());

describe('SearchController wiring', () => {
  it('creates one root instantsearch on the products index with shared-state future flag', () => {
    const { calls } = build();
    expect(calls.instantsearch).toHaveLength(1);
    expect(calls.instantsearch[0].indexName).toBe('p_idx');
    expect(calls.instantsearch[0].future?.preserveSharedStateOnUnmount).toBe(true);
  });

  it('adds exactly two nested indexes (vendors, integrations) — three queries total', () => {
    const { calls } = build();
    expect(calls.index.map((i) => i.indexName)).toEqual(['v_idx', 'i_idx']);
  });

  it('registers one shared searchBox and hits/stats/pagination/configure per index', () => {
    const { calls } = build();
    expect(calls.searchBox).toHaveLength(1);
    expect(calls.hits).toHaveLength(3);
    expect(calls.stats).toHaveLength(3);
    expect(calls.pagination).toHaveLength(3);
    expect(calls.configure).toHaveLength(3);
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
      // integrations
      'mechanism_kind',
      'direction',
      'source_product_name',
      'target_product_name',
    ]);
    expect(calls.numericMenu.map((c) => c.params['attribute'])).toEqual([
      'integration_count', // products
      'product_count', // vendors
      'integration_count', // vendors
    ]);
    expect(calls.range.map((c) => c.params['attribute'])).toEqual(['founded_year']);
  });
});

describe('SearchController render-state → signal mapping', () => {
  it('maps connectHits items onto the per-index hits signal', () => {
    const { calls, controller } = build();
    const products = [{ objectID: 'a' }, { objectID: 'b' }];
    calls.hits[0].renderFn({ items: products }, true);
    expect(controller.products.hits()).toEqual(products);
    // vendors/integrations stay empty until their own render fires.
    expect(controller.vendors.hits()).toEqual([]);
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
