import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import { logToDatadog, submitCount, submitDistribution } from './server-datadog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, payload shapes) are covered canonically in
// packages/shared/src/datadog.spec.ts. The tests here pin the *SSR Worker's*
// Datadog config wiring: the adapter must tag with service=aeci-web,
// ddsource=worker-angular, worker=aeci-web.
//
// AECI-642: this module is no longer a call-site surface — the Worker imports
// telemetry from `server-posthog.ts`, which fans out to both vendors. The
// `shouldEmitRenderLog` gate moved to `server-render-log.ts` (policy, not
// transport) and is tested in `server-render-log.spec.ts`.

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
