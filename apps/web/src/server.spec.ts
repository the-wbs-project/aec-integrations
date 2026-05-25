import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  LOCALES,
  NOT_FOUND_TTL,
  VISITOR_STATE_COOKIES,
  buildCacheControl,
  cacheControlForRoute,
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
    ['/products/procore', { edge: 3_600, browser: 300 }],
    ['/vendors/autodesk', { edge: 3_600, browser: 300 }],
    ['/integrations/abc-123', { edge: 3_600, browser: 300 }],
    ['/products', { edge: 1_800, browser: 300 }],
    ['/categories/design', { edge: 1_800, browser: 300 }],
    ['/disciplines/structural', { edge: 1_800, browser: 300 }],
    ['/phases/preconstruction', { edge: 1_800, browser: 300 }],
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

describe('buildCacheControl', () => {
  it('formats edge and browser TTLs as a Cache-Control header value', () => {
    expect(buildCacheControl({ edge: 3600, browser: 300 })).toBe(
      'public, max-age=300, s-maxage=3600',
    );
    expect(buildCacheControl(NOT_FOUND_TTL)).toBe('public, max-age=60, s-maxage=60');
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

  it('does not write Cache-Tag on cacheable-route 404 responses', async () => {
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
    expect(res.headers.get('cache-tag')).toBeNull();
  });
});

describe('createApp /preview/* production gate', () => {
  it('returns 404 with no-store on /preview/* when ENV is production (renderer never invoked)', async () => {
    const { binding } = recordingApiBinding();
    const ssrRenderer = vi.fn<SsrRenderer>(async () =>
      fixedRenderer(new Response('<html>preview</html>', { status: 200 }))(
        new Request('https://x/'),
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
  it('returns HTTP 404 with no-store for unknown (non-cacheable) routes', async () => {
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
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/no-store|max-age=0/);
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
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
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

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
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
