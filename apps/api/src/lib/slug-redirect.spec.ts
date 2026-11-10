import { describe, expect, it } from 'vitest';

import { isRetiredSlugUrl, isSlugRedirectEntity, retiredSlugPaths } from './slug-redirect';

/**
 * The pure halves of the retired-slug map: the entity membership test and the
 * exact-path set the IndexNow drain and the GSC re-crawl queue filter on. The D1
 * reads are covered through `GET /api/slug-redirects*` in `routes/slug-redirects.spec.ts`.
 */
describe('isSlugRedirectEntity', () => {
  it('admits the two detail kinds and the four taxonomy kinds (AECI-979)', () => {
    for (const kind of ['product', 'vendor', 'category', 'audience', 'phase', 'trade']) {
      expect(isSlugRedirectEntity(kind)).toBe(true);
    }
  });

  it('rejects a kind no resolver reads', () => {
    expect(isSlugRedirectEntity('integration')).toBe(false);
    expect(isSlugRedirectEntity('categories')).toBe(false);
  });
});

describe('retiredSlugPaths', () => {
  it('maps every kind onto its public route segment', () => {
    const paths = retiredSlugPaths([
      { entity: 'product', from_slug: 'a', to_slug: 'b' },
      { entity: 'vendor', from_slug: 'a', to_slug: 'b' },
      { entity: 'category', from_slug: 'a', to_slug: 'b' },
      { entity: 'audience', from_slug: 'a', to_slug: 'b' },
      { entity: 'phase', from_slug: 'a', to_slug: 'b' },
      { entity: 'trade', from_slug: 'a', to_slug: 'b' },
    ]);
    expect([...paths].sort()).toEqual([
      '/audiences/a',
      '/categories/a',
      '/phases/a',
      '/products/a',
      '/trades/a',
      '/vendors/a',
    ]);
  });

  it('matches a retired taxonomy URL on its exact path, ignoring the query', () => {
    const paths = retiredSlugPaths([
      { entity: 'category', from_slug: 'reality-capture-scan-to-bim', to_slug: 'reality-capture' },
    ]);
    expect(
      isRetiredSlugUrl(
        'https://www.aecintegrations.com/categories/reality-capture-scan-to-bim?page=2',
        paths,
      ),
    ).toBe(true);
    expect(
      isRetiredSlugUrl('https://www.aecintegrations.com/categories/reality-capture', paths),
    ).toBe(false);
  });
});
