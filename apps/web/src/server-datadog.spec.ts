import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import { logToDatadog } from './server-datadog';

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
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://http-intake.logs.datadoghq.eu/api/v2/logs',
    );
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
