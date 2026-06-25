import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import {
  logToDatadog,
  shouldEmitRenderLog,
  submitCount,
  submitDistribution,
} from './server-datadog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, payload shapes) are covered canonically in
// packages/shared/src/datadog.spec.ts. The transport tests here pin the *SSR
// Worker's* config wiring: the adapter must tag with service=aeci-web,
// ddsource=worker-angular, worker=aeci-web. `shouldEmitRenderLog` is web-only
// policy and is tested in full below.

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

describe('SSR Worker datadog adapter (config wiring)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tags logs with service=aeci-web, ddsource=worker-angular, worker=aeci-web', async () => {
    const { ctx, promises } = makeCtx();
    logToDatadog(ctx as never, makeEnv({ ENV: 'production' }), makeRequest(), {
      message: 'render',
    });
    await Promise.all(promises);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      service: 'aeci-web',
      ddsource: 'worker-angular',
      ddtags: 'env:production,app:aeci,worker:aeci-web,locale:en-US',
    });
  });

  it('tags distribution metrics for the SSR Worker', async () => {
    const { ctx, promises } = makeCtx();
    submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.page.render.duration_ms', 42, [
      'cache_status:MISS',
    ]);
    await Promise.all(promises);
    const series = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).series[0];
    expect(series.tags).toEqual(
      expect.arrayContaining(['service:aeci-web', 'worker:aeci-web', 'cache_status:MISS']),
    );
  });

  it('tags count metrics for the SSR Worker', async () => {
    const { ctx, promises } = makeCtx();
    submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.cache.purge', 1, ['source:manual']);
    await Promise.all(promises);
    const series = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).series[0];
    expect(series.tags).toEqual(
      expect.arrayContaining(['service:aeci-web', 'worker:aeci-web', 'source:manual']),
    );
  });
});

describe('shouldEmitRenderLog (AECI-103 ssr.render log gate)', () => {
  // Errors are kept at full fidelity in every env — including production —
  // because the non-cacheable branch's 404/5xx visibility leans on this log.
  it.each<WebEnv['ENV']>(['production', 'demo'])(
    'logs error status even on the public tier %s',
    (env) => {
      for (const status of [404, 500, 503]) {
        expect(shouldEmitRenderLog(makeEnv({ ENV: env }), status)).toBe(true);
      }
    },
  );

  // Non-public tiers keep every render (dev/preview/staging volume is tiny; the
  // full stream verifies the pipe end-to-end).
  it.each<WebEnv['ENV']>(['development', 'preview', 'staging'])(
    'logs 2xx renders in non-public env %s',
    (env) => {
      expect(shouldEmitRenderLog(makeEnv({ ENV: env }), 200)).toBe(true);
    },
  );

  it('logs 2xx renders when ENV is unset (development default)', () => {
    expect(shouldEmitRenderLog(makeEnv({ ENV: undefined }), 200)).toBe(true);
  });

  // Public-tier 2xx (production + demo) is the unbounded firehose we drop — the
  // aeci.ssr.render count metric carries that signal instead.
  it.each<WebEnv['ENV']>(['production', 'demo'])(
    'drops non-error 2xx/3xx on the public tier %s',
    (env) => {
      for (const status of [200, 204, 301, 304]) {
        expect(shouldEmitRenderLog(makeEnv({ ENV: env }), status)).toBe(false);
      }
    },
  );
});
