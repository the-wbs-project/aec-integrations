import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { WebEnv } from '../../env';
import { createAdminPurgeHandler, MAX_PURGE_TAGS } from './admin-purge';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'dev-admin-token';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    ENV: 'preview',
    ADMIN_PURGE_TOKEN: ADMIN_TOKEN,
    ...overrides,
  };
}

/**
 * Execution context whose native cache is **enabled** — `ctx.cache.purge` is a
 * spy resolving to `result`. Returns both so tests can assert on the purge call.
 */
function ctxWithPurge(result: CachePurgeResult = { success: true, errors: [] }) {
  const purge = vi.fn().mockResolvedValue(result);
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
    cache: { purge },
  } as unknown as ExecutionContext;
  return { ctx, purge };
}

/** Execution context with native cache **disabled** — `ctx.cache` is absent. */
function ctxNoCache(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

function makeApp() {
  const app = new Hono<{ Bindings: WebEnv }>();
  app.post('/admin/purge', createAdminPurgeHandler());
  return app;
}

function purgeRequest(opts: { token?: string; body?: unknown; search?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const url = `https://aecintegrations.com/admin/purge${opts.search ?? ''}`;
  return new Request(url, {
    method: 'POST',
    headers,
    body:
      opts.body === undefined
        ? JSON.stringify({ tags: ['product:procore'] })
        : JSON.stringify(opts.body),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /admin/purge — auth', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const req = new Request('https://aecintegrations.com/admin/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['product:procore'] }),
    });
    const res = await app.fetch(req, makeEnv(), ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(purge).not.toHaveBeenCalled();
  });

  it('returns 401 on wrong bearer token', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(purgeRequest({ token: 'wrong-token' }), makeEnv(), ctx);

    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('returns 401 when ADMIN_PURGE_TOKEN is not configured', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN }),
      makeEnv({ ADMIN_PURGE_TOKEN: undefined }),
      ctx,
    );

    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('rejects a wrong token whose length differs from the secret (never purges)', async () => {
    // A regression test ensuring the shared `timingSafeEqual` is used: a much
    // shorter wrong token still returns 401 and never reaches the cache.
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(purgeRequest({ token: 'x' }), makeEnv(), ctx);
    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });
});

describe('POST /admin/purge — body validation', () => {
  it('returns 400 when body is not JSON', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const req = new Request('https://aecintegrations.com/admin/purge', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    const res = await app.fetch(req, makeEnv(), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 when no purge mode is provided (empty object)', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const res = await app.fetch(purgeRequest({ token: ADMIN_TOKEN, body: {} }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid_body');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('returns 400 on empty tags array', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [] } }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tags array exceeds MAX_PURGE_TAGS', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const tooMany = Array.from({ length: MAX_PURGE_TAGS + 1 }, (_, i) => `product:p-${i}`);
    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: tooMany } }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tags contains non-string entries', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [123] } }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a tag is the empty string', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [''] } }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when purgeEverything is combined with tags (exclusivity)', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({
        token: ADMIN_TOKEN,
        body: { purgeEverything: true, tags: ['product:procore'] },
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(purge).not.toHaveBeenCalled();
  });
});

