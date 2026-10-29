import { describe, expect, it } from 'vitest';

import {
  PAGE_VIEW_DEDUPE_WINDOW_MS,
  SPECULATIVE_REQUEST_HEADERS,
  UNTRACKED_ROUTE_PREFIXES,
  PageViewPayloadSchema,
  hasPrivacySignal,
  isSpeculativeRequest,
  isUntrackedRoute,
} from './page-views';
import { TURNSTILE_VERDICTS, TurnstileVerdictPostSchema } from './page-view-turnstile';

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

  // AECI-1457 — the invisible widget's single-use token, optional.
  it('accepts a turnstile_token up to 2048 characters', () => {
    const token = 'x'.repeat(2048);
    expect(
      PageViewPayloadSchema.parse({ route: '/', turnstile_token: token }).turnstile_token,
    ).toBe(token);
  });

  it('leaves turnstile_token undefined when omitted', () => {
    expect(PageViewPayloadSchema.parse({ route: '/' }).turnstile_token).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['over 2048', 'x'.repeat(2049)],
    ['non-string', 42],
  ])('rejects a %s turnstile_token', (_label, turnstile_token) => {
    expect(PageViewPayloadSchema.safeParse({ route: '/', turnstile_token }).success).toBe(false);
  });
});

describe('TURNSTILE_VERDICTS (AECI-1457)', () => {
  it('is exactly pass, fail, unknown', () => {
    expect(TURNSTILE_VERDICTS).toEqual(['pass', 'fail', 'unknown']);
  });
});

describe('TurnstileVerdictPostSchema (AECI-1457)', () => {
  const TOKEN = '0.abc-token';

  it.each([
    '8c1a2b3c4d5e6f70',
    '8c1a2b3c4d5e6f70-IAD',
    '8C1A2B3C4D5E6F70-SJC',
    '8c1a2b3c4d5e6f70-ABCD',
  ])('accepts the Ray ID %s', (cf_ray) => {
    expect(TurnstileVerdictPostSchema.parse({ cf_ray, token: TOKEN })).toEqual({
      cf_ray,
      token: TOKEN,
    });
  });

  it.each([
    ['too short', '8c1a2b3c4d5e6f7'],
    ['non-hex', '8c1a2b3c4d5e6fzz'],
    ['bad colo', '8c1a2b3c4d5e6f70-I'],
    ['trailing junk', '8c1a2b3c4d5e6f70-IAD;x'],
    ['empty', ''],
  ])('rejects a %s cf_ray', (_label, cf_ray) => {
    expect(TurnstileVerdictPostSchema.safeParse({ cf_ray, token: TOKEN }).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['over 2048', 'x'.repeat(2049)],
    ['missing', undefined],
  ])('rejects a %s token', (_label, token) => {
    expect(
      TurnstileVerdictPostSchema.safeParse({ cf_ray: '8c1a2b3c4d5e6f70', token }).success,
    ).toBe(false);
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

// AECI-743 — a browser prefetch/prerender is a page the visitor may never see, so
// the SSR Worker must not count it as an arrival.
describe('isSpeculativeRequest', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it.each([
    ['sec-purpose', 'prefetch'],
    ['sec-purpose', 'prefetch;prerender'],
    ['sec-purpose', 'prefetch;anonymous-client-ip'],
    ['purpose', 'prefetch'],
    ['x-moz', 'prefetch'],
    ['x-purpose', 'preview'],
  ])('flags %s: %s', (name, value) => {
    expect(isSpeculativeRequest(h({ [name]: value }))).toBe(true);
  });

  it('matches a token LIST rather than comparing for equality', () => {
    // A prerender sends `prefetch;prerender` AND `Sec-Fetch-Dest: document`, so an
    // `=== "prefetch"` check would wave every prerender straight through — the one
    // speculative load that is otherwise indistinguishable from a real arrival.
    expect(isSpeculativeRequest(h({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSpeculativeRequest(h({ 'Sec-Purpose': 'Prefetch' }))).toBe(true);
  });

  it('does not flag an ordinary document navigation', () => {
    expect(
      isSpeculativeRequest(
        h({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }),
      ),
    ).toBe(false);
  });

  it('does not flag an unrelated value on a speculative header name', () => {
    expect(isSpeculativeRequest(h({ 'sec-purpose': 'something-else' }))).toBe(false);
  });

  it('checks every header in the exported set', () => {
    for (const name of SPECULATIVE_REQUEST_HEADERS) {
      expect(isSpeculativeRequest(h({ [name]: 'prefetch' }))).toBe(true);
    }
  });
});

describe('PAGE_VIEW_DEDUPE_WINDOW_MS', () => {
  it('is short enough that a genuine second view of a path is never suppressed', () => {
    // Ingest probes the current AND previous bucket, so the effective window is
    // double this. The Done-when of AECI-743 requires a real re-visit later in the
    // session to survive, which sets the ceiling.
    expect(PAGE_VIEW_DEDUPE_WINDOW_MS * 2).toBeLessThanOrEqual(30_000);
  });
});

describe('hasPrivacySignal (AECI-1386)', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it.each([
    ['sec-gpc', '1'],
    ['dnt', '1'],
    ['sec-gpc', ' 1 '],
    ['Sec-GPC', '1'],
  ])('flags %s: %j', (name, value) => {
    expect(hasPrivacySignal(h({ [name]: value }))).toBe(true);
  });

  it('flags a request that carries both signals', () => {
    expect(hasPrivacySignal(h({ 'sec-gpc': '1', dnt: '1' }))).toBe(true);
  });

  it('flags one signal even when the other is off', () => {
    expect(hasPrivacySignal(h({ 'sec-gpc': '0', dnt: '1' }))).toBe(true);
  });

  it.each([
    ['sec-gpc', '0'],
    ['dnt', '0'],
    ['dnt', 'yes'],
    ['sec-gpc', ''],
  ])('ignores %s: %j', (name, value) => {
    expect(hasPrivacySignal(h({ [name]: value }))).toBe(false);
  });

  it('ignores a request with neither header', () => {
    expect(hasPrivacySignal(h({ 'user-agent': 'Mozilla/5.0' }))).toBe(false);
  });
});
