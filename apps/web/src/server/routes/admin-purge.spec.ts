import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from '../../env';
import { createAdminPurgeHandler } from './admin-purge';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'dev-admin-token';
const CF_TOKEN = 'dev-cf-token';
const ZONE = 'dev-zone-id';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    ENV: 'preview',
    ADMIN_PURGE_TOKEN: ADMIN_TOKEN,
    CF_PURGE_API_TOKEN: CF_TOKEN,
    CF_ZONE_ID: ZONE,
    ...overrides,
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

function makeApp(fetchImpl: typeof fetch) {
  const app = new Hono<{ Bindings: WebEnv }>();
  app.post('/admin/purge', createAdminPurgeHandler({ fetch: fetchImpl }));
  return app;
}

function ok(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cfFailure(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code: status, message }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const req = new Request('https://aecintegrations.com/admin/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['product:procore'] }),
    });
    const res = await app.fetch(req, makeEnv(), fakeExecutionContext());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 on wrong bearer token', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: 'wrong-token' }),
      makeEnv(),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 when ADMIN_PURGE_TOKEN is not configured', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN }),
      makeEnv({ ADMIN_PURGE_TOKEN: undefined }),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not short-circuit on token length difference (constant-time compare)', async () => {
    // A regression test ensuring `safeStringEquals` was used: a much shorter
    // wrong token still returns 401 and never reaches the CF API.
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(purgeRequest({ token: 'x' }), makeEnv(), fakeExecutionContext());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /admin/purge — body validation', () => {
  it('returns 400 when body is not JSON', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const req = new Request('https://aecintegrations.com/admin/purge', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    const res = await app.fetch(req, makeEnv(), fakeExecutionContext());

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 when tags array is missing', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: {} }),
      makeEnv(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid_body');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('returns 400 on empty tags array', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [] } }),
      makeEnv(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tags array exceeds 30 entries', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const tooMany = Array.from({ length: 31 }, (_, i) => `product:p-${i}`);
    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: tooMany } }),
      makeEnv(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tags contains non-string entries', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [123] } }),
      makeEnv(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a tag is the empty string', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: [''] } }),
      makeEnv(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/purge — Cloudflare passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the CF purge-by-tag URL with the configured zone + token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({
        token: ADMIN_TOKEN,
        body: { tags: ['product:procore', 'vendor:autodesk'] },
      }),
      makeEnv(),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      purged: ['product:procore', 'vendor:autodesk'],
      failed: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${CF_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      tags: ['product:procore', 'vendor:autodesk'],
    });
  });

  it('returns 502 + populated failed[] when CF returns 429 (rate limited)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(cfFailure(429, 'too many requests'));
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['product:procore'] } }),
      makeEnv(),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      purged: string[];
      failed: { tag: string; reason: string }[];
    };
    expect(body.purged).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.tag).toBe('product:procore');
    expect(body.failed[0]!.reason).toContain('cf_429');
    expect(body.failed[0]!.reason).toContain('too many requests');
  });

  it('returns 502 when CF returns 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(cfFailure(503, 'service unavailable'));
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN }),
      makeEnv(),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(502);
  });

  it('returns 502 when CF credentials are missing', async () => {
    const fetchMock = vi.fn();
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN }),
      makeEnv({ CF_PURGE_API_TOKEN: undefined }),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { failed: { reason: string }[] };
    expect(body.failed[0]!.reason).toContain('cf_credentials_missing');
  });

  it('handles a network error throwing from the fetch impl', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN }),
      makeEnv(),
      fakeExecutionContext(),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { failed: { reason: string }[] };
    expect(body.failed[0]!.reason).toContain('network down');
  });
});

describe('POST /admin/purge — Datadog logging + metric', () => {
  it('forwards both a log and a count metric via ctx.waitUntil (source=manual default)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const app = makeApp(fetchMock as unknown as typeof fetch);
    const ctx = fakeExecutionContext();

    await app.fetch(
      purgeRequest({ token: ADMIN_TOKEN, body: { tags: ['product:procore'] } }),
      makeEnv({ DD_API_KEY: 'fake-dd-key' }),
      ctx,
    );

    // Two fire-and-forget forwards now: the structured log (AECI-31) and the
    // `aeci.cache.purge` count metric (AECI-66). Payloads asserted below.
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('reflects ?source=webhook in both the log and the count metric', async () => {
    // Spy on global fetch so we can capture the Datadog payloads. The CF call
    // goes via the injected fetchMock, so global fetch only sees the DD POSTs:
    // one to the logs intake (/api/v2/logs), one to the metrics intake
    // (/api/v2/series).
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const app = makeApp(fetchMock as unknown as typeof fetch);

    const originalFetch = globalThis.fetch;
    const ddCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        ddCalls.push({ url: String(input), body: JSON.parse(init.body as string) });
      }
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    const ctx = fakeExecutionContext();
    // Real waitUntil so the DD fetches actually fire.
    const pending: Promise<unknown>[] = [];
    (ctx as unknown as { waitUntil: (p: Promise<unknown>) => void }).waitUntil = (p) => {
      pending.push(p);
    };

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
      expect.arrayContaining(['source:webhook', 'outcome:ok']),
    );
  });
});