describe('POST /admin/purge — native cache purge', () => {
  it('purges by tags via ctx.cache.purge and echoes them', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({
        token: ADMIN_TOKEN,
        body: { tags: ['product:procore', 'vendor:autodesk'] },
      }),
      makeEnv(),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      errors: [],
      tags: ['product:procore', 'vendor:autodesk'],
    });
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith({ tags: ['product:procore', 'vendor:autodesk'] });
  });

  it('purges by pathPrefixes', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { pathPrefixes: ['/products/'] } }),
      makeEnv(),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      errors: [],
      pathPrefixes: ['/products/'],
    });
    expect(purge).toHaveBeenCalledWith({ pathPrefixes: ['/products/'] });
  });

  it('purges everything', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { purgeEverything: true } }),
      makeEnv(),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, errors: [], purgeEverything: true });
    expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
  });

  it('unions tags + pathPrefixes in a single combined purge call', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge();

    const res = await app.fetch(
      purgeRequest({
        token: ADMIN_TOKEN,
        body: { tags: ['taxonomy'], pathPrefixes: ['/categories/'] },
      }),
      makeEnv(),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(purge).toHaveBeenCalledWith({ tags: ['taxonomy'], pathPrefixes: ['/categories/'] });
  });

  it('returns 502 + surfaced errors when the platform rejects the purge', async () => {
    const app = makeApp();
    const { ctx, purge } = ctxWithPurge({
      success: false,
      errors: [{ code: 429, message: 'rate limited' }],
    });

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['product:procore'] } }),
      makeEnv(),
      ctx,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      success: false,
      errors: [{ code: 429, message: 'rate limited' }],
      tags: ['product:procore'],
    });
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('reports a 200 no-op when native cache is disabled (ctx.cache absent)', async () => {
    // The prod-today + local/miniflare path: caching is not enabled on the
    // entrypoint, so there is nothing to purge. The CI post-promote step and
    // manual callers must still see a 200.
    const app = makeApp();

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['taxonomy', 'route:browse'] } }),
      makeEnv(),
      ctxNoCache(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      skipped: 'cache_disabled',
      errors: [],
      tags: ['taxonomy', 'route:browse'],
    });
  });
});

describe('POST /admin/purge — Datadog logging + metric', () => {
  it('forwards both a log and a count metric via ctx.waitUntil (source=manual default)', async () => {
    const app = makeApp();
    const { ctx } = ctxWithPurge();

    await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['product:procore'] } }),
      makeEnv({ DD_API_KEY: 'fake-dd-key' }),
      ctx,
    );

    // Two fire-and-forget forwards: the structured log (AECI-31) and the
    // `aeci.cache.purge` count metric (AECI-66).
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('still emits telemetry on the cache-disabled no-op path', async () => {
    const app = makeApp();
    const ctx = ctxNoCache();

    await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['product:procore'] } }),
      makeEnv({ DD_API_KEY: 'fake-dd-key' }),
      ctx,
    );

    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('reflects ?source=webhook in both the log and the count metric', async () => {
    // Spy on global fetch to capture the Datadog payloads. The purge goes via
    // the ctx.cache.purge mock, so global fetch only sees the DD POSTs: one to
    // the logs intake (/api/v2/logs), one to the metrics intake (/api/v2/series).
    const app = makeApp();

    const originalFetch = globalThis.fetch;
    const ddCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        ddCalls.push({ url: String(input), body: JSON.parse(init.body as string) });
      }
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    // Native cache enabled, with a real waitUntil so the DD fetches actually fire.
    const purge = vi
      .fn()
      .mockResolvedValue({ success: true, errors: [] } satisfies CachePurgeResult);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: vi.fn(),
      props: {},
      exports: {},
      cache: { purge },
    } as unknown as ExecutionContext;

    try {
      await app.fetch(
        purgeRequest({
          token: ADMIN_TOKEN,
          body: { tags: ['product:procore'] },
          search: '?source=webhook',
        }),
        makeEnv({ DD_API_KEY: 'fake-dd-key' }),
        ctx,
      );
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const log = ddCalls.find((c) => c.url.includes('/api/v2/logs'))?.body;
    expect(log).toMatchObject({
      message: 'aeci.cache.purge',
      source: 'webhook',
      mode: 'tags',
      tags_count: 1,
      outcome: 'ok',
    });

    const metric = ddCalls.find((c) => c.url.includes('/api/v2/series'))?.body as
      | { series: { metric: string; type: number; tags: string[] }[] }
      | undefined;
    expect(metric).toBeDefined();
    expect(metric!.series[0]!.metric).toBe('aeci.cache.purge');
    expect(metric!.series[0]!.type).toBe(1); // count
    expect(metric!.series[0]!.tags).toEqual(
      expect.arrayContaining(['source:webhook', 'outcome:ok', 'mode:tags']),
    );
  });
});
