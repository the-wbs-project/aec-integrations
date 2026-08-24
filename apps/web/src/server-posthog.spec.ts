import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import { logToPosthog, submitCount, submitDistribution } from './server-posthog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, OTLP payload shapes) are covered canonically in
// packages/shared/src/posthog.spec.ts. These tests pin two things this module
// owns: the *SSR Worker's* config wiring (service/worker = aeci-web,
// source = worker-angular), and the §3.1 DUAL-RUN fan-out.

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    DD_API_KEY: 'dd-secret-key',
    DD_SITE: 'us5.datadoghq.com',
    POSTHOG_PROJECT_KEY: 'phc_test_token',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    ENV: 'preview',
    COMMIT_SHA: 'abc123',
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

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function urls(): string[] {
  return fetchSpy.mock.calls.map((call) => call[0] as string);
}

function bodyFor(url: string): Record<string, unknown> {
  const call = fetchSpy.mock.calls.find((c) => c[0] === url)!;
  return JSON.parse(call[1]!.body as string);
}

describe('SSR Worker telemetry adapter (config wiring)', () => {
  it('tags PostHog logs with service.name/service/worker=aeci-web and source=worker-angular', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ ENV: 'production' }), makeRequest(), {
      message: 'render',
    });
    await Promise.all(promises);

    const resource = (
      bodyFor('https://us.i.posthog.com/i/v1/logs') as {
        resourceLogs: {
          resource: { attributes: { key: string; value: { stringValue: string } }[] };
        }[];
      }
    ).resourceLogs[0]!.resource;
    const attributes = Object.fromEntries(
      resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    expect(attributes).toMatchObject({
      'service.name': 'aeci-web',
      service: 'aeci-web',
      worker: 'aeci-web',
      source: 'worker-angular',
      env: 'production',
    });
  });

  it('tags Datadog logs with service=aeci-web, ddsource=worker-angular (dual-run leg)', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ ENV: 'production' }), makeRequest(), {
      message: 'render',
    });
    await Promise.all(promises);

    expect(bodyFor('https://http-intake.logs.us5.datadoghq.com/api/v2/logs')).toMatchObject({
      service: 'aeci-web',
      ddsource: 'worker-angular',
      ddtags: 'env:production,app:aeci,worker:aeci-web,locale:en-US',
    });
  });
});

describe('SSR Worker telemetry adapter (dual-run fan-out)', () => {
  it('logToPosthog reaches BOTH intakes', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'render' });
    await Promise.all(promises);

    expect(urls()).toEqual([
      'https://us.i.posthog.com/i/v1/logs',
      'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
    ]);
  });

  it.each([
    ['submitCount', submitCount],
    ['submitDistribution', submitDistribution],
  ])('%s reaches both metric intakes', async (_name, submit) => {
    const { ctx, promises } = makeCtx();
    submit(ctx as never, makeEnv(), makeRequest(), 'aeci.page.render.duration_ms', 42, [
      'cache_status:MISS',
    ]);
    await Promise.all(promises);

    expect(urls()).toContain('https://us.i.posthog.com/i/v1/metrics');
    expect(urls().some((u) => u.startsWith('https://api.us5.datadoghq.com/'))).toBe(true);
  });

  it('emits only the PostHog leg when DD_API_KEY is absent', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ DD_API_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(urls()).toEqual(['https://us.i.posthog.com/i/v1/logs']);
  });

  it('emits only the Datadog leg when POSTHOG_PROJECT_KEY is absent', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ POSTHOG_PROJECT_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(urls()).toEqual(['https://http-intake.logs.us5.datadoghq.com/api/v2/logs']);
  });

  it('emits nothing at all when neither vendor is configured', () => {
    const { ctx } = makeCtx();
    logToPosthog(
      ctx as never,
      makeEnv({ DD_API_KEY: undefined, POSTHOG_PROJECT_KEY: undefined }),
      makeRequest(),
      { message: 'x' },
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
