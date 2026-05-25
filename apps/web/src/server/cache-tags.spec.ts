import { describe, expect, it } from 'vitest';

import { CACHE_TAG_MAX_BYTES, buildCacheTags, cacheTagInputsForPath } from './cache-tags';

describe('buildCacheTags', () => {
  it('emits the route-class tag and the entity tag for a detail page', () => {
    expect(buildCacheTags({ route: 'detail', entity: { type: 'product', slug: 'procore' } })).toBe(
      'route:detail,product:procore',
    );
  });

  it('adds embedded-entity tags', () => {
    expect(
      buildCacheTags({
        route: 'detail',
        entity: { type: 'product', slug: 'procore' },
        embedded: [{ type: 'vendor', slug: 'procore-inc' }],
      }),
    ).toBe('route:detail,product:procore,vendor:procore-inc');
  });

  it('uses id when slug is absent (integration:<id>)', () => {
    expect(
      buildCacheTags({ route: 'detail', entity: { type: 'integration', id: 'abc-123' } }),
    ).toBe('route:detail,integration:abc-123');
  });

  it('prefers slug over id when both are set', () => {
    expect(
      buildCacheTags({
        route: 'detail',
        entity: { type: 'product', slug: 'procore', id: 'should-be-ignored' },
      }),
    ).toBe('route:detail,product:procore');
  });

  it('appends `taxonomy` when opts.taxonomy is true', () => {
    expect(buildCacheTags({ route: 'index', taxonomy: true })).toBe('route:index,taxonomy');
  });

  it('emits an index-page entity tag (index:products)', () => {
    expect(buildCacheTags({ route: 'index', entity: { type: 'index', slug: 'products' } })).toBe(
      'route:index,index:products',
    );
  });

  it('emits a browse-page entity tag (category:<slug>)', () => {
    expect(
      buildCacheTags({ route: 'browse', entity: { type: 'category', slug: 'structural' } }),
    ).toBe('route:browse,category:structural');
  });

  it('deduplicates duplicate entries between entity and embedded', () => {
    expect(
      buildCacheTags({
        route: 'detail',
        entity: { type: 'product', slug: 'procore' },
        embedded: [
          { type: 'product', slug: 'procore' },
          { type: 'vendor', slug: 'procore-inc' },
        ],
      }),
    ).toBe('route:detail,product:procore,vendor:procore-inc');
  });

  it('omits entities missing both slug and id without throwing', () => {
    expect(
      buildCacheTags({
        route: 'detail',
        entity: { type: 'product' },
        embedded: [{ type: 'vendor', slug: 'autodesk' }],
      }),
    ).toBe('route:detail,vendor:autodesk');
  });

  it('returns just the route tag when entity is omitted (static pages)', () => {
    expect(buildCacheTags({ route: 'index' })).toBe('route:index');
  });

  it('joins entries with a bare comma (no whitespace introduced)', () => {
    const value = buildCacheTags({
      route: 'browse',
      entity: { type: 'category', slug: 'structural' },
      embedded: [{ type: 'product', slug: 'procore' }],
      taxonomy: true,
    });
    // Slugs/types themselves never contain spaces in our vocabulary, so
    // this asserts the join itself is space-free.
    expect(value).not.toMatch(/ /);
    expect(value).toBe('route:browse,category:structural,product:procore,taxonomy');
  });

  it('accepts an empty embedded array', () => {
    expect(
      buildCacheTags({
        route: 'detail',
        entity: { type: 'product', slug: 'procore' },
        embedded: [],
      }),
    ).toBe('route:detail,product:procore');
  });

  it('throws when the composed value exceeds 16 KB', () => {
    const tooMany = Array.from({ length: 2_000 }, (_, i) => ({
      type: 'product',
      slug: `slug-${i.toString().padStart(8, '0')}`,
    }));
    expect(() =>
      buildCacheTags({
        route: 'browse',
        entity: { type: 'category', slug: 'huge' },
        embedded: tooMany,
      }),
    ).toThrow(/exceeds 16384 bytes/);
  });

  it('exposes the byte limit for callers that want to pre-check', () => {
    expect(CACHE_TAG_MAX_BYTES).toBe(16_384);
  });
});

describe('cacheTagInputsForPath', () => {
  it.each([
    ['/', { route: 'index', taxonomy: true }],
    ['/about', { route: 'index' }],
    ['/legal', { route: 'index' }],
    ['/legal/privacy', { route: 'index' }],
    ['/products', { route: 'index', entity: { type: 'index', slug: 'products' } }],
    ['/vendors', { route: 'index', entity: { type: 'index', slug: 'vendors' } }],
    ['/integrations', { route: 'index', entity: { type: 'index', slug: 'integrations' } }],
    ['/products/procore', { route: 'detail', entity: { type: 'product', slug: 'procore' } }],
    ['/vendors/autodesk', { route: 'detail', entity: { type: 'vendor', slug: 'autodesk' } }],
    ['/integrations/abc-123', { route: 'detail', entity: { type: 'integration', id: 'abc-123' } }],
    ['/categories', { route: 'browse', entity: { type: 'category', slug: '*' } }],
    [
      '/categories/structural',
      { route: 'browse', entity: { type: 'category', slug: 'structural' } },
    ],
    ['/disciplines', { route: 'browse', entity: { type: 'discipline', slug: '*' } }],
    [
      '/disciplines/architecture',
      { route: 'browse', entity: { type: 'discipline', slug: 'architecture' } },
    ],
    ['/phases', { route: 'browse', entity: { type: 'phase', slug: '*' } }],
    [
      '/phases/preconstruction',
      { route: 'browse', entity: { type: 'phase', slug: 'preconstruction' } },
    ],
  ])('maps %s to the expected inputs', (path, expected) => {
    expect(cacheTagInputsForPath(path)).toEqual(expected);
  });

  it.each([
    '/api/health',
    '/auth/login',
    '/account',
    '/account/settings',
    '/search',
    '/does-not-exist',
    '/products/procore/extra',
  ])('returns null for non-cacheable path %s', (path) => {
    expect(cacheTagInputsForPath(path)).toBeNull();
  });

  it('composes into a valid Cache-Tag string for every mapped path', () => {
    const paths = [
      '/',
      '/about',
      '/legal/terms',
      '/products',
      '/vendors',
      '/integrations',
      '/products/procore',
      '/vendors/autodesk',
      '/integrations/abc',
      '/categories',
      '/categories/structural',
      '/disciplines',
      '/disciplines/architecture',
      '/phases',
      '/phases/preconstruction',
    ];
    for (const p of paths) {
      const inputs = cacheTagInputsForPath(p);
      expect(inputs, p).not.toBeNull();
      const value = buildCacheTags(inputs!);
      expect(value).toMatch(/^route:(detail|index|browse)/);
      expect(value).not.toMatch(/ /);
    }
  });
});
