import { describe, expect, it } from 'vitest';

import { UNTRACKED_ROUTE_PREFIXES, PageViewPayloadSchema, isUntrackedRoute } from './page-views';

describe('PageViewPayloadSchema', () => {
  it('parses a route-only payload', () => {
    const parsed = PageViewPayloadSchema.parse({ route: '/products/procore' });
    expect(parsed.route).toBe('/products/procore');
    expect(parsed.entity_type).toBeUndefined();
    expect(parsed.entity_id).toBeUndefined();
  });

  it('parses a payload with optional entity reference', () => {
    const parsed = PageViewPayloadSchema.parse({
      route: '/products/procore',
      entity_type: 'product',
      entity_id: 'procore',
    });
    expect(parsed.entity_type).toBe('product');
    expect(parsed.entity_id).toBe('procore');
  });

  it('rejects an empty route', () => {
    const result = PageViewPayloadSchema.safeParse({ route: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing route', () => {
    const result = PageViewPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // ─── AECI-585 ──────────────────────────────────────────────────────────────

  it('parses the concrete path alongside a route pattern', () => {
    const parsed = PageViewPayloadSchema.parse({
      route: '/categories/:slug',
      path: '/categories/bim-coordination',
    });
    expect(parsed.path).toBe('/categories/bim-coordination');
  });

  it('leaves path undefined when omitted (the API falls back to route)', () => {
    expect(PageViewPayloadSchema.parse({ route: '/products/procore' }).path).toBeUndefined();
  });

  it('rejects an unbounded path', () => {
    const result = PageViewPayloadSchema.safeParse({
      route: '/',
      path: `/${'a'.repeat(2048)}`,
    });
    expect(result.success).toBe(false);
  });

  it.each(['spa', 'arrival'] as const)('parses navigation=%s', (navigation) => {
    expect(PageViewPayloadSchema.parse({ route: '/', navigation }).navigation).toBe(navigation);
  });

  it('rejects a navigation value outside the enum', () => {
    // A closed enum is what keeps the column readable: an ad-hoc third value would
    // land in the same "unknown" bucket as null without saying so.
    expect(PageViewPayloadSchema.safeParse({ route: '/', navigation: 'prefetch' }).success).toBe(
      false,
    );
  });

  it('leaves navigation undefined when omitted', () => {
    expect(PageViewPayloadSchema.parse({ route: '/' }).navigation).toBeUndefined();
  });
});

describe('isUntrackedRoute (AECI-575)', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/reviews',
    '/admin/requests',
    '/admin/reviewers',
    '/admin/traffic/breakdown/by-country',
    '/admin/reviews?status=pending',
    '/admin/reviews#queue',
    '/account',
    '/account/',
  ])('excludes the operator-only route %s', (route) => {
    expect(isUntrackedRoute(route)).toBe(true);
  });

  // Prefix matching must not swallow public routes that merely start with the
  // same letters — a false positive here silently deletes real traffic.
  it.each([
    '/',
    '/admins',
    '/administrators',
    '/accounts',
    '/account-settings',
    '/products/admin-tool',
    '/products/procore',
    '/vendors/autodesk',
    '/search?q=admin',
    '/categories/accounting',
  ])('keeps tracking the public route %s', (route) => {
    expect(isUntrackedRoute(route)).toBe(false);
  });

  it('covers every declared prefix', () => {
    for (const prefix of UNTRACKED_ROUTE_PREFIXES) {
      expect(isUntrackedRoute(prefix)).toBe(true);
      expect(isUntrackedRoute(`${prefix}/nested/deeply`)).toBe(true);
    }
  });
});
