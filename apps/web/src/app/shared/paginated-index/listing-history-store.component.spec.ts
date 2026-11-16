import { describe, expect, it } from 'vitest';

import {
  LISTING_HISTORY_LIMIT,
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
    store.write('a', [{ page: 1 }, { page: 2 }]);
    expect(store.read('a')).toEqual([{ page: 1 }, { page: 2 }]);
    expect(store.read('b')).toBeNull();
  });

  it('keeps its own copy of the page list', () => {
    const store = new ListingHistoryStore();
    const pages = [{ page: 1 }];
    store.write('a', pages);
    pages.push({ page: 2 });
    expect(store.read('a')).toEqual([{ page: 1 }]);
  });

  it('stores nothing for an empty list', () => {
    const store = new ListingHistoryStore();
    store.write('a', []);
    expect(store.read('a')).toBeNull();
    expect(store.size).toBe(0);
  });

  it(`holds at most ${LISTING_HISTORY_LIMIT} listings and drops the least recently used`, () => {
    const store = new ListingHistoryStore();
    for (let i = 0; i < LISTING_HISTORY_LIMIT; i++) store.write(`k${i}`, [i]);
    // Reading k0 makes it the most recent, so k1 is the oldest now.
    expect(store.read('k0')).toEqual([0]);
    store.write('new', [99]);
    expect(store.size).toBe(LISTING_HISTORY_LIMIT);
    expect(store.read('k1')).toBeNull();
    expect(store.read('k0')).toEqual([0]);
    expect(store.read('new')).toEqual([99]);
  });

  it('replaces an entry in place on a second write to the same key', () => {
    const store = new ListingHistoryStore();
    store.write('a', [1]);
    store.write('a', [1, 2]);
    expect(store.size).toBe(1);
    expect(store.read('a')).toEqual([1, 2]);
  });

  it('starts empty in every new instance: nothing survives a reload', () => {
    const first = new ListingHistoryStore();
    first.write('a', [1]);
    expect(new ListingHistoryStore().read('a')).toBeNull();
  });
});
