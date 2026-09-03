import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './env';
import { rememberPosthogDistinctId } from '@aeci/shared/posthog';

import { logToPosthog, submitCount, submitDistribution, submitGauge } from './posthog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, OTLP payload shapes) are covered canonically in
// packages/shared/src/posthog.spec.ts. These tests pin what this module owns:
// the *API Worker's* config wiring (service/source/worker = aeci-api) and the
// `posthogDistinctId` stamp. This adapter fanned out to a second vendor during
// the AECI-639 dual-run; AECI-651 removed that leg, so PostHog is the only
// intake a call may reach — asserted explicitly below.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
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

function makeRequest(url = 'http://localhost:8787/api/health'): Request {
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

/** All intake URLs hit during the call, in dispatch order. */
function urls(): string[] {
  return fetchSpy.mock.calls.map((call) => call[0] as string);
}

function bodyFor(url: string): Record<string, unknown> {
  const call = fetchSpy.mock.calls.find((c) => c[0] === url)!;
  return JSON.parse(call[1]!.body as string);
}

describe('API Worker telemetry adapter (config wiring)', () => {
  it('tags PostHog logs with service.name/service/worker=aeci-api and source=worker', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ ENV: 'staging' }), makeRequest(), { message: 'health' });
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
      'service.name': 'aeci-api',
      service: 'aeci-api',
      worker: 'aeci-api',
      source: 'worker',
      env: 'staging',
      version: 'abc123',
    });
  });
});

describe('API Worker telemetry adapter (posthogDistinctId, AECI-644 / §AW3)', () => {
  /** Log-record attributes from the PostHog OTLP body, as a plain map. */
  function posthogLogAttributes(): Record<string, unknown> {
    const body = bodyFor('https://us.i.posthog.com/i/v1/logs') as {
      resourceLogs: {
        scopeLogs: {
          logRecords: { attributes: { key: string; value: { stringValue?: string } }[] }[];
        }[];
      }[];
    };
    const attributes = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes;
    return Object.fromEntries(attributes.map((a) => [a.key, a.value.stringValue]));
  }

  it('stamps the log record with the registered distinct id', async () => {
    const request = makeRequest('http://localhost:8787/api/admin/claims');
    rememberPosthogDistinctId(request, 'user-abc');

    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), request, { message: 'claim approved' });
    await Promise.all(promises);

    expect(posthogLogAttributes()).toHaveProperty('posthogDistinctId', 'user-abc');
  });

  it('omits the key on an unregistered request (cron, queue, Workflow, anonymous)', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'cron ran' });
    await Promise.all(promises);

    expect(Object.keys(posthogLogAttributes())).not.toContain('posthogDistinctId');
  });
});

describe('API Worker telemetry adapter (single vendor, AECI-651)', () => {
  it('logToPosthog reaches the PostHog logs intake and nothing else', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    await Promise.all(promises);

    expect(urls()).toEqual(['https://us.i.posthog.com/i/v1/logs']);
  });

  it.each([
    ['submitCount', submitCount],
    ['submitGauge', submitGauge],
    ['submitDistribution', submitDistribution],
  ])('%s reaches the PostHog metrics intake and nothing else', async (_name, submit) => {
    const { ctx, promises } = makeCtx();
    submit(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1, ['outcome:ok']);
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

  it('swallows a transport failure rather than throwing into the request path', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('posthog down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });

    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('logToPosthog: forward failed', expect.any(Error));
  });
});
