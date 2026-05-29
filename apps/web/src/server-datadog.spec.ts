import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import { logToDatadog, submitCount, submitDistribution } from './server-datadog';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    DD_API_KEY: 'secret-key',
    DD_SITE: 'datadoghq.com',
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

function makeRequest(url = 'http://localhost:8788/'): Request {
  return new Request(url);
}

describe('logToDatadog (web SSR Worker)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ DD_API_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches the POST via ctx.waitUntil (never blocks the response)', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('posts to the Datadog HTTP intake with DD-API-KEY header and json body', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://http-intake.logs.datadoghq.com/api/v2/logs');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'dd-api-key': 'secret-key',
      },
    });
  });

  it('tags every log with service, ddsource=worker-angular, env/app/worker/locale in ddtags, and uses the request host as hostname', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(
      ctx as never,
      makeEnv({ ENV: 'production' }),
      makeRequest('http://localhost:8788/'),
      { message: 'health', latencyMs: 12 },
    );
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      message: 'health',
      latencyMs: 12,
      status: 'info',
      service: 'aeci-web',
      hostname: 'localhost:8788',
      ddsource: 'worker-angular',
      ddtags: 'env:production,app:aeci,worker:aeci-web,locale:en-US',
    });
  });

  it('uses the request host for the hostname dimension in production', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest('https://aeci.com/products'), {
      message: 'x',
    });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.hostname).toBe('aeci.com');
  });

  it('defaults env to preview in ddtags when env.ENV is unset', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ ENV: undefined }), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.ddtags).toBe('env:preview,app:aeci,worker:aeci-web,locale:en-US');
  });

  it('uses DD_SITE when provided (multi-region support)', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ DD_SITE: 'datadoghq.eu' }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
  });

  it('propagates the explicit level into the status field', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), {
      message: 'broken',
      level: 'error',
    });
    await Promise.all(promises);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).status).toBe('error');
  });

  it('swallows fetch failures (observability must not break the request path)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('submitDistribution (web SSR Worker, AECI-66)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    submitDistribution(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined }),
      makeRequest(),
      'aeci.page.render.duration_ms',
      12,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a distribution point to the metrics intake (api.{site}, not the logs host)', async () => {
    const { ctx, promises } = makeCtx();
    submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.page.render.duration_ms', 42, [
      'route_class:detail',
      'cache_status:MISS',
      'status_code:200',
    ]);
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.datadoghq.com/api/v1/distribution_points');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'dd-api-key': 'secret-key' },
    });

    const body = JSON.parse(init!.body as string);
    const series = body.series[0];
    expect(series.metric).toBe('aeci.page.render.duration_ms');
    expect(series.host).toBe('localhost:8788');
    // points: [[<unixSeconds>, [value]]]
    expect(series.points).toHaveLength(1);
    expect(typeof series.points[0][0]).toBe('number');
    expect(series.points[0][1]).toEqual([42]);
    // base tags are merged ahead of caller tags
    expect(series.tags).toEqual(
      expect.arrayContaining([
        'env:preview',
        'app:aeci',
        'service:aeci-web',
        'worker:aeci-web',
        'locale:en-US',
        'route_class:detail',
        'cache_status:MISS',
        'status_code:200',
      ]),
    );
  });

  it('honors DD_SITE for the metrics host', async () => {
    const { ctx, promises } = makeCtx();
    submitDistribution(
      ctx as never,
      makeEnv({ DD_SITE: 'us5.datadoghq.com' }),
      makeRequest(),
      'aeci.page.render.duration_ms',
      1,
    );
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://api.us5.datadoghq.com/api/v1/distribution_points',
    );
  });

  it('swallows fetch failures', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    submitDistribution(ctx as never, makeEnv(), makeRequest(), 'm', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('submitCount (web SSR Worker, AECI-66)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when DD_API_KEY is absent', () => {
    const { ctx } = makeCtx();
    submitCount(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined }),
      makeRequest(),
      'aeci.cache.purge',
      1,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a count series (v2, type=1) with resources + merged tags', async () => {
    const { ctx, promises } = makeCtx();
    submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.cache.purge', 1, [
      'source:manual',
      'outcome:ok',
    ]);
    await Promise.all(promises);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.datadoghq.com/api/v2/series');
    const body = JSON.parse(init!.body as string);
    const series = body.series[0];
    expect(series.metric).toBe('aeci.cache.purge');
    expect(series.type).toBe(1); // count
    expect(series.points).toHaveLength(1);
    expect(typeof series.points[0].timestamp).toBe('number');
    expect(series.points[0].value).toBe(1);
    expect(series.resources).toEqual([{ name: 'localhost:8788', type: 'host' }]);
    expect(series.tags).toEqual(
      expect.arrayContaining(['source:manual', 'outcome:ok', 'service:aeci-web']),
    );
  });
});
