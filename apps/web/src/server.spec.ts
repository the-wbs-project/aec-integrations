import { VersionResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  LOCALES,
  NOT_FOUND_TTL,
  VISITOR_STATE_COOKIES,
  applyCfContextHeaders,
  buildCacheControl,
  cacheControlForRoute,
  createApp,
  hasSessionCookie,
  isAdminPath,
  isVendorPath,
  isCacheableRoute,
  isPreviewPath,
  isReviewPath,
  stripLocalePrefix,
  stripVisitorStateCookies,
  type Bindings,
  type SsrRenderer,
} from './server-runtime';

// ─── Test fixtures ─────────────────────────────────────────────────────────

function recordingApiBinding(response?: Response): {
  binding: { API: Fetcher; ASSETS: Fetcher };
  calls: Request[];
} {
  const calls: Request[] = [];
  const fetcher = {
    fetch: vi.fn(async (input: Request) => {
      calls.push(input);
      return (
        response ??
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }),
  } as unknown as Fetcher;
  return {
    binding: { API: fetcher, ASSETS: {} as Fetcher },
    calls,
  };
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

/**
 * SSR renderer stub that echoes the inbound request's `Cookie` header into
 * the response body. Lets us assert that the cookies the renderer *saw* match
 * what the cookie-stripping middleware intended.
 */
function cookieEchoRenderer(): SsrRenderer {
  return async (req) => {
    const cookie = req.headers.get('cookie') ?? '<none>';
    return new Response(`cookie:${cookie}`, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };
}

function fixedRenderer(response: Response): SsrRenderer {
  return async () => response.clone();
}

// ─── Pure helper unit tests ────────────────────────────────────────────────

describe('LOCALES', () => {
  it('matches angular.json i18n.locales for Phase 1 (en-US only)', () => {
    expect(LOCALES).toEqual([{ locale: 'en-US', prefix: '', dir: 'ltr' }]);
    expect(DEFAULT_LOCALE).toBe('en-US');
  });
});

describe('stripLocalePrefix', () => {
  it('returns the default locale and pathname unchanged when no prefix matches', () => {
    expect(stripLocalePrefix('/products/procore')).toEqual({
      locale: DEFAULT_LOCALE,
      path: '/products/procore',
    });
  });

  it('preserves the root path', () => {
    expect(stripLocalePrefix('/')).toEqual({
      locale: DEFAULT_LOCALE,
      path: '/',
    });
  });
});

describe('stripVisitorStateCookies', () => {
  it('returns the original request when no cookie header is present', () => {
    const req = new Request('https://x/', {});
    expect(stripVisitorStateCookies(req)).toBe(req);
  });

  it('returns the original request when no visitor-state cookies are present', () => {
    const req = new Request('https://x/', {
      headers: { cookie: 'sb-access-token=abc; csrf=xyz' },
    });
    expect(stripVisitorStateCookies(req)).toBe(req);
  });

  it('is a no-op in Stage 1 — VISITOR_STATE_COOKIES is empty (AECI-226 removed `theme`)', () => {
    // `theme` was the only visitor-state cookie; it was removed with the dark
    // theme. With an empty list nothing is stripped — arbitrary prefs and auth
    // cookies alike pass through. The mechanism is retained (see the next test).
    expect(VISITOR_STATE_COOKIES).toEqual([]);
    const req = new Request('https://x/', {
      headers: { cookie: 'sb-access-token=abc; ui-pref=compact; csrf=xyz' },
    });
    expect(stripVisitorStateCookies(req)).toBe(req);
  });

  it('strips every cookie listed in VISITOR_STATE_COOKIES (extends automatically)', () => {
    // Defensive: if a future change repopulates the list (e.g. the Stage 2
    // vendor-portal theme), the strip behavior must extend automatically.
    // Builds a synthetic cookie header from the list; with it empty this is the
    // pass-through (no-op) case.
    const cookieHeader = [
      'session=keep-me',
      ...VISITOR_STATE_COOKIES.map((name) => `${name}=v`),
    ].join('; ');
    const req = new Request('https://x/', { headers: { cookie: cookieHeader } });
    const stripped = stripVisitorStateCookies(req);
    expect(stripped.headers.get('cookie')).toBe('session=keep-me');
  });
});

describe('isPreviewPath', () => {
  it('matches /preview and /preview/* paths', () => {
    expect(isPreviewPath('/preview')).toBe(true);
    expect(isPreviewPath('/preview/vendor-detail')).toBe(true);
    expect(isPreviewPath('/preview/anything/deeper')).toBe(true);
  });

  it('does not match unrelated paths or sibling segments', () => {
    expect(isPreviewPath('/')).toBe(false);
    expect(isPreviewPath('/previews')).toBe(false);
    expect(isPreviewPath('/products/preview')).toBe(false);
    expect(isPreviewPath('/preview-something')).toBe(false);
  });
});

describe('cacheControlForRoute', () => {
  // WC-3 (AECI-317) — data-backed detail + index/browse routes carry the stale
  // resilience directives; static (`/about`, `/legal`) do not.
  const R = { staleWhileRevalidate: 60, staleIfError: 86_400 };
  it.each([
    ['/', { edge: 900, browser: 300, ...R }],
    ['/about', { edge: 86_400, browser: 3_600 }],
    // Static content pages share the /about TTL. /roadmap is noindex but still
    // cacheable — indexability and cacheability are independent.
    ['/updates', { edge: 86_400, browser: 3_600 }],
    ['/roadmap', { edge: 86_400, browser: 3_600 }],
    ['/legal/privacy', { edge: 86_400, browser: 3_600 }],
    ['/products/procore', { edge: 900, browser: 0, ...R }],
    ['/vendors/autodesk', { edge: 900, browser: 0, ...R }],
    // AECI-294 — the product-PAIR page is a detail-class route (900/0).
    ['/products/procore/integrations/revit', { edge: 900, browser: 0, ...R }],
    // CACHE_STRATEGY.md §4 — index pages AND taxonomy browse pages (category /
    // audience / phase / trade) are 5 min edge / 0 browser. (AECI-61 corrected
    // the taxonomy rows from a stale 30 min edge.) `...R` is the WC-3 resilience
    // pair, which spreads into every data-backed index/browse row.
    ['/products', { edge: 300, browser: 0, ...R }],
    ['/categories', { edge: 300, browser: 0, ...R }],
    ['/categories/design', { edge: 300, browser: 0, ...R }],
    ['/audiences/structural', { edge: 300, browser: 0, ...R }],
    ['/phases/preconstruction', { edge: 300, browser: 0, ...R }],
    ['/trades', { edge: 300, browser: 0, ...R }],
    ['/trades/electrical', { edge: 300, browser: 0, ...R }],
  ])('returns the §9.2 TTL for %s', (path, expected) => {
    expect(cacheControlForRoute(new URL(`https://x${path}`))).toEqual(expected);
  });

  it.each([
    '/api/health',
    '/auth/login',
    '/account',
    '/account/settings',
    // AECI-203 — the admin surface is non-cacheable (fail-closed classifier).
    // AECI-576 / ADMIN_PANEL_SPEC §9.2 keeps that true for the console screens:
    // every `/admin/*` route must stay absent from ROUTE_CACHE_PATTERNS, because
    // a cached admin response is a visitor-state leak.
    '/admin',
    '/admin/reviews',
    '/admin/overview',
    // AECI-692 — the user surface renders names, email addresses and ban state.
    // If any /admin route were ever cacheable this is the one that would hurt
    // most, so it is pinned here alongside the others.
    '/admin/users',
    '/search',
    '/does-not-exist',
    '/products/procore/extra',
    // AECI-121 — `/disciplines/*` is no longer in the SSR cache matrix; it 301-
    // redirects to `/audiences/*` and the redirect handler sets its own headers.
    '/disciplines/structural',
    // AECI-165 — the `/vendors` and `/integrations` INDEX pages were removed; they
    // 301-redirect to `/products` (the redirect handler sets its own headers), so
    // the bare index paths are no longer in the SSR cache matrix. The `:slug`
    // DETAIL paths remain cacheable (asserted above).
    '/vendors',
    '/integrations',
    // AECI-294 — `/integrations/:id` now 301-redirects to the pair page (the
    // redirect handler sets its own headers), so it's out of the SSR cache matrix.
    '/integrations/abc-123',
  ])('returns null (non-cacheable) for %s', (path) => {
    expect(cacheControlForRoute(new URL(`https://x${path}`))).toBeNull();
  });
});

describe('isCacheableRoute', () => {
  it('returns true for cacheable routes', () => {
    expect(isCacheableRoute(new URL('https://x/'))).toBe(true);
    expect(isCacheableRoute(new URL('https://x/products/foo'))).toBe(true);
  });

  it('returns false for non-cacheable routes', () => {
    expect(isCacheableRoute(new URL('https://x/account/settings'))).toBe(false);
    expect(isCacheableRoute(new URL('https://x/api/health'))).toBe(false);
  });

  // ADMIN_PANEL_SPEC.md §9.2 (AECI-574). The operator console renders one
  // admin's view of the site; the edge cache is keyed by URL, so a single
  // cacheable /admin response would serve that view to the next visitor. The
  // panel spec makes "absent from ROUTE_CACHE_PATTERNS" a standing requirement,
  // and this is where that requirement is enforced in code rather than in prose.
  it('never caches /admin/* — an admin response at the edge is a visitor-state leak', () => {
    expect(isCacheableRoute(new URL('https://x/admin'))).toBe(false);
    expect(isCacheableRoute(new URL('https://x/admin/overview'))).toBe(false);
    expect(isCacheableRoute(new URL('https://x/admin/traffic'))).toBe(false);
    expect(isCacheableRoute(new URL('https://x/admin/reviews'))).toBe(false);
    expect(isCacheableRoute(new URL('https://x/admin/users'))).toBe(false);
    expect(
      isCacheableRoute(new URL('https://x/admin/users/00000000-0000-4000-8000-000000000700')),
    ).toBe(false);
    // Including under a locale prefix, since matching strips it first.
    expect(isCacheableRoute(new URL('https://x/en-US/admin/overview'))).toBe(false);
  });
});

// Cache-key normalization (utm strip / per-route allowlist / canonical order)
// moved out with the manual `caches.default` pipeline (WC-3 / AECI-317); WC-4
// (AECI-318) restored it via the gateway entrypoint (`cacheGateway` →
// `cacheKeyFor`), whose unit tests now live in `cache-key-url.spec.ts`.
// Front-of-Worker HIT/MISS is verified on a deployed preview via
// `Cf-Cache-Status` (WC-9), not miniflare.
// (AECI-544 `trade_id` cache-key coverage moved with it — see
// `cache-key-url.spec.ts`.)

describe('buildCacheControl', () => {
  it('formats edge and browser TTLs as a Cache-Control header value', () => {
    expect(buildCacheControl({ edge: 3600, browser: 300 })).toBe(
      'public, max-age=300, s-maxage=3600',
    );
    // AECI-62 — 404s revalidate on every navigation (max-age=0); edge still
    // holds them for 60s so a flood of 404s doesn't melt the SSR Worker.
    expect(buildCacheControl(NOT_FOUND_TTL)).toBe('public, max-age=0, s-maxage=60');
  });

  it('appends the WC-3 stale directives when the TTL opts into resilience', () => {
    expect(
      buildCacheControl({ edge: 900, browser: 0, staleWhileRevalidate: 60, staleIfError: 86_400 }),
    ).toBe('public, max-age=0, s-maxage=900, stale-while-revalidate=60, stale-if-error=86400');
  });
});

// ─── Smoke tests: end-to-end through the Hono app ──────────────────────────

describe('createApp /api/* passthrough (AC: cookies intact to API Worker)', () => {
  it('forwards /api/* requests to env.API.fetch with cookies unchanged', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://www.aecintegrations.com/api/health', {
      method: 'GET',
      headers: { cookie: 'sb-access-token=abc.def.ghi; ui-pref=compact' },
    });

    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!;
    // Cookies pass through the /api/* path untouched — the AECI-35 contract is
    // that visitor-state cookie stripping only ever runs on the cacheable SSR
    // branch, never on the API proxy. Auth cookies obviously must survive too.
    expect(forwarded.headers.get('cookie')).toBe('sb-access-token=abc.def.ghi; ui-pref=compact');
    expect(forwarded.method).toBe('GET');
    expect(new URL(forwarded.url).pathname).toBe('/api/health');
  });

  it('forwards GET /api/version to the API Worker unchanged (AECI-74)', async () => {
    // Guards: AECI-74 contract — apps/web must serve the same /api/version
    // shape as apps/api. The existing /api/* catch-all already does this;
    // this test pins it so a future refactor (e.g., per-route handlers) can't
    // silently break the promote-to-prod workflow's version probe.
    const apiBody = JSON.stringify({
      sha: 'abc123def456',
      deployedAt: '2026-05-25T03:30:00.000Z',
      environment: 'preview',
    });
    const { binding, calls } = recordingApiBinding(
      new Response(apiBody, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'private, no-store',
        },
      }),
    );
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://www.aecintegrations.com/api/version');
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(apiBody);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/version');
  });

  it('forwards non-GET /api/* requests (cookie-bearing writes)', async () => {
    const { binding, calls } = recordingApiBinding(new Response('{}', { status: 201 }));
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://www.aecintegrations.com/api/reviews', {
      method: 'POST',
      headers: {
        cookie: 'sb-access-token=session',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ rating: 5 }),
    });

    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());
    expect(res.status).toBe(201);
    expect(calls[0]!.headers.get('cookie')).toBe('sb-access-token=session');
    expect(calls[0]!.method).toBe('POST');
  });
});

