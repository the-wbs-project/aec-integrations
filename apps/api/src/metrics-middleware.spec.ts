import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from './errors';
import type { Env } from './env';
import { metricsMiddleware } from './metrics-middleware';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DD_API_KEY: 'secret-key',
    DD_SITE: 'us5.datadoghq.com',
    ENV: 'preview',
    ...overrides,
  };
}

function makeCtx(): {
  ctx: { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> };
  promises: Promise<unknown>[];
} {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        promises.push(p);
      }),
      passThroughOnException: vi.fn(),
    },
    promises,
  };
}

/**
 * Mirror the production wiring: the timing middleware lives on the parent app;
 * a sub-router owns its own `onError`, so thrown errors become responses before
 * control returns to the middleware's `finally`.
 */
function makeApp() {
  const sub = new Hono<{ Bindings: Env }>();
  sub.onError(errorHandler());
  sub.get('/api/products/:slug', (c) => c.json({ ok: true }));
  sub.get('/api/boom', () => {
    throw new Error('kaboom');
  });

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', metricsMiddleware());
  app.route('/', sub);
  return app;
}

function metricCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/v1/distribution_points'));
}

describe('metricsMiddleware (AECI-66)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('emits aeci.api.query.duration_ms tagged by the matched route pattern + status', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(
      new Request('http://api/api/products/procore'),
      makeEnv(),
      ctx as never,
    );
    expect(res.status).toBe(200);
    await Promise.all(promises);

    const calls = metricCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    const series = JSON.parse(calls[0]![1]!.body as string).series[0];
    expect(series.metric).toBe('aeci.api.query.duration_ms');
    // endpoint is the *pattern* (low cardinality), not the concrete slug
    expect(series.tags).toEqual(
      expect.arrayContaining(['endpoint:/api/products/:slug', 'status:200']),
    );
  });

  it('still emits with status:500 when a handler throws (sub-router onError converts it first)', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(new Request('http://api/api/boom'), makeEnv(), ctx as never);
    expect(res.status).toBe(500);
    await Promise.all(promises);

    const calls = metricCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    const series = JSON.parse(calls[0]![1]!.body as string).series[0];
    expect(series.tags).toEqual(expect.arrayContaining(['endpoint:/api/boom', 'status:500']));
  });

  it('no-ops without DD_API_KEY (never posts a metric, never breaks the request)', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(
      new Request('http://api/api/products/procore'),
      makeEnv({ DD_API_KEY: undefined }),
      ctx as never,
    );
    expect(res.status).toBe(200);
    await Promise.all(promises);
    expect(metricCalls(fetchSpy)).toHaveLength(0);
  });
});
