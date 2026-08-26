import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatadogClient, type DatadogEnv } from './datadog';

// Neutral per-Worker config — the canonical transport behaviour is independent
// of which Worker instantiates it; the API/web adapters assert their own
// service/ddsource/worker constants in apps/*/src/*datadog.spec.ts.
const client = createDatadogClient({
  service: 'aeci-test',
  worker: 'aeci-test',
  ddSource: 'test-source',
});

function makeEnv(overrides: Partial<DatadogEnv> = {}): DatadogEnv {
  return {
    DD_API_KEY: 'secret-key',
    DD_SITE: 'us5.datadoghq.com',
    ENV: 'preview',
    ...overrides,
  };
}

function makeCtx(): {
  ctx: { waitUntil: ReturnType<typeof vi.fn> };
  promises: Promise<unknown>[];
} {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        promises.push(p);
      }),
    },
    promises,
  };
}

function makeRequest(url = 'http://localhost:8787/api/health'): Request {
  return new Request(url);
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createDatadogClient — hostnameFromRequest', () => {
  it('uses the request host (with port) as the hostname dimension', () => {
    expect(client.hostnameFromRequest(makeRequest('https://api.aeci.com/api/health'))).toBe(
      'api.aeci.com',
    );
    expect(client.hostnameFromRequest(makeRequest('http://localhost:8787/x'))).toBe(
      'localhost:8787',
    );
  });

  it('falls back to the worker slug when the URL is unparseable', () => {
    expect(client.hostnameFromRequest({ url: 'not a url' } as Request)).toBe('aeci-test');
  });
});

describe('createDatadogClient — logToDatadog', () => {
  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv({ DD_API_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches via ctx.waitUntil and posts to the logs intake URL', async () => {
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://http-intake.logs.us5.datadoghq.com/api/v2/logs');
    expect((init!.headers as Record<string, string>)['dd-api-key']).toBe('secret-key');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('tags the payload with service/hostname/ddsource and env/app/worker/locale ddtags', async () => {
    const { ctx, promises } = makeCtx();
    client.logToDatadog(
      ctx as never,
      makeEnv({ ENV: 'staging' }),
      makeRequest('http://localhost:8787/api/health'),
      { message: 'health', latencyMs: 8 },
    );
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      message: 'health',
      latencyMs: 8,
      status: 'info',
      service: 'aeci-test',
      hostname: 'localhost:8787',
      ddsource: 'test-source',
      ddtags: 'env:staging,app:aeci,worker:aeci-test,locale:en-US',
    });
  });

  it('propagates an explicit level into the status field', async () => {
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv(), makeRequest(), {
      message: 'boom',
      level: 'error',
    });
    await Promise.all(promises);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).status).toBe('error');
  });

  it('defaults env to development in ddtags when env.ENV is unset', async () => {
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv({ ENV: undefined }), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).ddtags).toBe(
      'env:development,app:aeci,worker:aeci-test,locale:en-US',
    );
  });

  it('uses DD_SITE for non-US regions', async () => {
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv({ DD_SITE: 'datadoghq.eu' }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
  });

  it('swallows fetch failures without throwing', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('warns (without throwing) when the intake rejects with a non-2xx — e.g. a bad DD_API_KEY', async () => {
    // The fetch RESOLVES on a 403; the throw-only path would swallow it silently.
    // The `res.ok` check must surface it so a rejected key is visible in CF logs.
    fetchSpy.mockResolvedValueOnce(new Response('{"errors":["Forbidden"]}', { status: 403 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'logToDatadog: intake rejected 403',
      expect.stringContaining('Forbidden'),
    );
  });
});

describe('createDatadogClient — submitDistribution', () => {
  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitDistribution(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined }),
      makeRequest(),
      'aeci.metric',
      5,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a distribution point to the metrics intake with host + merged tags', async () => {
    const { ctx, promises } = makeCtx();
    client.submitDistribution(
      ctx as never,
      makeEnv(),
      makeRequest('https://api.aeci.com/x'),
      'aeci.api.query.duration_ms',
      23,
      ['endpoint:/api/products/:slug', 'status:200'],
    );
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.us5.datadoghq.com/api/v1/distribution_points');
    const series = JSON.parse(init!.body as string).series[0];
    expect(series.metric).toBe('aeci.api.query.duration_ms');
    expect(series.points[0][1]).toEqual([23]);
    expect(series.host).toBe('api.aeci.com');
    expect(series.tags).toEqual(
      expect.arrayContaining([
        'env:preview',
        'app:aeci',
        'service:aeci-test',
        'worker:aeci-test',
        'locale:en-US',
        'endpoint:/api/products/:slug',
        'status:200',
      ]),
    );
  });

  it('honors DD_SITE for the metrics host', async () => {
    const { ctx, promises } = makeCtx();
    client.submitDistribution(
      ctx as never,
      makeEnv({ DD_SITE: 'datadoghq.eu' }),
      makeRequest(),
      'aeci.metric',
      1,
    );
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.datadoghq.eu/api/v1/distribution_points');
  });

  it('swallows fetch failures without throwing', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('createDatadogClient — submitCount', () => {
  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitCount(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined }),
      makeRequest(),
      'aeci.metric',
      1,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a count series (type 1) with resources + merged tags', async () => {
    const { ctx, promises } = makeCtx();
    client.submitCount(
      ctx as never,
      makeEnv(),
      makeRequest('https://api.aeci.com/x'),
      'aeci.api.data_gap',
      2,
      ['gap_type:missing_vendor'],
    );
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.us5.datadoghq.com/api/v2/series');
    const series = JSON.parse(init!.body as string).series[0];
    expect(series.metric).toBe('aeci.api.data_gap');
    expect(series.type).toBe(1);
    expect(series.points[0]).toMatchObject({ value: 2 });
    expect(series.points[0].timestamp).toEqual(expect.any(Number));
    expect(series.resources).toEqual([{ name: 'api.aeci.com', type: 'host' }]);
    expect(series.tags).toEqual(
      expect.arrayContaining(['service:aeci-test', 'worker:aeci-test', 'gap_type:missing_vendor']),
    );
  });

  it('swallows fetch failures without throwing', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('warns when the metrics intake rejects with a non-2xx (silent metric drop otherwise)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"status":"error"}', { status: 403 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('submitMetric: intake rejected 403', expect.any(String));
  });
});

