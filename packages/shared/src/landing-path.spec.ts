import { describe, expect, it } from 'vitest';

import { parseLandingPath } from './landing-path';

describe('parseLandingPath', () => {
  it.each([
    ['/products/acme', '/products/:slug', 'product'],
    ['/vendors/acme-inc', '/vendors/:slug', 'vendor'],
    ['/categories/estimating', '/categories/:slug', 'category'],
    ['/audiences/owners', '/audiences/:slug', 'audience'],
    ['/phases/design', '/phases/:slug', 'phase'],
    ['/trades/electrical', '/trades/:slug', 'trade'],
  ] as const)('%s → %s with a %s entity', (path, route, type) => {
    const slug = path.split('/')[2];
    expect(parseLandingPath(path)).toEqual({ route, entity: { type, slug } });
  });

  it('parses a pair page as the pair route with a pair entity', () => {
    expect(parseLandingPath('/products/acme/integrations/procore')).toEqual({
      route: '/products/:contextSlug/integrations/:otherSlug',
      entity: { type: 'pair' },
    });
  });

  it('treats a same-slug pair path as no pair', () => {
    expect(parseLandingPath('/products/acme/integrations/acme')).toEqual({
      route: '/products/acme/integrations/acme',
      entity: null,
    });
  });

  it('decodes a percent-encoded slug', () => {
    expect(parseLandingPath('/products/caf%C3%A9').entity).toEqual({
      type: 'product',
      slug: 'café',
    });
  });

  it('tolerates one trailing slash on a detail path', () => {
    expect(parseLandingPath('/categories/bim/')).toEqual({
      route: '/categories/:slug',
      entity: { type: 'category', slug: 'bim' },
    });
  });

  it.each([
    '/',
    '/products',
    '/categories',
    '/docs/vendors/plans',
    '/products/acme/review',
    '/categories/a/b',
    '/about/team',
    '/constructor/x',
    '/products/%E0%A4%A',
  ])('falls back to the path itself for %s', (path) => {
    expect(parseLandingPath(path)).toEqual({ route: path, entity: null });
  });
});
