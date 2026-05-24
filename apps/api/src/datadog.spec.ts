import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './env';
import { logToDatadog } from './datadog';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'prisma://x',
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

describe('logToDatadog (API Worker)', () => {
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

  it('dispatches via ctx.waitUntil and posts to the intake URL', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
    );
  });

  it('tags every log with service, ddsource=worker, env/app/worker/locale in ddtags, and uses the request host as hostname', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(
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
      service: 'aeci-api',
      hostname: 'localhost:8787',
      ddsource: 'worker',
      ddtags: 'env:staging,app:aeci,worker:aeci-api,locale:en-US',
    });
  });

  it('uses the request host (with port) for the hostname dimension', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest('https://api.aeci.com/api/health'), {
      message: 'x',
    });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.hostname).toBe('api.aeci.com');
  });

  it('defaults env to preview in ddtags when env.ENV is unset', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ ENV: undefined }), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.ddtags).toBe('env:preview,app:aeci,worker:aeci-api,locale:en-US');
  });

  it('uses DD_SITE for non-US regions', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ DD_SITE: 'datadoghq.eu' }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
  });

  it('swallows fetch failures', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
