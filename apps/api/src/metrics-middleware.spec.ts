import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './env';
import { errorHandler } from './errors';
import { metricsMiddleware } from './metrics-middleware';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POSTHOG_PROJECT_KEY: 'phc_test_token',
    POSTHOG_HOST: 'https://us.i.posthog.com',
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

/** The PostHog OTLP metrics intake — the only telemetry destination (AECI-651). */
function posthogMetricCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/i/v1/metrics'));
}

type OtlpAttribute = { key: string; value: { stringValue?: string; doubleValue?: number } };

function posthogPointTags(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = posthogMetricCalls(fetchSpy)[0]!;
  const body = JSON.parse(call[1]!.body as string);
  const point = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
  return Object.fromEntries(
    point.attributes.map((a: OtlpAttribute) => [a.key, a.value.doubleValue ?? a.value.stringValue]),
  );
}

describe('metricsMiddleware (AECI-66)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('emits aeci.api.query.duration_ms tagged by the matched route pattern + status_class', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(
      new Request('http://api/api/products/procore'),
      makeEnv(),
      ctx as never,
    );
    expect(res.status).toBe(200);
    await Promise.all(promises);

    const calls = posthogMetricCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    const metric = JSON.parse(calls[0]![1]!.body as string).resourceMetrics[0].scopeMetrics[0]
      .metrics[0];
    expect(metric.name).toBe('aeci.api.query.duration_ms');
    // endpoint is the *pattern* (low cardinality), not the concrete slug
    expect(posthogPointTags(fetchSpy)).toEqual({
      endpoint: '/api/products/:slug',
      status_class: '2xx',
    });
  });

  it('drops the raw `status` tag — it is a cardinality multiplier (AECI-642 / §3.5)', async () => {
    const { ctx, promises } = makeCtx();
    await makeApp().fetch(new Request('http://api/api/products/procore'), makeEnv(), ctx as never);
    await Promise.all(promises);

    // The exact code lives on the error log for the same request; a per-code
    // split of a duration histogram was never a real query.
    expect(posthogPointTags(fetchSpy)).not.toHaveProperty('status');
  });

  it('still emits with status_class:5xx when a handler throws (sub-router onError converts it first)', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(new Request('http://api/api/boom'), makeEnv(), ctx as never);
    expect(res.status).toBe(500);
    await Promise.all(promises);

    expect(posthogMetricCalls(fetchSpy)).toHaveLength(1);
    expect(posthogPointTags(fetchSpy)).toEqual({
      endpoint: '/api/boom',
      status_class: '5xx',
    });
  });

  it('reaches no Datadog intake — the leg is gone, not merely unconfigured (AECI-651)', async () => {
    const { ctx, promises } = makeCtx();
    await makeApp().fetch(new Request('http://api/api/products/procore'), makeEnv(), ctx as never);
    await Promise.all(promises);

    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('datadoghq'))).toBe(false);
  });

  it('no-ops when the key is absent (never breaks the request)', async () => {
    const { ctx, promises } = makeCtx();
    const res = await makeApp().fetch(
      new Request('http://api/api/products/procore'),
      makeEnv({ POSTHOG_PROJECT_KEY: undefined }),
      ctx as never,
    );
    expect(res.status).toBe(200);
    await Promise.all(promises);
    expect(posthogMetricCalls(fetchSpy)).toHaveLength(0);
  });
});
