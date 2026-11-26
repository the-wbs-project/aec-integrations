import { describe, expect, it } from 'vitest';

import { ACCESSIBILITY_STATEMENT_PUBLISHED } from '../app/accessibility/accessibility-published';
import {
  CACHE_TAG_MAX_BYTES,
  CACHE_TAG_MAX_COUNT,
  CACHE_TAG_MAX_TAG_LENGTH,
  buildCacheTags,
  cacheTagInputsForPath,
  composeCacheTags,
  type CacheTagEntity,
} from './cache-tags';

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

  it('never throws when the composed value would exceed 16 KB (AECI-2025)', () => {
    const tooMany = Array.from({ length: 2_000 }, (_, i) => ({
      type: 'product',
      slug: `slug-${i.toString().padStart(8, '0')}`,
    }));
    const value = buildCacheTags({
      route: 'browse',
      entity: { type: 'category', slug: 'huge' },
      embedded: tooMany,
    });
    expect(value.length).toBeLessThanOrEqual(CACHE_TAG_MAX_BYTES);
    expect(value.startsWith('route:browse,category:huge,')).toBe(true);
  });

  it("exposes Cloudflare's limits", () => {
    expect(CACHE_TAG_MAX_BYTES).toBe(16_384);
    expect(CACHE_TAG_MAX_COUNT).toBe(1_000);
    expect(CACHE_TAG_MAX_TAG_LENGTH).toBe(1_024);
  });
});

