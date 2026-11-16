import { describe, expect, it } from 'vitest';

import {
  LISTING_HISTORY_LIMIT,
  LISTING_HISTORY_MAX_AGE_MS,
  ListingHistoryStore,
  listingHistoryKey,
} from './listing-history-store';
import {
  type PaginatedIndexRequestConfig,
  buildIndexParams,
  indexRequestLine,
} from './paginated-index-request';

// A minimal ParamMap over a plain record, so the key is built by the same
// `buildIndexParams()` / `indexRequestLine()` the controller uses.
function qp(values: Record<string, string>) {
  return {
    get: (k: string) => values[k] ?? null,
    has: (k: string) => k in values,
    getAll: (k: string) => (k in values ? [values[k]!] : []),
    keys: Object.keys(values),
  };
}

const FILTERS = ['category_id', 'audience_id', 'phase_id', 'trade_id'] as const;

function keyFor(opts: {
  path?: string;
  apiPath?: string;
  page?: number;
  perPage?: number;
  query?: Record<string, string>;
  termSlug?: string;
}): string {
  const config: PaginatedIndexRequestConfig = {
    apiPath: opts.apiPath ?? '/api/products',
    validSorts: new Set(['created', 'name', 'rating']),
    defaultSort: 'created',
    perPage: opts.perPage,
    passthroughParams: FILTERS,
    baseParams: opts.termSlug ? () => ({ category_slug: opts.termSlug }) : undefined,
  };
  const params = buildIndexParams(config, qp(opts.query ?? {}) as never, {
    page: opts.page ?? 1,
  });
  return listingHistoryKey(opts.path ?? '/products', indexRequestLine(config, params));
}

describe('listingHistoryKey (AECI-1900)', () => {
  it('gives a different key for a change on any one payload axis', () => {
    const base = keyFor({});
    const variants: Record<string, string> = {
      route: keyFor({ path: '/categories/bim' }),
      apiPath: keyFor({ apiPath: '/api/vendors' }),
      page: keyFor({ page: 2 }),
      perPage: keyFor({ perPage: 12 }),
      sort: keyFor({ query: { sort: 'name' } }),
      termSlug: keyFor({ termSlug: 'bim' }),
      ...Object.fromEntries(FILTERS.map((f) => [f, keyFor({ query: { [f]: 'x' } })])),
    };
    for (const [axis, key] of Object.entries(variants)) {
      expect(key, `axis ${axis} must change the key`).not.toBe(base);
    }
    // And no two variants collide with each other either.
    expect(new Set(Object.values(variants)).size).toBe(Object.keys(variants).length);
  });

  it('separates two values on the same axis, including two term slugs', () => {
    expect(keyFor({ termSlug: 'bim' })).not.toBe(keyFor({ termSlug: 'cad' }));
    expect(keyFor({ query: { category_id: 'a' } })).not.toBe(
      keyFor({ query: { category_id: 'b' } }),
    );
    expect(keyFor({ query: { sort: 'name' } })).not.toBe(keyFor({ query: { sort: 'rating' } }));
  });

  it('ignores a presentation-only param such as ?view=, which does not change the rows', () => {
    expect(keyFor({ query: { view: 'table' } })).toBe(keyFor({}));
  });

  it('treats an unknown sort as the default sort, as the request does', () => {
    expect(keyFor({ query: { sort: 'banana' } })).toBe(keyFor({}));
  });
});