describe('createApp X-Robots-Tag egress block (pre-launch crawler gate)', () => {
  const htmlRenderer = (): SsrRenderer =>
    fixedRenderer(
      new Response('<!doctype html><title>x</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

  it('stamps noindex,nofollow on SSR pages when ALLOW_INDEXING is unset (fail-closed)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://demo.aecintegrations.com/products/acme');
    const res = await app.fetch(
      req,
      { ...binding, ENV: 'production' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('bakes noindex + the SEO/CSP header set together onto a cacheable 200 — the stored payload (WC-8/AECI-322)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    // A product-detail render is cacheable, so this 200 is the exact response the
    // native Workers Cache (WC-3) stores and replays on every HIT — the Worker does
    // NOT run on a HIT. Every egress-time SEO/robots header must therefore already be
    // baked onto the MISS render; assert the whole set is present together (the
    // front-of-Worker "noindex + CSP/Vary baked pre-cache" guarantee, AECI-322 AC).
    const req = new Request('https://demo.aecintegrations.com/products/acme');
    const res = await app.fetch(
      req,
      { ...binding, ENV: 'production' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public'); // cacheable ⇒ the platform stores it
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('Vary')).toBe('Accept-Language');
  });

  it('does NOT stamp when ALLOW_INDEXING is "true" (post-launch indexable env)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://www.aecintegrations.com/products/acme');
    const res = await app.fetch(
      req,
      { ...binding, ENV: 'production', ALLOW_INDEXING: 'true' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('stamps redirects too (301 → /products) so removed URLs drop from the index', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://demo.aecintegrations.com/vendors');
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(301);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('does NOT stamp /api/* passthrough (raw proxy; JSON is never indexable)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://demo.aecintegrations.com/api/health');
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('serves a crawl-allowed, sitemap-less robots.txt when blocked, sitemap when indexable', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const blocked = await app.fetch(
      new Request('https://demo.aecintegrations.com/robots.txt'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    const blockedBody = await blocked.text();
    // Crawling stays permitted (so the noindex header is seen); no Disallow:/,
    // and the sitemap is withheld. The header is the authoritative block.
    expect(blockedBody).toContain('Allow: /');
    expect(blockedBody).not.toContain('Disallow: /');
    expect(blockedBody).not.toContain('Sitemap:');
    // The robots.txt body itself also carries the header.
    expect(blocked.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');

    const allowed = await app.fetch(
      new Request('https://www.aecintegrations.com/robots.txt'),
      { ...binding, ALLOW_INDEXING: 'true' } as unknown as Bindings,
      fakeExecutionContext(),
    );
    const allowedBody = await allowed.text();
    expect(allowedBody).toContain('Allow: /');
    expect(allowedBody).toContain('Sitemap: https://www.aecintegrations.com/sitemap.xml');
    expect(allowed.headers.get('X-Robots-Tag')).toBeNull();
  });
});

describe('createApp apex → www 301 (canonical host = www; ADR 0011 amendment)', () => {
  const htmlRenderer = (): SsrRenderer =>
    fixedRenderer(
      new Response('<!doctype html><title>x</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

  it('301-redirects the bare apex to www, preserving path + query', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://aecintegrations.com/products/acme?ref=waitlist&token=xyz');
    const res = await app.fetch(
      req,
      { ...binding, ENV: 'production', ALLOW_INDEXING: 'true' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(
      'https://www.aecintegrations.com/products/acme?ref=waitlist&token=xyz',
    );
    // Browser-cacheable but edge-excluded (`private`, no s-maxage): the Location
    // embeds the query, but the WC-4 gateway normalizes the shared-edge key
    // (AECI-318), so an edge entry would collapse distinct-query apex hits.
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('does NOT redirect www (falls through to SSR — the canonical served host)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: htmlRenderer() });

    const req = new Request('https://www.aecintegrations.com/');
    const res = await app.fetch(
      req,
      { ...binding, ENV: 'production', ALLOW_INDEXING: 'true' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
  });
});

describe('createApp GET /_version (AECI-92: SSR Worker’s OWN SHA, not proxied)', () => {
  it('returns the SSR Worker’s build metadata from env without calling the API binding', async () => {
    // Guards AECI-92: /_version must be served by the SSR Worker itself so CI
    // can verify the SSR bundle is current independently of the proxied
    // /api/version (which only ever reports the API Worker's SHA). If a future
    // refactor accidentally proxies this path, `calls` would be non-empty and
    // the gate would go back to validating only the API Worker.
    const { binding, calls } = recordingApiBinding();
    const env = {
      ...binding,
      ENV: 'preview',
      COMMIT_SHA: 'ssr123abc456',
      DEPLOYED_AT: '2026-06-02T03:30:00.000Z',
    };
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://www.aecintegrations.com/_version');
    const res = await app.fetch(req, env as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    // private, no-store so a stale value never lies about what's deployed and
    // the response is never pinned at the edge.
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const body = await res.json();
    expect(VersionResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      sha: 'ssr123abc456',
      deployedAt: '2026-06-02T03:30:00.000Z',
      environment: 'preview',
    });

    // Served by SSR, NOT proxied to the API Worker.
    expect(calls).toHaveLength(0);
  });

  it('falls back to sentinels when COMMIT_SHA/DEPLOYED_AT/ENV are unset', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://www.aecintegrations.com/_version');
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      sha: 'unknown',
      deployedAt: '1970-01-01T00:00:00.000Z',
      environment: 'development',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('createApp cookie-stripping on cacheable routes (AC: §9.1a)', () => {
  it('applies the visitor-state cookie-strip before SSR on the cacheable branch (§9.1a)', async () => {
    // The cacheable branch strips VISITOR_STATE_COOKIES before SSR so a
    // per-visitor cookie can't poison the URL-keyed edge cache. The list is
    // empty in Stage 1 (AECI-226 removed `theme`), so this is currently a
    // pass-through; the expectation is driven off stripVisitorStateCookies so
    // the test stays correct if a name is re-added (e.g. the Stage 2 vendor
    // portal). The renderer echoes back the cookie header SSR saw.
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: cookieEchoRenderer() });

    const cookie = 'ui-pref=compact; sb-access-token=abc';
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/', { headers: { cookie } }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const seen = await res.text();
    const expected =
      stripVisitorStateCookies(new Request('https://x/', { headers: { cookie } })).headers.get(
        'cookie',
      ) ?? '';
    expect(seen).toContain(expected);
    expect(seen).toContain('sb-access-token=abc');
  });

  it('sets Cache-Control + the SEO/security header set on the cacheable branch (AECI-89)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>home</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            vary: 'Cookie', // upstream tries to set a forbidden Vary — middleware must strip it
          },
        }),
      ),
    });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    // WC-3 (AECI-317) — home is an index-class route, so the TTL opts into the
    // `stale-while-revalidate` / `stale-if-error` resilience directives.
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=900, stale-while-revalidate=60, stale-if-error=86400',
    );

    // AC #1: the three headers are present on a representative cacheable route.
    const vary = res.headers.get('vary') ?? '';
    expect(vary).toBe('Accept-Language');
    expect(res.headers.get('link')).toContain('</sitemap.xml>; rel=sitemap');
    expect(res.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'unsafe-inline'",
    );

    // AC #2: the forbidden Vary values are never emitted (delete-then-set).
    expect(vary).not.toMatch(/cookie/i);
    expect(vary).not.toMatch(/user-agent/i);
  });
});

describe('createApp Cache-Tag header (AECI-56, CACHE_STRATEGY.md §2–3)', () => {
  function appReturningOk(): ReturnType<typeof createApp> {
    return createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>x</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    });
  }

  it.each([
    ['/', 'route:index,index:home,taxonomy'],
    ['/products', 'route:index,index:products'],
    ['/products/procore', 'route:detail,product:procore'],
    ['/vendors/autodesk', 'route:detail,vendor:autodesk'],
    // AECI-294 — the pair page: orientation-independent `pair:` tag + both products.
    [
      '/products/procore/integrations/revit',
      'route:detail,pair:procore__revit,product:procore,product:revit',
    ],
    ['/categories', 'route:index,index:categories,taxonomy'],
    ['/categories/structural', 'route:browse,category:structural'],
    ['/audiences/architecture', 'route:browse,audience:architecture'],
    ['/phases/preconstruction', 'route:browse,phase:preconstruction'],
    ['/trades', 'route:index,index:trades,taxonomy'],
    ['/trades/electrical', 'route:browse,trade:electrical'],
  ])('cacheable path %s emits Cache-Tag=%s', async (path, expected) => {
    const { binding } = recordingApiBinding();
    const res = await appReturningOk().fetch(
      new Request(`https://www.aecintegrations.com${path}`),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toBe(expected);
  });

  it('emits filter-independent Cache-Tags on a filtered listing/browse URL (AECI-143)', async () => {
    // Filters are query params; `cacheTagInputsForPath` is path-only, so a
    // filtered URL depends on the same entity set as the unfiltered one — no new
    // tag namespace is introduced by the facet sidebar.
    const { binding } = recordingApiBinding();
    const cases: [string, string][] = [
      ['/products?category_id=abc', 'route:index,index:products'],
      ['/categories/structural?audience_id=a', 'route:browse,category:structural'],
    ];
    for (const [path, expected] of cases) {
      const res = await appReturningOk().fetch(
        new Request(`https://www.aecintegrations.com${path}`),
        binding as unknown as Bindings,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-tag')).toBe(expected);
    }
  });

  it('omits Cache-Tag for static cacheable pages with no §2 entity (/about, /legal/*)', async () => {
    const { binding } = recordingApiBinding();
    for (const path of ['/about', '/legal/privacy']) {
      const res = await appReturningOk().fetch(
        new Request(`https://www.aecintegrations.com${path}`),
        binding as unknown as Bindings,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(200);
      // Route tag still set; entity-specific tag absent.
      expect(res.headers.get('cache-tag')).toBe('route:index');
    }
  });

  it('does not write Cache-Tag on non-cacheable paths (/account/settings)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>account</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    });
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/account/settings'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('writes Cache-Tag: route:404 on cacheable-route 404 responses (AECI-62)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('Not found', { status: 404 })),
    });
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(404);
    // Single sentinel tag — 404s have no entity identity, just the absence
    // class. Bulk-purge target after admin fixes a config typo, etc.
    expect(res.headers.get('cache-tag')).toBe('route:404');
  });
});

describe('createApp /disciplines → /audiences 301 redirects (AECI-121)', () => {
  function appWithSpyRenderer(): { app: ReturnType<typeof createApp>; ssrRenderer: SsrRenderer } {
    const ssrRenderer = vi.fn<SsrRenderer>(
      fixedRenderer(new Response('<html>x</html>', { status: 200 })),
    );
    return { app: createApp({ ssrRenderer }), ssrRenderer };
  }

  it('redirects /disciplines/:slug → /audiences/:slug (301, browser-cached, edge-excluded) without invoking SSR', async () => {
    const { binding } = recordingApiBinding();
    const { app, ssrRenderer } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/disciplines/architecture'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.aecintegrations.com/audiences/architecture',
    );
    // Browser-cacheable but `private` (edge-EXCLUDED, no s-maxage): the Location
    // embeds the query, but the WC-4 gateway strips the query from the shared-edge
    // key (AECI-318), so an edge entry would collapse distinct-query links onto one
    // Location. No `Cache-Tag` — nothing is edge-stored to purge.
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(res.headers.get('cache-tag')).toBeNull();
    // The redirect is emitted standalone — it never reaches the SSR pipeline.
    expect(ssrRenderer).not.toHaveBeenCalled();
  });

  it('redirects the bare /disciplines index → /audiences (browser-cached, no tag)', async () => {
    const { binding } = recordingApiBinding();
    const { app } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/disciplines'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.aecintegrations.com/audiences');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('preserves the query string across the redirect (edge-excluded so it is safe)', async () => {
    const { binding } = recordingApiBinding();
    const { app } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/disciplines/structural?utm_source=x'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.aecintegrations.com/audiences/structural?utm_source=x',
    );
    // Query preservation is only correct because the redirect is edge-excluded
    // (`private`) — the WC-4 gateway would otherwise collapse distinct queries
    // onto one edge entry (AECI-318).
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
  });
});

describe('createApp /vendors + /integrations → /products 301 redirects (AECI-165)', () => {
  function appWithSpyRenderer(): { app: ReturnType<typeof createApp>; ssrRenderer: SsrRenderer } {
    const ssrRenderer = vi.fn<SsrRenderer>(
      fixedRenderer(new Response('<html>x</html>', { status: 200 })),
    );
    return { app: createApp({ ssrRenderer }), ssrRenderer };
  }

  it.each(['/vendors', '/integrations'])(
    'redirects the removed %s index → /products (301, edge-cacheable) without invoking SSR',
    async (path) => {
      const { binding } = recordingApiBinding();
      const { app, ssrRenderer } = appWithSpyRenderer();
      const res = await app.fetch(
        new Request(`https://www.aecintegrations.com${path}`),
        binding as unknown as Bindings,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://www.aecintegrations.com/products');
      // Permanent mapping → long edge TTL (NOT no-store). No Cache-Tag: the
      // mapping never changes, so there is no purge handle to mint.
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
      expect(res.headers.get('cache-tag')).toBeNull();
      // The redirect is emitted standalone — it never reaches the SSR pipeline.
      expect(ssrRenderer).not.toHaveBeenCalled();
    },
  );

  it('drops the listing query string across the redirect (params do not map to /products)', async () => {
    const { binding } = recordingApiBinding();
    const { app } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/integrations?sourceProductId=abc&page=2'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.aecintegrations.com/products');
  });

  it('leaves the vendor DETAIL route to the SSR pipeline (only the bare index redirects)', async () => {
    const { binding } = recordingApiBinding();
    const { app, ssrRenderer } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/vendors/autodesk'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    // Detail page renders via SSR (200), not a redirect. (The integration DETAIL
    // route now 301s to the pair page — see the AECI-294 block below.)
    expect(res.status).toBe(200);
    expect(ssrRenderer).toHaveBeenCalledTimes(1);
  });
});

describe('createApp /vendors/bluebeam → /vendors/nemetschek-group 301 (AECI-685)', () => {
  function appWithSpyRenderer(): { app: ReturnType<typeof createApp>; ssrRenderer: SsrRenderer } {
    const ssrRenderer = vi.fn<SsrRenderer>(
      fixedRenderer(new Response('<html>x</html>', { status: 200 })),
    );
    return { app: createApp({ ssrRenderer }), ssrRenderer };
  }

  it('301-redirects the retracted vendor to its parent without invoking SSR', async () => {
    const { binding } = recordingApiBinding();
    const { app, ssrRenderer } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/vendors/bluebeam'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.aecintegrations.com/vendors/nemetschek-group',
    );
    // Same permanent-mapping headers as the AECI-165 redirects above.
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(ssrRenderer).not.toHaveBeenCalled();
  });

  it('wins over the SSR pipeline even while the vendor row still exists', async () => {
    // The redirect ships BEFORE the production row is deleted, so it must not
    // depend on the page 404ing — that is what leaves no window where the URL
    // is broken. A 200-returning API binding stands in for the live row.
    const { binding } = recordingApiBinding(
      new Response(JSON.stringify({ slug: 'bluebeam' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { app, ssrRenderer } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/vendors/bluebeam'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(ssrRenderer).not.toHaveBeenCalled();
  });

  it('leaves every other vendor detail page on the SSR pipeline', async () => {
    const { binding } = recordingApiBinding();
    const { app, ssrRenderer } = appWithSpyRenderer();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/vendors/nemetschek-group'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    // In particular the redirect TARGET must not itself redirect — that would
    // be a loop.
    expect(res.status).toBe(200);
    expect(ssrRenderer).toHaveBeenCalledTimes(1);
  });
});

describe('createApp /integrations/:id → pair 301 (AECI-294)', () => {
  const integrationResponse = () =>
    new Response(
      // The redirect only reads the two product slugs. Procore < Revit, so the
      // canonical context is procore.
      JSON.stringify({ id: 'int-1', source: { slug: 'revit' }, target: { slug: 'procore' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('301-redirects a legacy integration URL to the canonical pair page without invoking SSR', async () => {
    const { binding, calls } = recordingApiBinding(integrationResponse());
    const ssrRenderer = vi.fn<SsrRenderer>(
      fixedRenderer(new Response('<html>x</html>', { status: 200 })),
    );
    const app = createApp({ ssrRenderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/integrations/int-1'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.aecintegrations.com/products/procore/integrations/revit',
    );
    // Permanent, edge-cacheable mapping; tagged so a promote on the integration purges it.
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    expect(res.headers.get('cache-tag')).toBe('integration:int-1');
    expect(ssrRenderer).not.toHaveBeenCalled();
    // It resolved the slugs via the API binding.
    expect(calls.some((r) => new URL(r.url).pathname === '/api/integrations/int-1')).toBe(true);
  });

  it('renders the SSR 404 for an unknown integration id rather than 301-ing to /products', async () => {
    const notFound = new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
    const { binding, calls } = recordingApiBinding(notFound);
    // An unknown id falls through to the SSR pipeline (the `**` wildcard renders
    // the branded, accessible, noindex 404), so the renderer IS invoked and its
    // 404 status carries NOT_FOUND_TTL + the route:404 sentinel tag.
    const ssrRenderer = vi.fn<SsrRenderer>(
      fixedRenderer(new Response('<html>not found</html>', { status: 404 })),
    );
    const app = createApp({ ssrRenderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/integrations/does-not-exist'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expect(res.headers.get('cache-tag')).toBe('route:404');
    expect(ssrRenderer).toHaveBeenCalledTimes(1);
    // It consulted the API binding to distinguish a real id (301) from junk (404).
    expect(calls.some((r) => new URL(r.url).pathname === '/api/integrations/does-not-exist')).toBe(
      true,
    );
  });
});

describe('createApp /preview/* public-tier gate', () => {
  it.each<['production' | 'demo', string]>([
    ['production', 'https://prod.aecintegrations.com/preview/vendor-detail'],
    ['demo', 'https://demo.aecintegrations.com/preview/vendor-detail'],
  ])(
    'returns 404 with no-store on /preview/* on the %s tier (renderer never invoked)',
    async (env, url) => {
      const { binding } = recordingApiBinding();
      const ssrRenderer = vi.fn<SsrRenderer>(async (_req, ctx) =>
        fixedRenderer(new Response('<html>preview</html>', { status: 200 }))(
          new Request('https://x/'),
          ctx,
        ),
      );
      const app = createApp({ ssrRenderer });

      const res = await app.fetch(
        new Request(url),
        { ...binding, ENV: env } as unknown as Bindings,
        fakeExecutionContext(),
      );

      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(ssrRenderer).not.toHaveBeenCalled();
    },
  );

  it('serves /preview/* on preview Worker deploys (non-public tier)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>preview screen</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    });

    const res = await app.fetch(
      new Request('https://aeci-web.workers.dev/preview/vendor-detail'),
      { ...binding, ENV: 'preview' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>preview screen</html>');
  });
});

describe('createApp 404 handling (AC: §9.1b, not the pinned-404 trap)', () => {
  it('returns HTTP 404 with NOT_FOUND_TTL + route:404 tag for unknown (non-cacheable) routes', async () => {
    // AECI-62 — the global `**` wildcard route is non-cacheable per the
    // matcher table, but 404s on that branch must still carry NOT_FOUND_TTL
    // so a fix at the routing layer propagates quickly, and the route:404
    // sentinel tag so admin can bulk-purge after a fix.
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('Page not found.', { status: 404 })),
    });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/this-route-does-not-exist'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expect(res.headers.get('cache-tag')).toBe('route:404');
  });

  it('returns HTTP 404 with TTL ≤60s for cacheable-route 404s (e.g. /products/missing)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('Not found', { status: 404 })),
    });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    // AECI-62 — browser revalidates every navigation; edge caches for 60s.
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });
});

// WC-3 (AECI-317) removed the hand-rolled `caches.default` match/put pipeline,
// so the former "edge-cache integration (only 2xx is stored)" and "edge-cache key
// normalization end-to-end" describe blocks (which stubbed `globalThis.caches`
// and asserted on `cache.match`/`cache.put`) no longer have a Worker-level seam to
// exercise: under native Workers Cache a HIT never runs the Worker, and the
// platform stores from `Cache-Control`. Front-of-Worker HIT/MISS is now verified
// on a deployed preview via `Cf-Cache-Status` (WC-9). The response-header contract
// the native cache consumes is still covered here — Cache-Control (buildCacheControl,
// cacheControlForRoute), Cache-Tag emission, cookie-strip, and the 404 short-TTL.

/**
 * Reads one metric out of the PostHog OTLP metrics intake by NAME.
 *
 * Both the render distribution (histogram) and the `ssr.render` count (sum)
 * POST to the same `/i/v1/metrics` endpoint, so a URL probe cannot tell them
 * apart the way the old two-URL Datadog intake could (AECI-651). The returned
 * `tags` are the data point's attributes flattened back to `key:value` strings
 * so the existing tag assertions read unchanged.
 */
function otlpMetric(
  fetchSpy: ReturnType<typeof vi.fn>,
  name: string,
): { metric: string; type: number; tags: string[] } | undefined {
  type Attr = { key: string; value: { stringValue?: string; doubleValue?: number } };
  type Point = { attributes: Attr[] };
  type Metric = {
    name: string;
    sum?: { dataPoints: Point[] };
    gauge?: { dataPoints: Point[] };
    histogram?: { dataPoints: Point[] };
  };
  for (const call of fetchSpy.mock.calls) {
    if (!String(call[0]).endsWith('/i/v1/metrics')) continue;
    const body = JSON.parse(call[1]!.body as string) as {
      resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
    };
    for (const rm of body.resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.name !== name) continue;
          const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? [];
          const tags = (points[0]?.attributes ?? []).map(
            (a) => `${a.key}:${a.value.doubleValue ?? a.value.stringValue}`,
          );
          // `type: 1` mirrors the old count assertion: a monotonic sum.
          return { metric: m.name, type: m.sum ? 1 : m.gauge ? 3 : 0, tags };
        }
      }
    }
  }
  return undefined;
}

describe('createApp render-duration metric (AECI-66, Phase 2 §14)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Only metric submission uses global fetch here; the API binding is a
    // separate mock, so any distribution_points POST is unambiguously a metric.
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function envWithTelemetry(): Bindings {
    const { binding } = recordingApiBinding();
    return {
      ...binding,
      POSTHOG_PROJECT_KEY: 'phc_test_token',
      ENV: 'preview',
    } as unknown as Bindings;
  }

  function renderMetricSeries(): { metric: string; tags: string[] } | undefined {
    return otlpMetric(fetchSpy, 'aeci.page.render.duration_ms');
  }

  it('emits aeci.page.render.duration_ms with cache_status:MISS + route_class on a cacheable miss', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>p</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    });
    await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      envWithTelemetry(),
      fakeExecutionContext(),
    );
    const series = renderMetricSeries();
    expect(series?.metric).toBe('aeci.page.render.duration_ms');
    expect(series!.tags).toEqual(
      expect.arrayContaining(['route_class:detail', 'cache_status:MISS', 'status_class:2xx']),
    );
    // The raw `status_code` tag was dropped as a cardinality multiplier
    // (AECI-642/AECI-645, POSTHOG_MIGRATION_SPEC.md §3.5) — the exact code lives
    // on the error log for the same render.
    expect(series!.tags).not.toContain('status_code:200');
  });

  it('does not emit a render metric on non-cacheable routes (no route_class)', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>acct</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    });
    await app.fetch(
      new Request('https://www.aecintegrations.com/account/settings'),
      envWithTelemetry(),
      fakeExecutionContext(),
    );
    expect(renderMetricSeries()).toBeUndefined();
  });
});

