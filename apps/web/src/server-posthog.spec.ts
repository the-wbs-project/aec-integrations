import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from './env';
import { logToPosthog, submitCount, submitDistribution } from './server-posthog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, OTLP payload shapes) are covered canonically in
// packages/shared/src/posthog.spec.ts. These tests pin what this module owns:
// the *SSR Worker's* config wiring (service/worker = aeci-web,
// source = worker-angular). This adapter fanned out to a second vendor during
// the AECI-639 dual-run; AECI-651 removed that leg, so PostHog is the only
// intake a call may reach — asserted explicitly below.

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
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
});

describe('SSR Worker telemetry adapter (single vendor, AECI-651)', () => {
  it('logToPosthog reaches the PostHog logs intake and nothing else', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'render' });
    await Promise.all(promises);

    expect(urls()).toEqual(['https://us.i.posthog.com/i/v1/logs']);
  });

  it.each([
    ['submitCount', submitCount],
    ['submitDistribution', submitDistribution],
  ])('%s reaches the PostHog metrics intake and nothing else', async (_name, submit) => {
    const { ctx, promises } = makeCtx();
    submit(ctx as never, makeEnv(), makeRequest(), 'aeci.page.render.duration_ms', 42, [
      'cache_status:MISS',
    ]);
    await Promise.all(promises);

    expect(urls()).toEqual(['https://us.i.posthog.com/i/v1/metrics']);
  });

  it('never reaches a Datadog intake — the leg is gone, not merely unconfigured', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await Promise.all(promises);

    expect(urls().some((u) => u.includes('datadoghq'))).toBe(false);
  });

  it('emits nothing at all when POSTHOG_PROJECT_KEY is absent', () => {
    const { ctx } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ POSTHOG_PROJECT_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
