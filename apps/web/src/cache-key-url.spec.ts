import { describe, expect, it } from 'vitest';

import { cacheKeyUrl } from './server-runtime';

// AECI-145 / Phase 3.12 — the deterministic proof for the acceptance criterion
// "distinct facets → distinct cache entries". The edge cache is keyed by URL
// only (Cloudflare Pro folds neither `Vary` nor `Cache-Tag` into the key), and
// `cacheKeyUrl()` IS that key. So whether two facet combinations land in
// distinct edge entries — or collapse into one — is decided entirely here.
//
// This lives as a unit test, NOT an HTTP HIT/MISS e2e, on purpose: the
// edge-cache integration runner (`scripts/run-extra-tests.sh`) SKIPS all
// cache-observation tests on localhost because Miniflare's `caches.default`
// doesn't behave like Cloudflare's edge. The facet e2e (`e2e/facets.spec.ts`)
// asserts the complementary half — that distinct facet URLs carry the *same*
// Cache-Tag (facets live in the key, not the tag).

const ORIGIN = 'https://aeci.test';
const key = (pathWithQuery: string): string => cacheKeyUrl(new URL(pathWithQuery, ORIGIN));

describe('cacheKeyUrl — distinct facets → distinct cache entries (AECI-145)', () => {
  it('forks the key for distinct values of the same facet dimension', () => {
    expect(key('/products?category_id=cat-a')).not.toBe(key('/products?category_id=cat-b'));
  });

  it('forks the key across different facet dimensions with the same value', () => {
    expect(key('/products?category_id=x')).not.toBe(key('/products?audience_id=x'));
  });

  it('forks the key when a second facet dimension is added', () => {
    expect(key('/products?category_id=x&audience_id=y')).not.toBe(key('/products?category_id=x'));
  });

  it('keeps all three taxonomy dimensions in the key', () => {
    const k = key('/products?category_id=a&audience_id=b&phase_id=c');
    expect(k).toContain('category_id=a');
    expect(k).toContain('audience_id=b');
    expect(k).toContain('phase_id=c');
  });
});

describe('cacheKeyUrl — ?view= forks the /products key (AECI-190)', () => {
  // `/products` SSR-renders a different layout for `?view=table` (dense table)
  // vs. the card-grid default. If `view` weren't in the allowlist the two
  // renders would collapse onto one entry and the edge would serve whichever
  // warmed the key first — so the table and cards URLs MUST get distinct keys.
  it('forks the key for the table view vs. the cards default', () => {
    expect(key('/products?view=table')).not.toBe(key('/products'));
  });

  it('forks the key for table vs. an explicit cards view', () => {
    expect(key('/products?view=table')).not.toBe(key('/products?view=cards'));
  });

  it('keeps view alongside the other listing params', () => {
    const k = key('/products?view=table&sort=name&page=2');
    expect(k).toContain('view=table');
    expect(k).toContain('sort=name');
    expect(k).toContain('page=2');
  });
});

describe('cacheKeyUrl — canonicalization (param order must not fork the key)', () => {
  it('is invariant to the order of page + sort', () => {
    expect(key('/products?page=2&sort=name')).toBe(key('/products?sort=name&page=2'));
  });

  it('is invariant to the order of facet params', () => {
    expect(key('/products?category_id=x&audience_id=y')).toBe(
      key('/products?audience_id=y&category_id=x'),
    );
  });
});

describe('cacheKeyUrl — tracking/marketing params are stripped', () => {
  it('drops utm_* and fbclid while keeping content-affecting params', () => {
    expect(key('/products?category_id=x&utm_source=g&utm_medium=cpc&fbclid=z')).toBe(
      key('/products?category_id=x'),
    );
  });

  it('collapses a tracking-only query down to the bare index key', () => {
    expect(key('/products?utm_source=g&gclid=abc')).toBe(key('/products'));
  });
});

describe('cacheKeyUrl — origin + pathname preserved verbatim', () => {
  it('keeps origin and pathname, appending only the allowlisted params', () => {
    expect(key('/products?category_id=x')).toBe(`${ORIGIN}/products?category_id=x`);
  });

  it('returns the bare origin+pathname for a no-query listing URL', () => {
    expect(key('/products')).toBe(`${ORIGIN}/products`);
  });

  // LOCALES is en-US-only today (the default entry has an empty prefix), so
  // there is no non-trivial locale prefix to exercise. When a prefixed locale
  // lands, add a case asserting the prefix survives in the key (locale variance
  // is segmented by URL prefix, so the key MUST keep it).
});

describe('cacheKeyUrl — browse routes share the listing allowlist', () => {
  it('forks the key for distinct facets on a /categories/:slug browse page', () => {
    expect(key('/categories/structural?audience_id=a')).not.toBe(
      key('/categories/structural?audience_id=b'),
    );
  });

  it('preserves the browse pathname and keeps the facet param', () => {
    expect(key('/categories/structural?audience_id=a')).toBe(
      `${ORIGIN}/categories/structural?audience_id=a`,
    );
  });
});

describe('cacheKeyUrl — non-listing routes strip every param', () => {
  it('strips even page/sort on a detail route (no cacheKeyParams)', () => {
    expect(key('/products/procore?page=2&sort=name')).toBe(`${ORIGIN}/products/procore`);
  });

  it('strips the query on an uncacheable/unmatched route (e.g. /search)', () => {
    expect(key('/search?q=revit')).toBe(`${ORIGIN}/search`);
  });
});