describe('createDatadogClient — submitGauge', () => {
  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitGauge(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined }),
      makeRequest(),
      'aeci.algolia.index_drift',
      0,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a gauge series (type 3) with resources + merged tags', async () => {
    const { ctx, promises } = makeCtx();
    client.submitGauge(
      ctx as never,
      makeEnv(),
      makeRequest('https://api.aeci.com/x'),
      'aeci.algolia.index_drift',
      -5,
      ['entity:vendors', 'index:production_vendors'],
    );
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.us5.datadoghq.com/api/v2/series');
    const series = JSON.parse(init!.body as string).series[0];
    expect(series.metric).toBe('aeci.algolia.index_drift');
    expect(series.type).toBe(3);
    expect(series.points[0]).toMatchObject({ value: -5 });
    expect(series.points[0].timestamp).toEqual(expect.any(Number));
    expect(series.resources).toEqual([{ name: 'api.aeci.com', type: 'host' }]);
    expect(series.tags).toEqual(
      expect.arrayContaining(['service:aeci-test', 'entity:vendors', 'index:production_vendors']),
    );
  });
});

// ─── AECI-666: connection hygiene + batched log forwarding ───────────────────

/**
 * A `Response` whose stream reports cancellation — the observable for "the
 * connection was released". An unread body keeps holding its connection, and
 * enough of those get the runtime to cancel the response into a `fetch` promise
 * that never settles (AECI-666).
 */
function trackedResponse(status: number, body = '{}'): { res: Response; drained: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), drained: () => cancelled };
}

describe('createDatadogClient — response bodies are always released', () => {
  it('cancels the body of a successful intake POST', async () => {
    const { res, drained } = trackedResponse(202);
    fetchSpy.mockResolvedValue(res);
    const { ctx, promises } = makeCtx();

    client.logToDatadog(ctx, makeEnv(), makeRequest(), { message: 'hello' });
    await Promise.all(promises);

    expect(drained()).toBe(true);
  });

  it('consumes the body of a rejected intake POST (and still warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 403 }));
    const { ctx, promises } = makeCtx();

    client.logToDatadog(ctx, makeEnv(), makeRequest(), { message: 'hello' });
    await Promise.all(promises);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('intake rejected 403'),
      expect.stringContaining('forbidden'),
    );
  });

  it('cancels the body of a successful metric POST', async () => {
    const { res, drained } = trackedResponse(202);
    fetchSpy.mockResolvedValue(res);
    const { ctx, promises } = makeCtx();

    client.submitCount(ctx, makeEnv(), makeRequest(), 'aeci.test.count', 1);
    await Promise.all(promises);

    expect(drained()).toBe(true);
  });
});

describe('createDatadogClient — logBatchToDatadog', () => {
  it('forwards N events in ONE request, not N', async () => {
    const { ctx, promises } = makeCtx();
    const events = Array.from({ length: 12 }, (_, i) => ({ message: `audit ${i}` }));

    client.logBatchToDatadog(ctx, makeEnv(), makeRequest(), events);
    await Promise.all(promises);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as unknown[];
    expect(payload).toHaveLength(12);
  });

  it('gives every event the same envelope logToDatadog would', async () => {
    const { ctx, promises } = makeCtx();

    client.logBatchToDatadog(ctx, makeEnv(), makeRequest('https://api.aeci.com/api/promote'), [
      { message: 'audit product.created', level: 'info', entity_id: 'p1' },
    ]);
    await Promise.all(promises);

    const [entry] = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >[];
    expect(entry).toMatchObject({
      message: 'audit product.created',
      status: 'info',
      entity_id: 'p1',
      service: 'aeci-test',
      ddsource: 'test-source',
      hostname: 'api.aeci.com',
    });
    expect(entry.ddtags).toContain('env:preview');
  });

  it('posts to the logs intake, not the metrics intake', async () => {
    const { ctx, promises } = makeCtx();

    client.logBatchToDatadog(ctx, makeEnv(), makeRequest(), [{ message: 'x' }]);
    await Promise.all(promises);

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
    );
  });

  it('never posts an empty array', () => {
    const { ctx } = makeCtx();

    client.logBatchToDatadog(ctx, makeEnv(), makeRequest(), []);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops without DD_API_KEY', () => {
    const { ctx } = makeCtx();

    client.logBatchToDatadog(ctx, makeEnv({ DD_API_KEY: undefined }), makeRequest(), [
      { message: 'x' },
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
