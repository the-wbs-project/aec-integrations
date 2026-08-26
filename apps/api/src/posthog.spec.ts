import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './env';
import { rememberPosthogDistinctId } from '@aeci/shared/posthog';

import { logToPosthog, submitCount, submitDistribution, submitGauge } from './posthog';

// The transport mechanics (no-op without key, intake URLs, ctx.waitUntil,
// error swallowing, OTLP payload shapes) are covered canonically in
// packages/shared/src/posthog.spec.ts. These tests pin two things this module
// owns: the *API Worker's* config wiring (service/source/worker = aeci-api),
// and the §3.1 DUAL-RUN fan-out — every call must reach BOTH vendors, and one
// leg's config being absent must not suppress the other.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
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

  it('tags Datadog logs with service=aeci-api, ddsource=worker (dual-run leg)', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ ENV: 'staging' }), makeRequest(), { message: 'health' });
    await Promise.all(promises);

    expect(bodyFor('https://http-intake.logs.us5.datadoghq.com/api/v2/logs')).toMatchObject({
      service: 'aeci-api',
      ddsource: 'worker',
      ddtags: 'env:staging,app:aeci,worker:aeci-api,locale:en-US',
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

  it('stamps the PostHog leg only — the Datadog leg stays untouched', async () => {
    const request = makeRequest('http://localhost:8787/api/admin/claims');
    rememberPosthogDistinctId(request, 'user-abc');

    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), request, { message: 'claim approved' });
    await Promise.all(promises);

    expect(posthogLogAttributes()).toHaveProperty('posthogDistinctId', 'user-abc');
    // PH-final must stay a one-line deletion: the dual-run Datadog payload is
    // byte-identical to what it was before this issue.
    expect(bodyFor('https://http-intake.logs.us5.datadoghq.com/api/v2/logs')).not.toHaveProperty(
      'posthogDistinctId',
    );
  });

  it('omits the key on an unregistered request (cron, queue, Workflow, anonymous)', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'cron ran' });
    await Promise.all(promises);

    expect(Object.keys(posthogLogAttributes())).not.toContain('posthogDistinctId');
  });
});

describe('API Worker telemetry adapter (dual-run fan-out)', () => {
  it('logToPosthog reaches BOTH the PostHog and the Datadog intake', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    await Promise.all(promises);

    expect(urls()).toEqual([
      'https://us.i.posthog.com/i/v1/logs',
      'https://http-intake.logs.us5.datadoghq.com/api/v2/logs',
    ]);
  });

  it.each([
    ['submitCount', submitCount],
    ['submitGauge', submitGauge],
    ['submitDistribution', submitDistribution],
  ])('%s reaches both metric intakes', async (_name, submit) => {
    const { ctx, promises } = makeCtx();
    submit(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1, ['outcome:ok']);
    await Promise.all(promises);

    expect(urls()).toContain('https://us.i.posthog.com/i/v1/metrics');
    expect(urls().some((u) => u.startsWith('https://api.us5.datadoghq.com/'))).toBe(true);
  });

  it('emits only the PostHog leg when DD_API_KEY is absent', async () => {
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv({ DD_API_KEY: undefined }), makeRequest(), { message: 'x' });
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

  it('a failure on one leg does not stop the other (both are swallowed)', async () => {
    // First dispatch is the PostHog leg — reject it.
    fetchSpy.mockRejectedValueOnce(new Error('posthog down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });

    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(urls()).toContain('https://http-intake.logs.us5.datadoghq.com/api/v2/logs');
    expect(warn).toHaveBeenCalledWith('logToPosthog: forward failed', expect.any(Error));
  });
});
