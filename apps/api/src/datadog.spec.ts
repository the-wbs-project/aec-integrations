import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logToDatadog, submitDistribution } from './datadog';
import type { Env } from './env';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, payload shapes) are covered canonically in
// packages/shared/src/datadog.spec.ts. These tests pin the *API Worker's*
// config wiring: the adapter must tag with service/ddsource/worker = aeci-api.

function makeEnv(overrides: Partial<Env> = {}): Env {
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

describe('API Worker datadog adapter (config wiring)', () => {
  it('tags logs with service=aeci-api, ddsource=worker, worker=aeci-api', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ ENV: 'staging' }), makeRequest(), { message: 'health' });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      service: 'aeci-api',
      ddsource: 'worker',
      ddtags: 'env:staging,app:aeci,worker:aeci-api,locale:en-US',
    });
  });

  it('tags distribution metrics for the API Worker', async () => {
    const { ctx, promises } = makeCtx();
    submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.api.query.duration_ms', 23, [
      'status:200',
    ]);
    await Promise.all(promises);
    const series = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).series[0];
    expect(series.tags).toEqual(
      expect.arrayContaining(['service:aeci-api', 'worker:aeci-api', 'status:200']),
    );
  });
});