describe('createApp ssr.render count metric (AECI-103)', () => {
  // The bounded per-render count fires on every branch the Worker runs — the
  // cacheable render (a native-cache MISS) and the non-cacheable branch, which
  // the render-duration distribution (and the old ssr.render log) never covered.
  // Edge HITs skip the Worker under WC-3, so there is no `hit` count here.
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function envWithTelemetry(): Bindings {
    const { binding } = recordingApiBinding();
    return {
      ...binding,
      POSTHOG_PROJECT_KEY: 'phc_test_token',
      ENV: 'preview',
    } as unknown as Bindings;
  }

  // Both pipes POST to the one OTLP metrics intake, so they are told apart by
  // metric NAME (and by `sum` vs `histogram`), not by URL.
  function ssrRenderCountSeries(): { metric: string; type: number; tags: string[] } | undefined {
    return otlpMetric(fetchSpy, 'aeci.ssr.render');
  }

  function distributionCalled(): boolean {
    return otlpMetric(fetchSpy, 'aeci.page.render.duration_ms') !== undefined;
  }

  it('emits aeci.ssr.render with cache_status:miss on a cacheable miss', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>p</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    });
    await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      envWithTelemetry(),
      fakeExecutionContext(),
    );
    const series = ssrRenderCountSeries();
    expect(series?.metric).toBe('aeci.ssr.render');
    expect(series?.type).toBe(1); // count
    expect(series!.tags).toEqual(expect.arrayContaining(['cache_status:miss', 'status_class:2xx']));
  });

  it('emits cache_status:non_cacheable on a non-cacheable route (where the distribution is silent)', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>acct</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    });
    await app.fetch(
      new Request('https://www.aecintegrations.com/account/settings'),
      envWithTelemetry(),
      fakeExecutionContext(),
    );
    expect(ssrRenderCountSeries()!.tags).toEqual(
      expect.arrayContaining(['cache_status:non_cacheable', 'status_class:2xx']),
    );
    // Pins the coverage contract: the render-duration histogram excludes this
    // branch, so the count metric is its only signal.
    expect(distributionCalled()).toBe(false);
  });
});

