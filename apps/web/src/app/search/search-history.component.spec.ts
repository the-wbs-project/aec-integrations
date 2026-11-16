import { TestBed } from '@angular/core/testing';
import { convertToParamMap, Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HistoryTraversal,
  LISTING_HISTORY_LIMIT,
  LISTING_HISTORY_MAX_AGE_MS,
} from '../shared/paginated-index/listing-history-store';

import { type SearchSnapshot } from './search-controller';
import { createSearchEngine, SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import {
  restoredSearchView,
  SearchHistoryStore,
  searchHistoryKey,
  type SearchView,
} from './search-history';
import { SearchPage } from './search-page';

/**
 * `/search` on Back and Forward (the AECI-1900 rule applied to `/search`): the
 * store's rules, its key, the view that stands in before the search code loads,
 * and the page end to end with the REAL InstantSearch connectors over a fake
 * search client.
 */

const key = (query: Record<string, string | string[]>) =>
  searchHistoryKey(convertToParamMap(query));

function snapshot(query = 'zz', hits = 3): SearchSnapshot {
  const index = (prefix: string) => ({
    pages: { 0: Array.from({ length: hits }, (_, i) => ({ objectID: `${prefix}-${i}` })) },
    nbHits: hits,
    hasMore: false,
    sortBy: `${prefix}_created_desc`,
    sortOptions: [{ value: `${prefix}_created_desc`, key: 'created' }],
    refinementLists: {},
    numericMenus: {},
    ranges: {},
  });
  return { query, products: index('p'), vendors: index('v') };
}

describe('searchHistoryKey', () => {
  it('differs on each axis: query, tab, sort and every filter and range', () => {
    const base = key({ q: 'zz' });
    const variants = {
      query: key({ q: 'zy' }),
      tab: key({ q: 'zz', tab: 'vendors' }),
      sort: key({ q: 'zz', sort: 'name' }),
      list: key({ q: 'zz', categories: 'AI' }),
      secondValue: key({ q: 'zz', categories: ['AI', 'BIM'] }),
      menu: key({ q: 'zz', integration_count: '1:10' }),
      vendorMenu: key({ q: 'zz', v_product_count: '1:10' }),
      range: key({ q: 'zz', v_founded_year: '2000:' }),
    };
    const all = [base, ...Object.values(variants)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('matches how the page reads the URL: trimmed query, default sort, no view', () => {
    const base = key({ q: 'zz' });
    expect(key({ q: ' zz ' })).toBe(base);
    expect(key({ q: 'zz', sort: 'created' })).toBe(base);
    expect(key({ q: 'zz', sort: 'retired-token' })).toBe(base);
    expect(key({ q: 'zz', view: 'table' })).toBe(base);
    expect(key({ q: 'zz', categories: ['B', 'A'] })).toBe(key({ q: 'zz', categories: ['A', 'B'] }));
  });
});

describe('SearchHistoryStore', () => {
  it('keeps the last 5 entries, least recently used out first', () => {
    const store = new SearchHistoryStore();
    for (let i = 0; i <= LISTING_HISTORY_LIMIT; i++) store.write(`k${i}`, i, snapshot(), 0);
    expect(store.size).toBe(LISTING_HISTORY_LIMIT);
    expect(store.read('k0', 0, 0)).toBeNull();
    expect(store.read('k1', 1, 0)).not.toBeNull();
  });

  it('drops an entry older than 5 minutes', () => {
    const store = new SearchHistoryStore();
    store.write('k', 1, snapshot(), 0);
    expect(store.read('k', 1, LISTING_HISTORY_MAX_AGE_MS)).not.toBeNull();
    expect(store.read('k', 1, LISTING_HISTORY_MAX_AGE_MS + 1)).toBeNull();
  });

  it('keeps one entry per history entry and retires a dead id', () => {
    const store = new SearchHistoryStore();
    const first = snapshot('zz', 1);
    const second = snapshot('zz', 2);
    store.write('k', 1, first, 0);
    store.write('k', 2, second, 0);
    expect(store.read('k', 1, 0)).toBe(first);
    expect(store.read('k', 2, 0)).toBe(second);
    store.retire(1);
    expect(store.read('k', 1, 0)).toBeNull();
  });
});

describe('restoredSearchView', () => {
  it('draws the snapshot and replays what the reader did on the controller', () => {
    const snap = snapshot('zz', 2);
    const restored = restoredSearchView({
      ...snap,
      products: { ...snap.products, hasMore: true },
    });
    const view = restored.view;
    expect(view.ready()).toBe(true);
    expect(view.products.hits().map((h) => (h as { objectID: string }).objectID)).toEqual([
      'p-0',
      'p-1',
    ]);

    view.products.loadMore();
    view.products.loadMore();
    expect(view.products.loadingMore()).toBe(true);
    view.products.refineSort('p_name_asc');
    expect(view.products.sortBy()).toBe('p_name_asc');

    const loadMore = vi.fn();
    const refineSort = vi.fn();
    const target = {
      products: { loadMore, refineSort, refinementLists: [], numericMenus: [], ranges: [] },
      vendors: { loadMore: vi.fn(), refineSort: vi.fn() },
    } as unknown as SearchView;
    restored.replay(target);
    // One "Load more" even when pressed twice, in the order taken.
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(refineSort).toHaveBeenCalledWith('p_name_asc');
    restored.replay(target);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});

// --- The page, end to end ----------------------------------------------------

const CONFIG = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p', vendors: 'v', integrations: 'i' },
};

interface FakeRequest {
  indexName: string;
  params?: Record<string, unknown>;
}

/** 60 products and 10 vendors, named in order, answering any query. */
function makeClient() {
  const batches: FakeRequest[][] = [];
  const client = {
    search(requests: FakeRequest[]) {
      batches.push(requests);
      return Promise.resolve({
        results: requests.map((r) => {
          const products = r.indexName.startsWith('p');
          const total = products ? 60 : 10;
          const perPage = Number(r.params?.['hitsPerPage'] ?? 24);
          const page = Number(r.params?.['page'] ?? 0);
          const hits = Array.from({ length: total }, (_, i) => ({
            objectID: `${products ? 'p' : 'v'}-${String(i).padStart(2, '0')}`,
            name: `${products ? 'Product' : 'Vendor'} ${String(i).padStart(2, '0')}`,
            company_name: `Vendor ${i}`,
            slug: `${products ? 'p' : 'v'}-${i}`,
          })).slice(page * perPage, page * perPage + perPage);
          return {
            index: r.indexName,
            query: (r.params?.['query'] as string | undefined) ?? '',
            params: '',
            hits,
            nbHits: total,
            page,
            nbPages: Math.ceil(total / perPage),
            hitsPerPage: perPage,
            processingTimeMS: 1,
            exhaustiveNbHits: true,
            exhaustiveFacetsCount: true,
            facets: products ? { categories: { AI: total } } : {},
          };
        }),
      });
    },
  };
  return { client, batches };
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A stand-in for the router's history tracking: the test says what kind of navigation it is. */
const traversal = {
  back: false,
  isTraversal: () => traversal.back,
  restoredEntryId: () => (traversal.back ? 7 : null),
  currentEntryId: () => 7,
  retiredEntryId: () => null,
};

function configure(engine: () => Promise<unknown>) {
  (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__ = CONFIG;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'search', component: SearchPage }]),
      { provide: HistoryTraversal, useValue: traversal },
      { provide: SEARCH_ENGINE_FACTORY, useValue: engine },
    ],
  });
}

function rowIds(el: HTMLElement): string[] {
  return [...el.querySelectorAll('aec-search-product-card a[href^="/products/"]')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

async function settle(fixture: { detectChanges(): void }, until: () => boolean) {
  for (let i = 0; i < 40 && !until(); i++) {
    await tick(10);
    fixture.detectChanges();
  }
}

describe('SearchPage on Back and Forward', () => {
  afterEach(() => {
    delete (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__;
    traversal.back = false;
    TestBed.resetTestingModule();
  });

  /** A fresh visit to `/search?q=zz` with two pages loaded, then left. */
  async function visitAndLeave(): Promise<{ rows: string[]; store: SearchHistoryStore }> {
    const { client } = makeClient();
    configure(async () => ({ lib: (await createSearchEngine(CONFIG)).lib, searchClient: client }));
    await TestBed.inject(Router).navigateByUrl('/search?q=zz');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    await settle(fixture, () => rowIds(el).length === 24);
    (
      el.querySelector('aec-pagination-footer button, aec-pagination-footer a') as HTMLElement
    ).click();
    await settle(fixture, () => rowIds(el).length === 48);
    const rows = rowIds(el);
    const store = TestBed.inject(SearchHistoryStore);
    fixture.destroy();
    return { rows, store };
  }

  it('a fresh visit stores what it showed and a fresh visit never reads it', async () => {
    const { rows, store } = await visitAndLeave();
    expect(rows).toHaveLength(48);
    expect(store.size).toBe(1);
    // A fresh navigation to the same URL renders the skeleton, not the stored rows.
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    expect(rowIds(fixture.nativeElement)).toEqual([]);
  });

  it('renders the stored rows in the first frame of a Back, before the search code loads', async () => {
    const { rows, store } = await visitAndLeave();
    const kept = store.read(key({ q: 'zz' }), 7);
    TestBed.resetTestingModule();
    configure(() => new Promise(() => undefined));
    TestBed.inject(SearchHistoryStore).write(key({ q: 'zz' }), 7, kept!);
    await TestBed.inject(Router).navigateByUrl('/search?q=zz');
    traversal.back = true;
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(rowIds(el)).toEqual(rows);
    expect(el.querySelector('#search-tab-products')?.textContent).toContain('60');
    expect(el.querySelector('aec-pagination-footer')?.textContent).toContain('48 of 60');
  });

  it('adopts the rows with one search, then "Load more" continues with no hit twice', async () => {
    const { rows, store } = await visitAndLeave();
    const kept = store.read(key({ q: 'zz' }), 7);
    TestBed.resetTestingModule();
    const { client, batches } = makeClient();
    configure(async () => ({ lib: (await createSearchEngine(CONFIG)).lib, searchClient: client }));
    TestBed.inject(SearchHistoryStore).write(key({ q: 'zz' }), 7, kept!);
    await TestBed.inject(Router).navigateByUrl('/search?q=zz');
    traversal.back = true;
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(rowIds(el)).toEqual(rows);

    await settle(fixture, () => batches.length > 0);
    await tick(20);
    fixture.detectChanges();
    // One search, for page 0 of both tabs, with the query in it: what a fresh
    // visit asks once its seeded query runs. No empty-query search first.
    expect(batches).toHaveLength(1);
    const main = batches[0]!.filter((r) => r.params?.['hitsPerPage'] === 24);
    expect(main.map((r) => [r.indexName, r.params?.['page'], r.params?.['query']])).toEqual([
      ['p_created_desc', 0, 'zz'],
      ['v_name_asc', 0, 'zz'],
    ]);
    // The rows on screen did not change.
    expect(rowIds(el)).toEqual(rows);

    (
      el.querySelector('aec-pagination-footer button, aec-pagination-footer a') as HTMLElement
    ).click();
    await settle(fixture, () => rowIds(el).length === 60);
    const pages = batches
      .slice(1)
      .flat()
      .filter((r) => r.indexName.startsWith('p'));
    expect(pages.map((r) => r.params?.['page'])).toEqual([2]);
    const after = rowIds(el);
    expect(after.slice(0, 48)).toEqual(rows);
    expect(new Set(after).size).toBe(60);
  });
});