/** A uuid-shaped id, 36 characters, the shape `integration:{id}` carries in production. */
function uuid(i: number): string {
  const hex = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * The embedded list a product page with `n` partners pushes, in the resolver's order
 * (`product-detail.resolver.ts` `pushEmbedded`): its own vendor first, then per row the
 * integration, the partner product and the partner's vendor, then the similar products.
 */
function productPageEmbedded(n: number, similar = 6): CacheTagEntity[] {
  const embedded: CacheTagEntity[] = [{ type: 'vendor', slug: 'procore-technologies', lead: true }];
  for (let i = 0; i < n; i++) {
    embedded.push({ type: 'integration', id: uuid(i) });
    embedded.push({
      type: 'product',
      slug: `partner-product-number-${String(i).padStart(4, '0')}`,
    });
    embedded.push({ type: 'vendor', slug: `partner-vendor-${String(i).padStart(4, '0')}` });
  }
  for (let i = 0; i < similar; i++) embedded.push({ type: 'product', slug: `similar-${i}` });
  return embedded;
}

const PRODUCT_PAGE = { route: 'detail', entity: { type: 'product', slug: 'procore' } } as const;

describe('composeCacheTags (AECI-2025)', () => {
  it('leaves an under-limit page byte-identical to the pre-cap composition', () => {
    const embedded = productPageEmbedded(40);
    const inputs = { ...PRODUCT_PAGE, embedded };
    // The pre-AECI-2025 rule, inline: route, entity, embedded in push order, deduped.
    const legacy = [
      ...new Set([
        'route:detail',
        'product:procore',
        ...embedded.map((e) => `${e.type}:${e.slug ?? e.id}`),
      ]),
    ].join(',');
    const composed = composeCacheTags(inputs);
    expect(composed.value).toBe(legacy);
    expect(buildCacheTags(inputs)).toBe(legacy);
    expect(composed.truncated).toBe(false);
    expect(composed.cacheable).toBe(true);
    expect(composed.droppedByType).toEqual({});
    expect(composed.kept).toBe(composed.total);
  });

  it('leaves an under-limit taxonomy page byte-identical, with `taxonomy` still last', () => {
    const embedded = Array.from({ length: 30 }, (_, i) => ({ type: 'product', slug: `p-${i}` }));
    const inputs = {
      route: 'index' as const,
      entity: { type: 'index', slug: 'home' },
      embedded,
      taxonomy: true,
    };
    const legacy = [
      'route:index',
      'index:home',
      ...embedded.map((e) => `product:${e.slug}`),
      'taxonomy',
    ].join(',');
    expect(buildCacheTags(inputs)).toBe(legacy);
    expect(composeCacheTags(inputs).truncated).toBe(false);
  });

  it('a dropped lead vendor makes the page uncacheable; a dropped partner vendor does not', () => {
    // The only tag that cannot be kept is the vendor, skipped for its character set.
    const lead = composeCacheTags({
      ...PRODUCT_PAGE,
      embedded: [
        { type: 'vendor', slug: 'acmé', lead: true },
        { type: 'product', slug: 'partner' },
      ],
    });
    expect(lead.droppedByType).toEqual({ vendor: 1 });
    expect(lead.cacheable).toBe(false);

    const partner = composeCacheTags({
      ...PRODUCT_PAGE,
      embedded: [
        { type: 'vendor', slug: 'acmé' },
        { type: 'product', slug: 'partner' },
      ],
    });
    expect(partner.droppedByType).toEqual({ vendor: 1 });
    expect(partner.cacheable).toBe(true);
  });

  it('a lead vendor dropped for room makes the page uncacheable', () => {
    // 700 `pair:` tags pushed before the lead fill the shared rank, so the lead is cut.
    const pairs = Array.from({ length: 700 }, (_, i) => ({
      type: 'pair',
      slug: `pair-${'z'.repeat(14)}-${String(i).padStart(3, '0')}`,
    }));
    const composed = composeCacheTags({
      ...PRODUCT_PAGE,
      embedded: [...pairs, { type: 'vendor', slug: 'procore-technologies', lead: true }],
    });
    expect(composed.value).not.toContain('vendor:procore-technologies');
    expect(composed.droppedByType['vendor']).toBe(1);
    expect(composed.cacheable).toBe(false);
  });

  it('a lead mark on a repeated vendor protects it at its first slot', () => {
    const composed = composeCacheTags({
      ...PRODUCT_PAGE,
      embedded: [
        { type: 'vendor', slug: 'acme' },
        { type: 'product', slug: 'p' },
        { type: 'vendor', slug: 'acme', lead: true },
      ],
    });
    expect(composed.value).toBe('route:detail,product:procore,vendor:acme,product:p');
  });

  it('fits a 400-partner product page and keeps every partner product tag', () => {
    const composed = composeCacheTags({ ...PRODUCT_PAGE, embedded: productPageEmbedded(400) });
    const kept = composed.value.split(',');

    expect(composed.bytes).toBeLessThanOrEqual(CACHE_TAG_MAX_BYTES);
    expect(new TextEncoder().encode(composed.value).length).toBe(composed.bytes);
    expect(kept.length).toBeLessThanOrEqual(CACHE_TAG_MAX_COUNT);
    expect(composed.truncated).toBe(true);
    // Only integration and partner vendor tags were left out, so the page stays cacheable.
    expect(composed.cacheable).toBe(true);
    for (let i = 0; i < 400; i++) {
      expect(kept).toContain(`product:partner-product-number-${String(i).padStart(4, '0')}`);
    }
    for (let i = 0; i < 6; i++) expect(kept).toContain(`product:similar-${i}`);
    expect(kept.slice(0, 2)).toEqual(['route:detail', 'product:procore']);
    // The lead vendor (the product's own, whose logo the facts card renders) is kept.
    expect(kept).toContain('vendor:procore-technologies');
    // `integration:` goes first: every one is dropped before any partner vendor is.
    expect(kept.some((t) => t.startsWith('integration:'))).toBe(false);
    expect(composed.droppedByType['integration']).toBe(400);
    expect(composed.droppedByType['product']).toBeUndefined();
    expect(composed.total).toBe(2 + 1 + 400 * 3 + 6);
    expect(composed.kept).toBe(kept.length);
  });

  it('reports a 600-partner page as uncacheable, with the dropped counts by type', () => {
    const composed = composeCacheTags({ ...PRODUCT_PAGE, embedded: productPageEmbedded(600) });
    expect(composed.cacheable).toBe(false);
    expect(composed.truncated).toBe(true);
    expect(composed.bytes).toBeLessThanOrEqual(CACHE_TAG_MAX_BYTES);
    expect(composed.droppedByType['product']).toBeGreaterThan(0);
    expect(composed.droppedByType['integration']).toBe(600);
    expect(composed.droppedByType['vendor']).toBe(600);
    const dropped = Object.values(composed.droppedByType).reduce((a, b) => a + b, 0);
    expect(composed.kept + dropped).toBe(composed.total);
    // The mandatory tags and the lead vendor still lead the kept list.
    expect(composed.value.split(',').slice(0, 3)).toEqual([
      'route:detail',
      'product:procore',
      'vendor:procore-technologies',
    ]);
  });

  it('caps at 1,000 tags even when the bytes would fit', () => {
    const embedded = Array.from({ length: 1_500 }, (_, i) => ({ type: 'phase', slug: `${i}` }));
    const composed = composeCacheTags({ route: 'index', embedded, taxonomy: true });
    expect(composed.kept).toBe(CACHE_TAG_MAX_COUNT);
    expect(composed.value.split(',')).toHaveLength(CACHE_TAG_MAX_COUNT);
    expect(composed.value.endsWith(',taxonomy')).toBe(true);
    // Term tags are not ones an "at once" purge travels by, so this is Tier A.
    expect(composed.cacheable).toBe(true);
    expect(composed.droppedByType['phase']).toBe(1_500 - (CACHE_TAG_MAX_COUNT - 2));
  });

  it('drops by type priority: integration, then other terms, then vendor, then product', () => {
    const big = (type: string, n: number): CacheTagEntity[] =>
      Array.from({ length: n }, (_, i) => ({ type, slug: `${type}-${'x'.repeat(40)}-${i}` }));
    const composed = composeCacheTags({
      route: 'browse',
      entity: { type: 'category', slug: 'structural' },
      embedded: [
        ...big('integration', 100),
        ...big('trade', 100),
        ...big('vendor', 100).map((v, i) => (i === 0 ? { ...v, lead: true } : v)),
        ...big('product', 100),
        ...big('pair', 100),
      ],
    });
    // 500 tags of ~60 bytes is ~30 KB, so roughly half must go, from the bottom up.
    expect(composed.droppedByType['integration']).toBe(100);
    expect(composed.droppedByType['trade']).toBe(100);
    expect(composed.droppedByType['pair']).toBeUndefined();
    expect(composed.droppedByType['product']).toBeUndefined();
    // The marked vendor is the lead and ranks with `pair:`; the rest are dropped next.
    expect(composed.value).toContain(`vendor:vendor-${'x'.repeat(40)}-0`);
    // Vendors are the rank the budget runs out in: some kept, some dropped.
    expect(composed.droppedByType['vendor']).toBeGreaterThan(0);
    expect(composed.droppedByType['vendor']).toBeLessThan(99);
    expect(composed.cacheable).toBe(true);
  });

  it('within a type, the first pushed wins', () => {
    const products = Array.from({ length: 700 }, (_, i) => ({
      type: 'product',
      slug: `p-${'y'.repeat(20)}-${String(i).padStart(3, '0')}`,
    }));
    const composed = composeCacheTags({ ...PRODUCT_PAGE, embedded: products });
    const kept = composed.value.split(',').filter((t) => t.startsWith('product:p-'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(products.slice(0, kept.length).map((p) => `product:${p.slug}`));
    expect(composed.cacheable).toBe(false);
  });

  it('is deterministic: the same inputs give the same header', () => {
    const inputs = { ...PRODUCT_PAGE, embedded: productPageEmbedded(500) };
    const first = composeCacheTags(inputs);
    for (let i = 0; i < 3; i++) expect(composeCacheTags(inputs)).toEqual(first);
  });

  it('never drops a mandatory tag for room', () => {
    const composed = composeCacheTags({
      route: 'index',
      entity: { type: 'index', slug: 'home' },
      embedded: Array.from({ length: 3_000 }, (_, i) => ({ type: 'product', slug: `p${i}` })),
      taxonomy: true,
    });
    const kept = composed.value.split(',');
    expect(kept).toContain('route:index');
    expect(kept).toContain('index:home');
    expect(kept).toContain('taxonomy');
    expect(kept[kept.length - 1]).toBe('taxonomy');
  });

  it('skips an over-long tag and a non-printable one, and counts them', () => {
    const composed = composeCacheTags({
      route: 'detail',
      entity: { type: 'product', slug: 'procore' },
      embedded: [
        { type: 'integration', id: 'a'.repeat(CACHE_TAG_MAX_TAG_LENGTH) },
        { type: 'trade', slug: 'é' },
        { type: 'trade', slug: 'has space' },
        { type: 'vendor', slug: 'fine' },
      ],
    });
    expect(composed.value).toBe('route:detail,product:procore,vendor:fine');
    expect(composed.invalid).toBe(3);
    expect(composed.droppedByType).toEqual({ integration: 1, trade: 2 });
    expect(composed.truncated).toBe(true);
    expect(composed.cacheable).toBe(true);
  });

  it('a tag of exactly 1,024 characters is valid', () => {
    const id = 'b'.repeat(CACHE_TAG_MAX_TAG_LENGTH - 'integration:'.length);
    const composed = composeCacheTags({ route: 'detail', embedded: [{ type: 'integration', id }] });
    expect(composed.invalid).toBe(0);
    expect(composed.value).toBe(`route:detail,integration:${id}`);
  });

  it('an invalid product tag makes the page uncacheable', () => {
    const composed = composeCacheTags({
      ...PRODUCT_PAGE,
      embedded: [{ type: 'product', slug: 'naïve' }],
    });
    expect(composed.cacheable).toBe(false);
  });
});

/**
 * Purge reach (AECI-2025). For a 400-partner product page, the tag each producer emits
 * for a partner entity must still be on the page:
 *
 * - promote of a partner product, or of an edge, emits `product:{slug}` for every product
 *   it touches (`promote-cache-tags.ts` `edgeProductSlugs`, CACHE_STRATEGY.md §3 rule 4b);
 * - a partner's logo upload or objection emits `product:{slug}` (`routes/logos.ts`);
 * - a claim flip emits `vendor:{slug}` plus every `product:{slug}` it owns
 *   (`lib/vendor-handback.ts` `claimFlipTags`).
 *
 * A dropped `integration:` tag is reached by the page's own `product:` tag, which every
 * edge promote emits. A dropped partner `vendor:` tag carries the vendor name only, so
 * the page is cached on `TAG_OVERFLOW_TTL` instead.
 */
describe('composeCacheTags purge reach for a 400-partner product page', () => {
  const composed = composeCacheTags({ ...PRODUCT_PAGE, embedded: productPageEmbedded(400) });
  const kept = new Set(composed.value.split(','));

  it.each(Array.from({ length: 400 }, (_, i) => i))(
    'partner %i: its product tag is on the page',
    (i) => {
      expect(kept.has(`product:partner-product-number-${String(i).padStart(4, '0')}`)).toBe(true);
    },
  );

  it("the page's own product tag, which every edge promote emits, is on the page", () => {
    expect(kept.has('product:procore')).toBe(true);
  });

  it("the product's own vendor, whose logo the facts card renders, is on the page", () => {
    expect(kept.has('vendor:procore-technologies')).toBe(true);
  });
});

describe('cacheTagInputsForPath', () => {
  it.each([
    // Home carries `index:home` (its purge handle for the AECI-305 stats refresh)
    // alongside `taxonomy`.
    ['/', { route: 'index', entity: { type: 'index', slug: 'home' }, taxonomy: true }],
    ['/about', { route: 'index' }],
    // /updates + /roadmap are static content pages with no §2 entity — route tag only.
    ['/updates', { route: 'index' }],
    ['/roadmap', { route: 'index' }],
    // AECI-804 — same shape: static content page, no §2 entity, route tag only.
    ['/methodology', { route: 'index' }],
    // AECI-1283 — the vendor landing page, same shape.
    ['/vendor-program', { route: 'index' }],
    // AECI-1474 — the listing request page, same shape.
    ['/vendor-program/list-your-product', { route: 'index' }],
    ['/legal', { route: 'index' }],
    ['/legal/privacy', { route: 'index' }],
    // AECI-1104, AECI-1248 — the product docs: static content, route tag only,
    // on the bare home, a section index and an article alike.
    ['/docs', { route: 'index' }],
    ['/docs/reviewers', { route: 'index' }],
    ['/docs/vendors/claiming-your-listing', { route: 'index' }],
    ['/products', { route: 'index', entity: { type: 'index', slug: 'products' } }],
    ['/products/procore', { route: 'detail', entity: { type: 'product', slug: 'procore' } }],
    ['/vendors/autodesk', { route: 'detail', entity: { type: 'vendor', slug: 'autodesk' } }],
    // AECI-294 — the product-PAIR page. The `pair:{min}__{max}` tag is
    // orientation-independent (both orientations below yield `pair:procore__revit`),
    // and both products are embedded so a promote on either purges the page.
    [
      '/products/procore/integrations/revit',
      {
        route: 'detail',
        entity: { type: 'pair', slug: 'procore__revit' },
        embedded: [
          { type: 'product', slug: 'procore' },
          { type: 'product', slug: 'revit' },
        ],
      },
    ],
    [
      '/products/revit/integrations/procore',
      {
        route: 'detail',
        entity: { type: 'pair', slug: 'procore__revit' },
        embedded: [
          { type: 'product', slug: 'revit' },
          { type: 'product', slug: 'procore' },
        ],
      },
    ],
    [
      '/categories',
      { route: 'index', entity: { type: 'index', slug: 'categories' }, taxonomy: true },
    ],
    [
      '/categories/structural',
      { route: 'browse', entity: { type: 'category', slug: 'structural' } },
    ],
    [
      '/audiences',
      { route: 'index', entity: { type: 'index', slug: 'audiences' }, taxonomy: true },
    ],
    [
      '/audiences/architecture',
      { route: 'browse', entity: { type: 'audience', slug: 'architecture' } },
    ],
    ['/phases', { route: 'index', entity: { type: 'index', slug: 'phases' }, taxonomy: true }],
    [
      '/phases/preconstruction',
      { route: 'browse', entity: { type: 'phase', slug: 'preconstruction' } },
    ],
    ['/trades', { route: 'index', entity: { type: 'index', slug: 'trades' }, taxonomy: true }],
    ['/trades/electrical', { route: 'browse', entity: { type: 'trade', slug: 'electrical' } }],
    // AECI-544 — a sub-floor trade is still cacheable and purgeable by tag; the
    // publication gate controls indexability, not cacheability.
    ['/trades/roofing', { route: 'browse', entity: { type: 'trade', slug: 'roofing' } }],
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
    // AECI-165 — the `/vendors` and `/integrations` index pages were removed and
    // now 301-redirect to `/products`, so the bare index paths are no longer
    // cacheable here (their `:slug` DETAIL paths still map — see above).
    '/vendors',
    '/integrations',
    // AECI-294 — `/integrations/:id` now 301-redirects to the pair page and never
    // reaches the SSR cache pipeline, so it maps to null here.
    '/integrations/abc-123',
  ])('returns null for non-cacheable path %s', (path) => {
    expect(cacheTagInputsForPath(path)).toBeNull();
  });

  it('composes into a valid Cache-Tag string for every mapped path', () => {
    const paths = [
      '/',
      '/about',
      '/methodology',
      '/vendor-program',
      '/vendor-program/list-your-product',
      '/updates',
      '/roadmap',
      '/legal/terms',
      '/docs',
      '/docs/reviewers',
      '/docs/vendors/your-seat',
      '/products',
      '/products/procore',
      '/products/procore/integrations/revit',
      '/vendors/autodesk',
      '/categories',
      '/categories/structural',
      '/audiences',
      '/audiences/architecture',
      '/phases',
      '/phases/preconstruction',
      '/trades',
      '/trades/electrical',
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

// AECI-1673 / AECI-1687 — the accessibility statement is a route-tag-only static
// page once published. While hidden it is the `**` 404, so it maps to null.
describe('cacheTagInputsForPath /accessibility (publish flag)', () => {
  it('maps to route:index only when published', () => {
    expect(cacheTagInputsForPath('/accessibility')).toEqual(
      ACCESSIBILITY_STATEMENT_PUBLISHED ? { route: 'index' } : null,
    );
  });
});