describe('createApp transformResponse hook (AECI-31 RUM bootstrap injection)', () => {
  it('invokes the hook with the rendered response and env on cacheable routes', async () => {
    const { binding } = recordingApiBinding();
    const transform = vi.fn(async (res: Response) => {
      const body = await res.clone().text();
      return new Response(`${body}|injected`, {
        status: res.status,
        headers: res.headers,
      });
    });
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>home</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
      transformResponse: transform,
    });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(transform).toHaveBeenCalledTimes(1);
    // Second arg of the hook is the Worker env — the AECI-31 injector reads
    // DD_* secrets from it. Identity check is enough: same object we passed in.
    expect(transform.mock.calls[0]![1]).toBe(binding);
    expect(await res.text()).toContain('|injected');
  });

  it('invokes the hook on non-cacheable routes too (admin pages must get RUM)', async () => {
    const { binding } = recordingApiBinding();
    const transform = vi.fn(async (res: Response) => res);
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>account</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
      transformResponse: transform,
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/account/settings'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(transform).toHaveBeenCalledTimes(1);
  });
});

// ─── AECI-57 resolver-supplied Cache-Tag merge ─────────────────────────────

describe('createApp resolver-supplied embedded Cache-Tag merge (AECI-57)', () => {
  it('merges ctx.embedded entities into Cache-Tag on a 2xx cacheable response', async () => {
    const { binding } = recordingApiBinding();
    const renderer: SsrRenderer = async (_req, ctx) => {
      // Simulate a product detail resolver pushing vendor + integration tags
      // it learned from the API response.
      ctx.embedded.push({ type: 'vendor', slug: 'autodesk' });
      ctx.embedded.push({ type: 'integration', id: 'abc-123' });
      ctx.embedded.push({ type: 'integration', id: 'def-456' });
      return new Response('<html>product</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };
    const app = createApp({ ssrRenderer: renderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toBe(
      'route:detail,product:procore,vendor:autodesk,integration:abc-123,integration:def-456',
    );
  });

  it('deduplicates entity tags when the same value appears twice', async () => {
    // The merge layer relies on `buildCacheTags`'s Set dedupe; this test pins
    // that the contract is end-to-end, not just in the helper.
    const { binding } = recordingApiBinding();
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.embedded.push({ type: 'integration', id: 'abc' });
      ctx.embedded.push({ type: 'integration', id: 'abc' });
      return new Response('<html>x</html>', { status: 200 });
    };
    const app = createApp({ ssrRenderer: renderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.headers.get('cache-tag')).toBe('route:detail,product:procore,integration:abc');
  });

  it('overrides embedded tags with the sentinel route:404 on a cacheable-route 404', async () => {
    // Sanity check: if a resolver pushed embedded tags before realising the
    // entity was missing, the 404 short-circuit in `withCacheHeaders` still
    // takes precedence — the resolver's leaked entity tags must not leak into
    // the response. The single sentinel tag wins (AECI-62).
    const { binding } = recordingApiBinding();
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.embedded.push({ type: 'vendor', slug: 'should-not-leak' });
      return new Response('Not found', { status: 404 });
    };
    const app = createApp({ ssrRenderer: renderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-tag')).toBe('route:404');
  });

  it('leaves Cache-Tag at the path-derived value when ctx.embedded is empty', async () => {
    // Empty array is the common case for routes that haven't been wired with
    // a resolver yet — the merge must not introduce trailing commas or extra
    // entries.
    const { binding } = recordingApiBinding();
    const renderer: SsrRenderer = async () => new Response('<html>x</html>', { status: 200 });
    const app = createApp({ ssrRenderer: renderer });

    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.headers.get('cache-tag')).toBe('route:detail,product:procore');
  });
});

// ─── AECI-58: SSR → POST /api/page-views fire-and-forget hook ──────────────
// Extended in AECI-57 to cover resolver-supplied payloads (entity_type /
// entity_id) and the 404 status gate.

describe('createApp page-view capture (AECI-58)', () => {
  // WC-3 (AECI-317): edge HITs skip the Worker under native Workers Cache, so
  // there is no `caches.default` stub / cache-HIT case here — the SSR-side
  // page-view fires only when the Worker renders (a native-cache MISS or a
  // non-cacheable route). The browser `PageViewTracker` remains the canonical
  // per-view counter (see the `firePageView` doc comment in server-runtime.ts).
  function pageViewCalls(calls: Request[]): Request[] {
    return calls.filter((r) => new URL(r.url).pathname === '/api/page-views');
  }

  it('fires POST /api/page-views with the locale-stripped route on a cacheable SSR miss', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products?page=2'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.method).toBe('POST');
    expect(pv[0]!.headers.get('content-type')).toContain('application/json');
    // Query string is not part of the captured route — `cacheControlForRoute`
    // matches by pathname only and the body mirrors that. `path` + `navigation`
    // are stamped by `firePageView` itself (AECI-585).
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/products',
      path: '/products',
      navigation: 'arrival',
    });
  });

  // main carried two cache-HIT cases here (page views still fire on a HIT; the
  // Cookie rides the analytics subrequest but never reaches the cached response).
  // Both are dropped on this line rather than repaired: WC-3 (AECI-317) moved the
  // SSR Worker to the NATIVE Workers Cache, which short-circuits AHEAD of the
  // Worker, so a HIT never reaches this code and there is no `cacheStub` to drive.
  // See the AECI-585 note further down for the same reasoning. The surviving
  // cookie-forwarding invariant is covered by the MISS cases above and below.

  it('forwards the eyeball Cookie so the API can flag an operator arrival (§13 D13)', async () => {
    // The API decides `is_operator` by verifying the session itself; without this
    // header an SSR arrival is anonymous to it, which is exactly why §13 D7 judged
    // a per-view role signal "right half the time".
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products', {
        headers: { cookie: 'sb-abc-auth-token=base64-xyz; theme=light' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.headers.get('cookie')).toBe('sb-abc-auth-token=base64-xyz; theme=light');
  });

  it('sends no cookie header on an anonymous arrival', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)[0]!.headers.get('cookie')).toBeNull();
  });

  // ── AECI-743: one full-document load, one row ──────────────────────────────

  it.each([
    ['sec-purpose', 'prefetch'],
    ['sec-purpose', 'prefetch;prerender'],
    ['purpose', 'prefetch'],
    ['x-moz', 'prefetch'],
    ['x-purpose', 'preview'],
  ])('does NOT fire page-views for a speculative load (%s: %s)', async (name, value) => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/revit', {
        headers: { [name]: value },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('still fires page-views when Sec-Purpose carries a non-speculative value', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/revit', {
        headers: { 'sec-purpose': 'something-else' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(1);
  });

  it('does NOT fire page-views for a HEAD request (AECI-743)', async () => {
    // A HEAD takes the non-cacheable branch, which still renders and still lets a
    // resolver attach `ctx.pageView` — so a HEAD-then-GET probe used to write two
    // byte-identical `arrival` rows.
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: (_req, ctx) => {
        ctx.pageView = { route: '/products/:slug', entity_type: 'product', entity_id: 'x' };
        return new Response('<html>detail</html>', { status: 200 });
      },
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/revit', { method: 'HEAD' }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('does NOT fire page-views on non-cacheable routes', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>account</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/account/settings'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('does NOT fire page-views on /api/* passthrough requests', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: vi.fn() as unknown as SsrRenderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/api/health'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    // The /api/health request itself is the only API call; no page-view.
    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('never throws when the API binding rejects (fire-and-forget semantics)', async () => {
    const calls: Request[] = [];
    const rejectingFetcher = {
      fetch: vi.fn(async (req: Request) => {
        calls.push(req);
        if (new URL(req.url).pathname === '/api/page-views') {
          throw new Error('api down');
        }
        return new Response('ok', { status: 200 });
      }),
    } as unknown as Fetcher;
    const binding = { API: rejectingFetcher, ASSETS: {} as Fetcher };

    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>ok</html>', { status: 200 })),
    });

    const ctx = fakeExecutionContext();
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/products'),
      binding as unknown as Bindings,
      ctx,
    );

    // The user-facing response is still 200; the page-view rejection is
    // swallowed inside the waitUntil promise.
    expect(res.status).toBe(200);
    expect(calls.some((c) => new URL(c.url).pathname === '/api/page-views')).toBe(true);
  });

  it('uses the resolver-supplied payload (entity_type / entity_id) when present', async () => {
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.pageView = {
        route: '/products/:slug',
        entity_type: 'product',
        entity_id: 'prod-uuid',
      };
      return new Response('<html>x</html>', { status: 200 });
    };
    const app = createApp({ ssrRenderer: renderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/products/:slug',
      // AECI-585: the resolver knows the pattern, `firePageView` knows the URL —
      // so a resolver-supplied payload gains the concrete path without the
      // resolver changing.
      path: '/products/procore',
      navigation: 'arrival',
      entity_type: 'product',
      entity_id: 'prod-uuid',
    });
  });

  it('does NOT fire page-views for an operator-only route, even with a resolver payload (AECI-575)', async () => {
    // `/admin/*` is non-cacheable, so the only way to reach `firePageView` is a
    // resolver attaching `ctx.pageView`. No admin resolver does that today —
    // this pins the guard so a future one can't start polluting the table the
    // console reads (ADMIN_PANEL_SPEC §9.6).
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.pageView = { route: '/admin/reviews' };
      return new Response('<html>admin</html>', { status: 200 });
    };
    const app = createApp({ ssrRenderer: renderer });

    const res = await app.fetch(
      // A session cookie is required to clear the anon admin gate (303 → login).
      new Request('https://www.aecintegrations.com/admin/reviews', {
        headers: { cookie: 'sb-proj-auth-token=session' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('does NOT fire POST /api/page-views when the renderer returns 404', async () => {
    // A resolver that 404s sets RESPONSE_INIT.status=404; the runtime must
    // gate page-view firing on response status so missing entities don't
    // pollute view counts. Even if the resolver did push a payload, the
    // status gate suppresses it.
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.pageView = { route: '/products/:slug', entity_type: 'product', entity_id: 'x' };
      return new Response('Not found', { status: 404 });
    };
    const app = createApp({ ssrRenderer: renderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('forwards the user-agent header (for API-side hashing) but never the raw UA in the body (AECI-177)', async () => {
    // The SSR supplementary write forwards the eyeball `user-agent` so the API
    // Worker can SHA-256 it; the body stays a lean route payload — the raw UA
    // must never appear in the JSON the SSR Worker sends.
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products', {
        headers: { 'user-agent': 'Mozilla/5.0 (AECI test)' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.headers.get('user-agent')).toBe('Mozilla/5.0 (AECI test)');
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/products',
      path: '/products',
      navigation: 'arrival',
    });
  });

  it('forwards the Referer header so the API can classify the traffic source (AECI-526)', async () => {
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products', {
        headers: { referer: 'https://www.linkedin.com/feed/' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.headers.get('referer')).toBe('https://www.linkedin.com/feed/');
  });

  // ─── AECI-585: concrete path + navigation flag ───────────────────────────

  // The predecessor of this case asserted that a cache HIT fired a page view with
  // a synthesized `{ route }` payload. That was true of the hand-rolled
  // `caches.default` layer, where the Worker ran on HIT and MISS alike. WC-3
  // (AECI-317) moved to native Workers Cache, which short-circuits AHEAD of the
  // Worker — a HIT never reaches this code, so there is no HIT branch left to
  // test and no `cacheStub` to drive it. The equivalent invariant now is that a
  // cacheable MISS with no resolver payload still stamps the concrete path.
  it('falls back to the path-derived route on a cacheable miss with no resolver payload', async () => {
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const app = createApp({
      ssrRenderer: async () => new Response('<html>ok</html>', { status: 200 }),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/categories/bim-coordination'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/categories/bim-coordination',
      path: '/categories/bim-coordination',
      navigation: 'arrival',
    });
  });

  it('carries the taxonomy entity plus the concrete path on a browse-page miss', async () => {
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.pageView = {
        route: '/trades/:slug',
        entity_type: 'trade',
        entity_id: 'trade-uuid',
      };
      return new Response('<html>trade</html>', { status: 200 });
    };
    const app = createApp({ ssrRenderer: renderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/trades/electrical'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/trades/:slug',
      path: '/trades/electrical',
      navigation: 'arrival',
      entity_type: 'trade',
      entity_id: 'trade-uuid',
    });
  });

  it('excludes the query string and hash from the concrete path', async () => {
    // `page_views` stores a referrer HOST for the same privacy reason (§9.7) — a
    // concrete path carrying `?token=…` would put the full URL back in the table.
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products?ref=waitlist&token=secret'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const body = (await pageViewCalls(calls)[0]!.clone().json()) as { path: string };
    expect(body.path).toBe('/products');
  });

  it('overrides a caller-supplied path and navigation with the request URL', async () => {
    // The request URL is the authority on where the visitor actually is, and this
    // function only ever runs on a full-document load.
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const renderer: SsrRenderer = async (_req, ctx) => {
      ctx.pageView = {
        route: '/products/:slug',
        path: '/products/stale',
        navigation: 'spa',
      };
      return new Response('<html>x</html>', { status: 200 });
    };
    const app = createApp({ ssrRenderer: renderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(await pageViewCalls(calls)[0]!.clone().json()).toEqual({
      route: '/products/:slug',
      path: '/products/procore',
      navigation: 'arrival',
    });
  });
});

// ─── AECI-177: CF request-context forwarding across the SSR→API binding ──────
// `request.cf` does not survive the service binding, so the SSR Worker copies
// the needed fields onto trusted `x-aeci-cf-*` headers — for the browser's
// proxied POST and for its own `firePageView` write — after stripping any
// client-supplied copies (anti-spoof). See docs/API_CONTRACTS.md §6.9.

describe('CF context forwarding for page-views (AECI-177)', () => {
  it('maps request.cf onto the trusted x-aeci-cf-* headers', () => {
    const headers = new Headers();
    applyCfContextHeaders(headers, {
      cf: {
        country: 'US',
        colo: 'SJC',
        asn: 13335,
        asOrganization: 'Cloudflare, Inc.',
        botManagement: { score: 88 },
      },
    } as unknown as Request);

    expect(headers.get('x-aeci-cf-country')).toBe('US');
    expect(headers.get('x-aeci-cf-colo')).toBe('SJC');
    expect(headers.get('x-aeci-cf-asn')).toBe('13335');
    // AECI-585 / §13 D10 — the holder NAME beside the number, so the panel's
    // internal-traffic filter can label itself instead of showing a bare AS number.
    expect(headers.get('x-aeci-cf-as-organization')).toBe('Cloudflare, Inc.');
    expect(headers.get('x-aeci-cf-bot-score')).toBe('88');
  });

  it('forwards the AS organization on the SSR write when request.cf carries it', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    const request = new Request('https://www.aecintegrations.com/products');
    Object.defineProperty(request, 'cf', {
      value: { country: 'ID', asn: 23700, asOrganization: 'Biznet Networks' },
    });
    await app.fetch(request, binding as unknown as Bindings, fakeExecutionContext());

    const pv = calls.filter((r) => new URL(r.url).pathname === '/api/page-views');
    expect(pv).toHaveLength(1);
    expect(pv[0]!.headers.get('x-aeci-cf-as-organization')).toBe('Biznet Networks');
  });

  it('sets only the CF fields that are present (no empty headers)', () => {
    const headers = new Headers();
    // bot score 0 is a real value and must still be forwarded.
    applyCfContextHeaders(headers, {
      cf: { country: 'GB', botManagement: { score: 0 } },
    } as unknown as Request);

    expect(headers.get('x-aeci-cf-country')).toBe('GB');
    expect(headers.get('x-aeci-cf-bot-score')).toBe('0');
    expect(headers.get('x-aeci-cf-colo')).toBeNull();
    expect(headers.get('x-aeci-cf-asn')).toBeNull();
  });

  it('is a no-op when request.cf is absent (local dev / non-CF runtime)', () => {
    const headers = new Headers();
    applyCfContextHeaders(headers, new Request('https://api/api/page-views'));
    expect([...headers.keys()]).toEqual([]);
  });

  it('strips client-supplied x-aeci-cf-* on the proxied POST /api/page-views (anti-spoof)', async () => {
    const { binding, calls } = recordingApiBinding(new Response(null, { status: 204 }));
    const app = createApp({ ssrRenderer: vi.fn() as unknown as SsrRenderer });

    await app.fetch(
      new Request('https://www.aecintegrations.com/api/page-views', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A malicious client forging CF context — must not survive the proxy.
          'x-aeci-cf-country': 'SPOOF',
          'x-aeci-cf-bot-score': '99',
          'x-aeci-cf-as-organization': 'Definitely Not A Bot Inc.',
        },
        body: JSON.stringify({ route: '/products/procore' }),
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = calls.filter((r) => new URL(r.url).pathname === '/api/page-views');
    expect(pv).toHaveLength(1);
    // The test request carries no real request.cf, so the stripped spoof is not
    // replaced — the API Worker would see no (untrusted) CF context.
    expect(pv[0]!.headers.get('x-aeci-cf-country')).toBeNull();
    expect(pv[0]!.headers.get('x-aeci-cf-bot-score')).toBeNull();
    expect(pv[0]!.headers.get('x-aeci-cf-as-organization')).toBeNull();
    // Body and method pass through unchanged — the browser POST is proxied, not
    // rebuilt, so the tracker's own `navigation: 'spa'` survives untouched.
    expect(pv[0]!.method).toBe('POST');
    expect(await pv[0]!.clone().json()).toEqual({ route: '/products/procore' });
  });

  it('forwards a non-page-views /api/* request byte-for-byte (no CF rebuild)', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: vi.fn() as unknown as SsrRenderer });

    const original = new Request('https://www.aecintegrations.com/api/health', {
      headers: { 'x-aeci-cf-country': 'SPOOF' },
    });
    await app.fetch(original, binding as unknown as Bindings, fakeExecutionContext());

    // The passthrough hands the raw request straight to the binding.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(original);
  });
});

// ─── AECI-200 review-route auth gate ───────────────────────────────────────

describe('isReviewPath (AECI-200)', () => {
  it('matches /products/:slug/review only', () => {
    expect(isReviewPath('/products/acme-build/review')).toBe(true);
    expect(isReviewPath('/products/x/review')).toBe(true);
  });

  it('does not match the detail page, listing, or other product sub-routes', () => {
    expect(isReviewPath('/products/acme-build')).toBe(false);
    expect(isReviewPath('/products')).toBe(false);
    expect(isReviewPath('/products/acme-build/claim')).toBe(false);
    expect(isReviewPath('/products/acme-build/review/extra')).toBe(false);
    expect(isReviewPath('/reviews')).toBe(false);
  });
});

describe('hasSessionCookie (AECI-200)', () => {
  function req(cookie?: string): Request {
    return new Request('https://www.aecintegrations.com/products/x/review', {
      headers: cookie ? { cookie } : {},
    });
  }

  it('detects a Supabase auth-token cookie (incl. chunked variants)', () => {
    expect(hasSessionCookie(req('sb-abcdef-auth-token=base64-xyz'))).toBe(true);
    expect(
      hasSessionCookie(req('sb-abcdef-auth-token.0=part0; sb-abcdef-auth-token.1=part1')),
    ).toBe(true);
    expect(hasSessionCookie(req('theme=dark; sb-proj-auth-token=tok'))).toBe(true);
  });

  it('returns false when no auth-token cookie is present', () => {
    expect(hasSessionCookie(req())).toBe(false);
    expect(hasSessionCookie(req('theme=dark'))).toBe(false);
    expect(hasSessionCookie(req('sb-proj-other=tok'))).toBe(false);
  });
});

describe('createApp review-route auth gate (AECI-200)', () => {
  it('redirects an unauthenticated visitor to /auth/login with a sanitized return path', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run for a logged-out visitor')),
    });

    const req = new Request('https://www.aecintegrations.com/products/acme-build/review', {
      headers: { cookie: 'theme=dark' }, // no session cookie
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      '/auth/login?return=%2Fproducts%2Facme-build%2Freview',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls through to SSR when a session cookie is present', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });

    const req = new Request('https://www.aecintegrations.com/products/acme-build/review', {
      headers: { cookie: 'sb-proj-auth-token=session' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SSR-OK');
  });

  it('does not gate the product detail page (cacheable, public)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });

    const req = new Request('https://www.aecintegrations.com/products/acme-build', {
      headers: { cookie: 'theme=dark' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SSR-OK');
  });
});

describe('isAdminPath (AECI-203)', () => {
  it('matches /admin and everything under it', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/reviews')).toBe(true);
    expect(isAdminPath('/admin/reviews/anything/deep')).toBe(true);
  });

  it('does not match look-alike paths', () => {
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/admin-tools')).toBe(false);
    expect(isAdminPath('/products/admin')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
  });
});

describe('createApp admin-surface anon gate (AECI-203)', () => {
  it('redirects a logged-out visitor to /auth/login with a sanitized return path', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run for a logged-out visitor')),
    });

    const req = new Request('https://www.aecintegrations.com/admin', {
      headers: { cookie: 'theme=dark' }, // no session cookie
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?return=%2Fadmin');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('redirects a logged-out visitor on a deep admin path too', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')),
    });

    const req = new Request('https://www.aecintegrations.com/admin/reviews', {
      headers: { cookie: 'theme=light' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?return=%2Fadmin%2Freviews');
  });

  it('falls through to SSR when a session cookie is present (role check happens in the resolver)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });

    const req = new Request('https://www.aecintegrations.com/admin', {
      headers: { cookie: 'sb-proj-auth-token=session' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SSR-OK');
  });

  it('is GET-only — a non-GET admin request is not redirected to login', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });

    // No real POST handler under /admin besides the earlier-registered
    // /admin/purge, so this falls through to SSR rather than a login bounce.
    const req = new Request('https://www.aecintegrations.com/admin/not-purge', {
      method: 'POST',
      headers: { cookie: 'theme=dark' }, // no session cookie
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).not.toBe(303);
  });
});

describe('isVendorPath (AECI-520)', () => {
  it('matches /vendor and everything under it', () => {
    expect(isVendorPath('/vendor')).toBe(true);
    expect(isVendorPath('/vendor/products')).toBe(true);
    expect(isVendorPath('/vendor/products/revit/edit')).toBe(true);
  });

  it('does NOT match the public /vendors detail surface', () => {
    // The whole reason the portal prefix is singular. `/vendors/:slug` is a
    // cacheable public page; gating it would put a login wall on the catalog.
    expect(isVendorPath('/vendors')).toBe(false);
    expect(isVendorPath('/vendors/autodesk')).toBe(false);
  });

  it('does not match look-alike paths', () => {
    expect(isVendorPath('/vendor-portal')).toBe(false);
    expect(isVendorPath('/products/vendor')).toBe(false);
    expect(isVendorPath('/')).toBe(false);
  });
});

describe('createApp vendor-portal anon gate + cacheability (AECI-520)', () => {
  it('redirects a logged-out visitor to /auth/login with a sanitized return path', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run for a logged-out visitor')),
    });

    const req = new Request('https://www.aecintegrations.com/vendor', {
      headers: { cookie: 'theme=dark' }, // no session cookie
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?return=%2Fvendor');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls through to SSR when a session cookie is present (role check is the resolver’s)', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });

    const req = new Request('https://www.aecintegrations.com/vendor/products', {
      headers: { cookie: 'sb-proj-auth-token=session' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SSR-OK');
  });

  it('never edge-caches a /vendor page and emits no Cache-Tag', async () => {
    // The portal renders one vendor's private data. The native cache is keyed by
    // URL, not cookie, so a cached /vendor page would serve the first vendor's
    // dashboard to the next one. It is non-cacheable by fail-closed default —
    // this pins that nobody adds it to ROUTE_CACHE_PATTERNS by accident.
    expect(isCacheableRoute(new URL('https://www.aecintegrations.com/vendor'))).toBe(false);
    expect(isCacheableRoute(new URL('https://www.aecintegrations.com/vendor/products'))).toBe(
      false,
    );

    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR-OK', { status: 200 })) });
    const req = new Request('https://www.aecintegrations.com/vendor', {
      headers: { cookie: 'sb-proj-auth-token=session' },
    });
    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('leaves the PUBLIC /vendors/:slug page cacheable', async () => {
    expect(isCacheableRoute(new URL('https://www.aecintegrations.com/vendors/autodesk'))).toBe(
      true,
    );
  });
});

describe('createApp authenticated-SSR cookie neutrality (AECI-203)', () => {
  // A renderer that makes an authenticated API read through the request context,
  // so we can assert WHICH branch's client (cookie-forwarding vs cookie-free) the
  // resolver got. The recording binding captures the outbound `/api/probe` call.
  function apiProbeRenderer(): SsrRenderer {
    return async (_req, ctx) => {
      await ctx.api.request('/api/probe').catch(() => undefined);
      return new Response('SSR-OK', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
  }

  function probeCookie(calls: Request[]): string | null {
    const probe = calls.find((r) => new URL(r.url).pathname === '/api/probe');
    if (!probe) throw new Error('expected the renderer to call /api/probe');
    return probe.headers.get('cookie');
  }

  it('forwards the session cookie to the API on a NON-cacheable route (/admin)', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: apiProbeRenderer() });

    const req = new Request('https://www.aecintegrations.com/admin', {
      headers: { cookie: 'sb-proj-auth-token=session; theme=dark' },
    });
    await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(probeCookie(calls)).toBe('sb-proj-auth-token=session; theme=dark');
  });

  it('does NOT forward the session cookie to the API on a CACHEABLE route (/)', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: apiProbeRenderer() });

    // The session cookie survives into the SSR render (it is not visitor-state),
    // but the cacheable branch's API client must never carry it — else a
    // per-user response could be written to the shared edge cache.
    const req = new Request('https://www.aecintegrations.com/', {
      headers: { cookie: 'sb-proj-auth-token=session' },
    });
    await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());

    expect(probeCookie(calls)).toBeNull();
  });
});