describe('ListingHistoryStore (AECI-1900)', () => {
  it('returns what was written under the same key and nothing under another', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, [{ page: 1 }, { page: 2 }]);
    expect(store.read('a', 7)).toEqual([{ page: 1 }, { page: 2 }]);
    expect(store.read('b', 7)).toBeNull();
  });

  it('keeps its own copy of the page list', () => {
    const store = new ListingHistoryStore();
    const pages = [{ page: 1 }];
    store.write('a', 7, pages);
    pages.push({ page: 2 });
    expect(store.read('a', 7)).toEqual([{ page: 1 }]);
  });

  it('stores nothing for an empty list', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, []);
    expect(store.read('a', 7)).toBeNull();
    expect(store.size).toBe(0);
  });

  it(`holds at most ${LISTING_HISTORY_LIMIT} listings and drops the least recently used`, () => {
    const store = new ListingHistoryStore();
    for (let i = 0; i < LISTING_HISTORY_LIMIT; i++) store.write(`k${i}`, 7, [i]);
    // Reading k0 makes it the most recent, so k1 is the oldest now.
    expect(store.read('k0', 7)).toEqual([0]);
    store.write('new', 7, [99]);
    expect(store.size).toBe(LISTING_HISTORY_LIMIT);
    expect(store.read('k1', 7)).toBeNull();
    expect(store.read('k0', 7)).toEqual([0]);
    expect(store.read('new', 7)).toEqual([99]);
  });

  it('replaces an entry in place on a second write to the same key', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, [1]);
    store.write('a', 7, [1, 2]);
    expect(store.size).toBe(1);
    expect(store.read('a', 7)).toEqual([1, 2]);
  });

  it('starts empty in every new instance: nothing survives a reload', () => {
    const first = new ListingHistoryStore();
    first.write('a', 7, [1]);
    expect(new ListingHistoryStore().read('a', 7)).toBeNull();
  });

  it('reads an entry up to five minutes after it was written', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, [1], 1_000);
    expect(LISTING_HISTORY_MAX_AGE_MS).toBe(5 * 60 * 1000);
    expect(store.read('a', 7, 1_000 + LISTING_HISTORY_MAX_AGE_MS)).toEqual([1]);
  });

  it('drops an entry older than five minutes, so the listing fetches fresh rows', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, [1], 1_000);
    expect(store.read('a', 7, 1_000 + LISTING_HISTORY_MAX_AGE_MS + 1)).toBeNull();
    expect(store.size).toBe(0);
    // Gone for good: a later read at an earlier time does not bring it back.
    expect(store.read('a', 7, 1_000)).toBeNull();
  });

  it('measures age from the latest write, not the first, and a read does not refresh it', () => {
    const store = new ListingHistoryStore();
    store.write('a', 7, [1], 0);
    store.write('a', 7, [1, 2], 4 * 60 * 1000);
    expect(store.read('a', 7, 8 * 60 * 1000)).toEqual([1, 2]);
    expect(store.read('a', 7, 4 * 60 * 1000 + LISTING_HISTORY_MAX_AGE_MS + 1)).toBeNull();
  });
});

describe('ListingHistoryStore history entries (AECI-1900)', () => {
  it('keeps one entry per history entry: two visits to one URL do not overwrite each other', () => {
    const store = new ListingHistoryStore();
    store.write('a', 3, [1]);
    store.write('a', 9, [1, 2, 3]);
    expect(store.read('a', 3)).toEqual([1]);
    expect(store.read('a', 9)).toEqual([1, 2, 3]);
    expect(store.size).toBe(2);
  });

  it('with an id, matches that id only: an unknown entry reads as nothing', () => {
    const store = new ListingHistoryStore();
    store.write('a', 3, [1]);
    expect(store.read('a', 4)).toBeNull();
    expect(store.read('b', 3)).toBeNull();
  });

  it('without an id, falls back to the newest entry for the URL', () => {
    const store = new ListingHistoryStore();
    store.write('a', 3, [1]);
    store.write('a', 9, [1, 2, 3]);
    store.write('b', 10, [7]);
    expect(store.read('a', null)).toEqual([1, 2, 3]);
  });

  it('an entry written without an id is found only by the fallback', () => {
    const store = new ListingHistoryStore();
    store.write('a', null, [1]);
    expect(store.read('a', 5)).toBeNull();
    expect(store.read('a', null)).toEqual([1]);
  });
});
