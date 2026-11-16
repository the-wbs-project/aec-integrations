import type { Page } from '@playwright/test';

/**
 * A fixed Algolia for `/search` e2e specs (AECI-1899). The pattern is the home
 * finder test's (AECI-1868): `__AECI_ALGOLIA__` gets a stand-in config before
 * the page scripts run, and every multi-query lands on a Playwright route that
 * answers from the small catalogue below. The server's inline config replaces
 * the stand-in where one is set. Either way no query reaches a live index, so
 * the results, counts and order never move under the test.
 *
 * The answer follows Algolia where the specs depend on it: `facetFilters` (OR
 * inside a group, AND across groups), the query as a case-folded substring of
 * the name, `page` and `hitsPerPage`, and a facet with no matching value is
 * left out of `facets` entirely. Every sort replica returns the same order.
 */

export interface FakeProduct {
  objectID: string;
  name: string;
  slug: string;
  vendor_name: string;
  vendor_slug: string;
  logo_url: null;
  integration_count: number;
  review_count: number;
  rating_overall_avg: null;
  categories: string[];
  audiences: string[];
  phases: string[];
  trades: string[];
}

export interface FakeVendor {
  objectID: string;
  company_name: string;
  slug: string;
  logo_url: null;
  headquarters: string;
  integration_count: number;
  product_count: number;
  founded_year: number;
}

const pad = (n: number) => String(n).padStart(3, '0');

/**
 * 80 products named "Zz Fake Product 000" to "079". Products 0 to 9 are
 * Accounting & ERP tools with no trades, so `?trades=Roofing&categories=…ERP`
 * matches nothing and the trades facet is absent from the answer. The rest are
 * field tools, every third one for roofing.
 */
export const FAKE_PRODUCTS: FakeProduct[] = Array.from({ length: 80 }, (_, i) => {
  const accounting = i < 10;
  return {
    objectID: `zz-fake-product-${pad(i)}`,
    name: `Zz Fake Product ${pad(i)}`,
    slug: `zz-fake-product-${pad(i)}`,
    vendor_name: `Zz Fake Vendor ${pad(i % 7)}`,
    vendor_slug: `zz-fake-vendor-${pad(i % 7)}`,
    logo_url: null,
    integration_count: i % 13,
    review_count: 0,
    rating_overall_avg: null,
    categories: accounting ? ['Accounting & ERP'] : ['Field Management'],
    audiences: accounting ? ['Owner/Developer'] : ['General Contracting'],
    phases: accounting ? ['Closeout & Operations'] : ['Construction'],
    trades: accounting ? [] : i % 3 === 0 ? ['Roofing'] : ['Electrical'],
  };
});

/** 60 vendors named "Zz Fake Company 000" to "059". */
export const FAKE_VENDORS: FakeVendor[] = Array.from({ length: 60 }, (_, i) => ({
  objectID: `zz-fake-company-${pad(i)}`,
  company_name: `Zz Fake Company ${pad(i)}`,
  slug: `zz-fake-company-${pad(i)}`,
  logo_url: null,
  headquarters: 'Wellington, New Zealand',
  integration_count: i % 9,
  product_count: 1 + (i % 4),
  founded_year: 1990 + (i % 30),
}));

type SearchRecord = Record<string, unknown>;

interface QueryParams {
  indexName: string;
  query: string;
  page: number;
  hitsPerPage: number;
  facets: string[];
  facetFilters: (string | string[])[];
}

/** One Algolia query, from either request shape the clients send. */
function readQuery(raw: Record<string, unknown>): QueryParams {
  const merged: Record<string, unknown> = { ...raw };
  const params = raw['params'];
  if (typeof params === 'string') {
    for (const [key, value] of new URLSearchParams(params)) {
      try {
        merged[key] = JSON.parse(value);
      } catch {
        merged[key] = value;
      }
    }
  } else if (params && typeof params === 'object') {
    Object.assign(merged, params);
  }
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
  return {
    indexName: String(merged['indexName'] ?? ''),
    query: String(merged['query'] ?? ''),
    page: Number(merged['page'] ?? 0),
    hitsPerPage: Number(merged['hitsPerPage'] ?? 20),
    facets: list(merged['facets']),
    facetFilters: Array.isArray(merged['facetFilters'])
      ? (merged['facetFilters'] as (string | string[])[])
      : [],
  };
}

function matchesFilter(record: SearchRecord, filter: string): boolean {
  const at = filter.indexOf(':');
  const attribute = filter.slice(0, at);
  const value = filter.slice(at + 1);
  const field = record[attribute];
  return Array.isArray(field) ? field.includes(value) : String(field) === value;
}

/** Algolia's answer for one query against the fixed catalogue. */
export function answer(raw: Record<string, unknown>): Record<string, unknown> {
  const q = readQuery(raw);
  const vendors = q.indexName.includes('vendors');
  const catalogue: SearchRecord[] = vendors
    ? (FAKE_VENDORS as unknown as SearchRecord[])
    : (FAKE_PRODUCTS as unknown as SearchRecord[]);
  const nameKey = vendors ? 'company_name' : 'name';
  const text = q.query.trim().toLowerCase();
  const matched = catalogue.filter(
    (record) =>
      String(record[nameKey]).toLowerCase().includes(text) &&
      q.facetFilters.every((group) =>
        (Array.isArray(group) ? group : [group]).some((f) => matchesFilter(record, f)),
      ),
  );

  const facets: Record<string, Record<string, number>> = {};
  const wanted = q.facets.includes('*') ? [] : q.facets;
  for (const attribute of wanted) {
    const counts: Record<string, number> = {};
    for (const record of matched) {
      const field = record[attribute];
      for (const value of Array.isArray(field) ? field : [field]) {
        if (value === undefined || value === null || value === '') continue;
        counts[String(value)] = (counts[String(value)] ?? 0) + 1;
      }
    }
    // Algolia leaves out a facet with no value.
    if (Object.keys(counts).length > 0) facets[attribute] = counts;
  }

  const start = q.page * q.hitsPerPage;
  const hits = q.hitsPerPage > 0 ? matched.slice(start, start + q.hitsPerPage) : [];
  return {
    index: q.indexName,
    hits,
    nbHits: matched.length,
    page: q.page,
    nbPages: q.hitsPerPage > 0 ? Math.ceil(matched.length / q.hitsPerPage) : 0,
    hitsPerPage: q.hitsPerPage,
    processingTimeMS: 1,
    exhaustiveNbHits: true,
    exhaustiveFacetsCount: true,
    query: q.query,
    params: '',
    facets,
  };
}

/**
 * Point `/search` at the fixed catalogue. `delayMs` holds every answer back, so
 * a spec can tell rows the page restored from rows Algolia sent. `onQuery`
 * sees each query as the page sent it.
 */
export async function routeFakeAlgolia(
  page: Page,
  options: { delayMs?: number; onQuery?: (query: QueryParams) => void } = {},
): Promise<void> {
  await page.addInitScript(() => {
    (window as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2EFAKE',
      searchKey: 'e2e-search-only',
      indexes: {
        products: 'e2e_products',
        vendors: 'e2e_vendors',
        integrations: 'e2e_integrations',
      },
    };
  });
  await page.route(/\/1\/indexes\/\*\/queries/, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      requests?: Record<string, unknown>[];
    };
    const requests = body.requests ?? [];
    for (const request of requests) options.onQuery?.(readQuery(request));
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ results: requests.map(answer) }),
      })
      .catch(() => undefined);
  });
}
