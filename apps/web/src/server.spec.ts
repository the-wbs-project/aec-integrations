import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  LOCALES,
  NOT_FOUND_TTL,
  VISITOR_STATE_COOKIES,
  buildCacheControl,
  cacheControlForRoute,
  cacheKeyUrl,
  createApp,
  isCacheableRoute,
  isPreviewPath,
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
    expect(LOCALES).toEqual([{ locale: 'en-US', prefix: '' }]);
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

  it('removes the theme cookie and preserves the rest', () => {
    const req = new Request('https://x/', {
      headers: { cookie: 'sb-access-token=abc; theme=dark; csrf=xyz' },
    });
    const stripped = stripVisitorStateCookies(req);
    expect(stripped).not.toBe(req);
    expect(stripped.headers.get('cookie')).toBe('sb-access-token=abc; csrf=xyz');
  });

  it('deletes the cookie header entirely when only visitor-state cookies were present', () => {
    const req = new Request('https://x/', {
      headers: { cookie: 'theme=light' },
    });
    const stripped = stripVisitorStateCookies(req);
    expect(stripped.headers.get('cookie')).toBeNull();
  });

  it('strips every cookie listed in VISITOR_STATE_COOKIES', () => {
    // Defensive: if a future change adds a name, the strip behavior must
    // extend automatically. Builds a synthetic cookie header from the list.
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
  it.each([
    ['/', { edge: 900, browser: 300 }],
    ['/about', { edge: 86_400, browser: 3_600 }],
    ['/legal/privacy', { edge: 86_400, browser: 3_600 }],
    ['/products/procore', { edge: 900, browser: 0 }],
    ['/vendors/autodesk', { edge: 900, browser: 0 }],
    ['/integrations/abc-123', { edge: 900, browser: 0 }],
    // CACHE_STRATEGY.md §4 — index pages AND taxonomy browse pages (category /
    // discipline / phase) are 5 min edge / 0 browser. (AECI-61 corrected the
    // taxonomy rows from a stale 30 min edge.)
    ['/products', { edge: 300, browser: 0 }],
    ['/vendors', { edge: 300, browser: 0 }],
    ['/integrations', { edge: 300, browser: 0 }],
    ['/categories', { edge: 300, browser: 0 }],
    ['/categories/design', { edge: 300, browser: 0 }],
    ['/disciplines/structural', { edge: 300, browser: 0 }],
    ['/phases/preconstruction', { edge: 300, browser: 0 }],
  ])('returns the §9.2 TTL for %s', (path, expected) => {
    expect(cacheControlForRoute(new URL(`https://x${path}`))).toEqual(expected);
  });

  it.each([
    '/api/health',
    '/auth/login',
    '/account',
    '/account/settings',
    '/search',
    '/does-not-exist',
    '/products/procore/extra',
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
});

describe('cacheKeyUrl (AECI-100 — edge cache key normalization)', () => {
  const key = (path: string): string => cacheKeyUrl(new URL(`https://x${path}`));

  describe('detail / query-independent routes strip the whole query string', () => {
    it('collapses utm_*/fbclid variants of a detail route to one key', () => {
      // AC #1 — these three must resolve to the same cache entry.
      const canonical = 'https://x/products/foo';
      expect(key('/products/foo')).toBe(canonical);
      expect(key('/products/foo?utm_source=x')).toBe(canonical);
      expect(key('/products/foo?fbclid=y')).toBe(canonical);
      expect(key('/products/foo?utm_source=x&utm_medium=email&fbclid=y&gclid=z')).toBe(canonical);
    });

    it('strips the query string on home, browse, and static routes (no content params)', () => {
      expect(key('/?utm_campaign=launch')).toBe('https://x/');
      expect(key('/categories/structural?fbclid=y')).toBe('https://x/categories/structural');
      expect(key('/disciplines/architecture?utm_source=x')).toBe(
        'https://x/disciplines/architecture',
      );
      expect(key('/categories?ref=newsletter')).toBe('https://x/categories');
      expect(key('/about?utm_source=x')).toBe('https://x/about');
    });
  });

  describe('index / browse routes keep only content-affecting params', () => {
    it('keeps page/sort/perPage and drops tracking params on /products', () => {
      // AC #2 — distinct content keyed; tracking noise dropped.
      expect(key('/products?page=2&utm_source=x&fbclid=y')).toBe('https://x/products?page=2');
      expect(key('/products?perPage=50')).toBe('https://x/products?perPage=50');
    });

    it('produces the same key regardless of param ordering (canonical sort)', () => {
      expect(key('/products?sort=name&page=2')).toBe(key('/products?page=2&sort=name'));
      expect(key('/products?page=2&sort=name')).toBe('https://x/products?page=2&sort=name');
    });

    it('keys distinct pages of an index as distinct entries', () => {
      expect(key('/products?page=1')).not.toBe(key('/products?page=2'));
    });

    it('keeps the integrations-only filter params (sourceProductId/targetProductId)', () => {
      expect(key('/integrations?sourceProductId=abc&utm_source=x')).toBe(
        'https://x/integrations?sourceProductId=abc',
      );
      expect(key('/integrations?targetProductId=def&page=2&fbclid=y')).toBe(
        'https://x/integrations?page=2&targetProductId=def',
      );
    });

    it('does not retain integrations-only params on /products or /vendors', () => {
      // The split entry means a stray sourceProductId on /products is treated
      // as noise — it isn't a content param there.
      expect(key('/products?sourceProductId=abc')).toBe('https://x/products');
      expect(key('/vendors?targetProductId=def')).toBe('https://x/vendors');
    });
  });

  it('preserves origin (host + port) so the key never crosses environments', () => {
    expect(cacheKeyUrl(new URL('http://localhost:8788/products/foo?utm_source=x'))).toBe(
      'http://localhost:8788/products/foo',
    );
  });
});

describe('buildCacheControl', () => {
  it('formats edge and browser TTLs as a Cache-Control header value', () => {
    expect(buildCacheControl({ edge: 3600, browser: 300 })).toBe(
      'public, max-age=300, s-maxage=3600',
    );
    // AECI-62 — 404s revalidate on every navigation (max-age=0); edge still
    // holds them for 60s so a flood of 404s doesn't melt the SSR Worker.
    expect(buildCacheControl(NOT_FOUND_TTL)).toBe('public, max-age=0, s-maxage=60');
  });
});

// ─── Smoke tests: end-to-end through the Hono app ──────────────────────────

describe('createApp /api/* passthrough (AC: cookies intact to API Worker)', () => {
  it('forwards /api/* requests to env.API.fetch with cookies unchanged', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: fixedRenderer(new Response('SSR shouldn’t run')) });

    const req = new Request('https://aecintegrations.com/api/health', {
      method: 'GET',
      headers: { cookie: 'sb-access-token=abc.def.ghi; theme=dark' },
    });

    const res = await app.fetch(req, binding as unknown as Bindings, fakeExecutionContext());
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!;
    // The theme cookie must NOT be stripped on the /api/* path — the AECI-35
    // contract is that cookie stripping only runs on the cacheable branch.
    // Auth cookies obviously must survive too.
    expect(forwarded.headers.get('cookie')).toBe('sb-access-token=abc.def.ghi; theme=dark');
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

    const req = new Request('https://aecintegrations.com/api/version');
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

    const req = new Request('https://aecintegrations.com/api/reviews', {
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

describe('createApp cookie-stripping on cacheable routes (AC: §9.1a)', () => {
  it('strips the theme cookie before invoking SSR on /', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({ ssrRenderer: cookieEchoRenderer() });

    const withTheme = await app.fetch(
      new Request('https://aecintegrations.com/', {
        headers: { cookie: 'theme=dark; sb-access-token=abc' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    const withoutTheme = await app.fetch(
      new Request('https://aecintegrations.com/', {
        headers: { cookie: 'sb-access-token=abc' },
      }),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const withBody = await withTheme.text();
    const withoutBody = await withoutTheme.text();

    // The renderer echoes back the cookie header it saw. Both calls must see
    // the same cookies — i.e. `theme` was stripped before SSR ran. (Other
    // cookies pass through, which is why both bodies include sb-access-token.)
    expect(withBody).toBe(withoutBody);
    expect(withBody).toContain('sb-access-token=abc');
    expect(withBody).not.toContain('theme=dark');
  });

  it('sets a route-specific Cache-Control header and no Vary on the cacheable branch', async () => {
    const { binding } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>home</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            vary: 'Cookie', // upstream tries to set Vary — middleware must strip it
          },
        }),
      ),
    });

    const res = await app.fetch(
      new Request('https://aecintegrations.com/'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=900');
    expect(res.headers.get('vary')).toBeNull();
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
    ['/', 'route:index,taxonomy'],
    ['/products', 'route:index,index:products'],
    ['/products/procore', 'route:detail,product:procore'],
    ['/vendors/autodesk', 'route:detail,vendor:autodesk'],
    ['/integrations/abc-123', 'route:detail,integration:abc-123'],
    ['/categories', 'route:index,index:categories,taxonomy'],
    ['/categories/structural', 'route:browse,category:structural'],
    ['/disciplines/architecture', 'route:browse,discipline:architecture'],
    ['/phases/preconstruction', 'route:browse,phase:preconstruction'],
  ])('cacheable path %s emits Cache-Tag=%s', async (path, expected) => {
    const { binding } = recordingApiBinding();
    const res = await appReturningOk().fetch(
      new Request(`https://aecintegrations.com${path}`),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toBe(expected);
  });

  it('omits Cache-Tag for static cacheable pages with no §2 entity (/about, /legal/*)', async () => {
    const { binding } = recordingApiBinding();
    for (const path of ['/about', '/legal/privacy']) {
      const res = await appReturningOk().fetch(
        new Request(`https://aecintegrations.com${path}`),
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
      new Request('https://aecintegrations.com/account/settings'),
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
      new Request('https://aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(404);
    // Single sentinel tag — 404s have no entity identity, just the absence
    // class. Bulk-purge target after admin fixes a config typo, etc.
    expect(res.headers.get('cache-tag')).toBe('route:404');
  });
});

describe('createApp /preview/* production gate', () => {
  it('returns 404 with no-store on /preview/* when ENV is production (renderer never invoked)', async () => {
    const { binding } = recordingApiBinding();
    const ssrRenderer = vi.fn<SsrRenderer>(async (_req, ctx) =>
      fixedRenderer(new Response('<html>preview</html>', { status: 200 }))(
        new Request('https://x/'),
        ctx,
      ),
    );
    const app = createApp({ ssrRenderer });

    const res = await app.fetch(
      new Request('https://aecintegrations.com/preview/vendor-detail'),
      { ...binding, ENV: 'production' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(ssrRenderer).not.toHaveBeenCalled();
  });

  it('serves /preview/* on preview Worker deploys (ENV !== production)', async () => {
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
      new Request('https://aecintegrations.com/this-route-does-not-exist'),
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
      new Request('https://aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    // AECI-62 — browser revalidates every navigation; edge caches for 60s.
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });
});

describe('createApp edge-cache integration (only 2xx is stored)', () => {
  let originalCaches: unknown;
  let cacheStub: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: unknown }).caches;
    cacheStub = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { caches: unknown }).caches = { default: cacheStub };
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches: unknown }).caches = originalCaches;
    }
  });

  it('stores 2xx responses in the edge cache via ctx.waitUntil', async () => {
    const { binding } = recordingApiBinding();
    const ctx = fakeExecutionContext();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>home</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://aecintegrations.com/'),
      binding as unknown as Bindings,
      ctx,
    );

    // ctx.waitUntil is called twice on a cacheable miss: once to put the
    // response into caches.default, once to fire the AECI-58 page-view hook.
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(cacheStub.put).toHaveBeenCalledOnce();
  });

  it('does NOT store 404 responses in the edge cache', async () => {
    const { binding } = recordingApiBinding();
    const ctx = fakeExecutionContext();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('Not found', { status: 404 })),
    });

    await app.fetch(
      new Request('https://aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      ctx,
    );

    expect(cacheStub.put).not.toHaveBeenCalled();
  });

  it('returns the cached response on a cache HIT without invoking SSR', async () => {
    const cachedBody = '<html>cached home</html>';
    cacheStub.match.mockResolvedValueOnce(
      new Response(cachedBody, {
        status: 200,
        headers: {
          'cache-control': 'public, max-age=300, s-maxage=900',
          'content-type': 'text/html',
        },
      }),
    );
    const { binding } = recordingApiBinding();
    const renderer = vi.fn();
    const app = createApp({ ssrRenderer: renderer as unknown as SsrRenderer });

    const res = await app.fetch(
      new Request('https://aecintegrations.com/'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(await res.text()).toBe(cachedBody);
    expect(renderer).not.toHaveBeenCalled();
  });
});

describe('createApp edge-cache key normalization end-to-end (AECI-100)', () => {
  let originalCaches: unknown;
  // In-memory cache keyed by the Request URL the runtime computes — this is how
  // Cloudflare's caches.default keys entries, so it faithfully proves that two
  // URLs which normalize to the same key collide (HIT) and distinct ones don't.
  let store: Map<string, Response>;

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: unknown }).caches;
    store = new Map<string, Response>();
    const cache = {
      match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
      put: vi.fn(async (req: Request, res: Response) => {
        store.set(req.url, res.clone());
      }),
    };
    (globalThis as { caches: unknown }).caches = { default: cache };
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches: unknown }).caches = originalCaches;
    }
  });

  async function fetchPath(app: ReturnType<typeof createApp>, url: string): Promise<Response> {
    const { binding } = recordingApiBinding();
    return app.fetch(new Request(url), binding as unknown as Bindings, fakeExecutionContext());
  }

  it('serves a HIT for ?fbclid after ?utm_source primed the cache (AC #1: one detail entry)', async () => {
    const renderer = vi.fn<SsrRenderer>(
      async () =>
        new Response('<html>detail</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const app = createApp({ ssrRenderer: renderer });

    // First request primes the cache: MISS → render → store one entry.
    const first = await fetchPath(app, 'https://aecintegrations.com/products/foo?utm_source=x');
    expect(first.status).toBe(200);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);

    // A different tracking param on the same page must HIT — no second render.
    const second = await fetchPath(app, 'https://aecintegrations.com/products/foo?fbclid=y');
    expect(await second.text()).toBe('<html>detail</html>');
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it('keeps distinct index pages as separate entries but collapses tracking noise (AC #2)', async () => {
    const renderer = vi.fn<SsrRenderer>(async (req) => {
      const search = new URL(req.url).search;
      return new Response(`<html>${search}</html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const app = createApp({ ssrRenderer: renderer });

    await fetchPath(app, 'https://aecintegrations.com/products?page=1');
    await fetchPath(app, 'https://aecintegrations.com/products?page=2');
    // page=1 and page=2 are distinct content → two renders, two entries.
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);

    // A tracking-only variant of page=1 normalizes to the page=1 key → HIT.
    await fetchPath(app, 'https://aecintegrations.com/products?page=1&utm_source=x');
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
  });
});

describe('createApp render-duration metric (AECI-66, Phase 2 §14)', () => {
  let originalCaches: unknown;
  let cacheStub: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: unknown }).caches;
    cacheStub = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { caches: unknown }).caches = { default: cacheStub };
    // Only metric submission uses global fetch here; the API binding is a
    // separate mock, so any distribution_points POST is unambiguously a metric.
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches: unknown }).caches = originalCaches;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function envWithDatadog(): Bindings {
    const { binding } = recordingApiBinding();
    return {
      ...binding,
      DD_API_KEY: 'secret-key',
      DD_SITE: 'us5.datadoghq.com',
      ENV: 'preview',
    } as unknown as Bindings;
  }

  function renderMetricSeries(): { metric: string; tags: string[] } | undefined {
    const call = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/api/v1/distribution_points'),
    );
    return call ? JSON.parse(call[1]!.body as string).series[0] : undefined;
  }

  it('emits aeci.page.render.duration_ms with cache_status:MISS + route_class on a cacheable miss', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>p</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    });
    await app.fetch(
      new Request('https://aecintegrations.com/products/procore'),
      envWithDatadog(),
      fakeExecutionContext(),
    );
    const series = renderMetricSeries();
    expect(series?.metric).toBe('aeci.page.render.duration_ms');
    expect(series!.tags).toEqual(
      expect.arrayContaining(['route_class:detail', 'cache_status:MISS', 'status_code:200']),
    );
  });

  it('emits cache_status:HIT (without invoking SSR) on a cache hit', async () => {
    cacheStub.match.mockResolvedValueOnce(
      new Response('<html>cached</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const renderer = vi.fn();
    const app = createApp({ ssrRenderer: renderer as unknown as SsrRenderer });
    await app.fetch(
      new Request('https://aecintegrations.com/'),
      envWithDatadog(),
      fakeExecutionContext(),
    );
    expect(renderer).not.toHaveBeenCalled();
    const series = renderMetricSeries();
    expect(series!.tags).toEqual(
      expect.arrayContaining(['route_class:index', 'cache_status:HIT', 'status_code:200']),
    );
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
      new Request('https://aecintegrations.com/account/settings'),
      envWithDatadog(),
      fakeExecutionContext(),
    );
    expect(renderMetricSeries()).toBeUndefined();
  });
});

describe('createApp ssr.render count metric (AECI-103)', () => {
  // The bounded per-render count fires on EVERY branch — including the
  // edge-cache HIT and the non-cacheable branch, which the render-duration
  // distribution (and the old ssr.render log) never covered.
  let originalCaches: unknown;
  let cacheStub: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: unknown }).caches;
    cacheStub = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { caches: unknown }).caches = { default: cacheStub };
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches: unknown }).caches = originalCaches;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function envWithDatadog(): Bindings {
    const { binding } = recordingApiBinding();
    return {
      ...binding,
      DD_API_KEY: 'secret-key',
      DD_SITE: 'us5.datadoghq.com',
      ENV: 'preview',
    } as unknown as Bindings;
  }

  // The count metric POSTs to /api/v2/series; the render distribution POSTs to
  // /api/v1/distribution_points, so the two are unambiguous on the same fetch spy.
  function ssrRenderCountSeries(): { metric: string; type: number; tags: string[] } | undefined {
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/v2/series'));
    const series = call ? JSON.parse(call[1]!.body as string).series[0] : undefined;
    return series?.metric === 'aeci.ssr.render' ? series : undefined;
  }

  function distributionCalled(): boolean {
    return fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/v1/distribution_points'));
  }

  it('emits aeci.ssr.render with cache_status:miss on a cacheable miss', async () => {
    const app = createApp({
      ssrRenderer: fixedRenderer(
        new Response('<html>p</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    });
    await app.fetch(
      new Request('https://aecintegrations.com/products/procore'),
      envWithDatadog(),
      fakeExecutionContext(),
    );
    const series = ssrRenderCountSeries();
    expect(series?.metric).toBe('aeci.ssr.render');
    expect(series?.type).toBe(1); // count
    expect(series!.tags).toEqual(expect.arrayContaining(['cache_status:miss', 'status_class:2xx']));
  });

  it('emits cache_status:hit on a cache hit without invoking SSR', async () => {
    cacheStub.match.mockResolvedValueOnce(
      new Response('<html>cached</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const renderer = vi.fn();
    const app = createApp({ ssrRenderer: renderer as unknown as SsrRenderer });
    await app.fetch(
      new Request('https://aecintegrations.com/'),
      envWithDatadog(),
      fakeExecutionContext(),
    );
    expect(renderer).not.toHaveBeenCalled();
    expect(ssrRenderCountSeries()!.tags).toEqual(
      expect.arrayContaining(['cache_status:hit', 'status_class:2xx']),
    );
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
      new Request('https://aecintegrations.com/account/settings'),
      envWithDatadog(),
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
      new Request('https://aecintegrations.com/'),
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
      new Request('https://aecintegrations.com/account/settings'),
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
      new Request('https://aecintegrations.com/products/procore'),
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
      new Request('https://aecintegrations.com/products/procore'),
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
      new Request('https://aecintegrations.com/products/missing'),
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
      new Request('https://aecintegrations.com/products/procore'),
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
  let originalCaches: unknown;
  let cacheStub: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: unknown }).caches;
    cacheStub = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { caches: unknown }).caches = { default: cacheStub };
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches: unknown }).caches = originalCaches;
    }
  });

  function pageViewCalls(calls: Request[]): Request[] {
    return calls.filter((r) => new URL(r.url).pathname === '/api/page-views');
  }

  it('fires POST /api/page-views with the locale-stripped route on a cacheable SSR miss', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>index</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://aecintegrations.com/products?page=2'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.method).toBe('POST');
    expect(pv[0]!.headers.get('content-type')).toContain('application/json');
    // Query string is not part of the captured route — `cacheControlForRoute`
    // matches by pathname only and the body mirrors that.
    expect(await pv[0]!.clone().json()).toEqual({ route: '/products' });
  });

  it('fires page-views again on a cache HIT (visitor arrivals, not just SSR misses)', async () => {
    cacheStub.match.mockResolvedValueOnce(
      new Response('<html>cached</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: vi.fn() as unknown as SsrRenderer });

    await app.fetch(
      new Request('https://aecintegrations.com/products'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(1);
  });

  it('does NOT fire page-views on non-cacheable routes', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({
      ssrRenderer: fixedRenderer(new Response('<html>account</html>', { status: 200 })),
    });

    await app.fetch(
      new Request('https://aecintegrations.com/account/settings'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });

  it('does NOT fire page-views on /api/* passthrough requests', async () => {
    const { binding, calls } = recordingApiBinding();
    const app = createApp({ ssrRenderer: vi.fn() as unknown as SsrRenderer });

    await app.fetch(
      new Request('https://aecintegrations.com/api/health'),
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
      new Request('https://aecintegrations.com/products'),
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
      new Request('https://aecintegrations.com/products/procore'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    const pv = pageViewCalls(calls);
    expect(pv).toHaveLength(1);
    expect(await pv[0]!.clone().json()).toEqual({
      route: '/products/:slug',
      entity_type: 'product',
      entity_id: 'prod-uuid',
    });
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
      new Request('https://aecintegrations.com/products/missing'),
      binding as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(pageViewCalls(calls)).toHaveLength(0);
  });
});
