import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPosthogClient,
  rememberPosthogDistinctId,
  type PosthogEnv,
  type PosthogLogEvent,
} from './posthog';

// `posthog-node/edge` owns the events + exceptions pipe (spec §2). It is mocked
// here so the assertions can pin the *contract* the transport must honour:
// per-call construction with the workerd option set, and a flush dispatched
// through `ctx.waitUntil` — never a `*Immediate` method, which resolves before
// the network send completes and loses the event when the isolate tears down.
const posthogNode = vi.hoisted(() => ({
  constructed: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  captureImmediate: vi.fn(),
  captureExceptionImmediate: vi.fn(),
  flush: vi.fn(async () => undefined),
  isFeatureEnabled: vi.fn(async () => true as boolean | undefined),
}));

vi.mock('posthog-node/edge', () => ({
  PostHog: class {
    capture = posthogNode.capture;
    captureException = posthogNode.captureException;
    captureImmediate = posthogNode.captureImmediate;
    captureExceptionImmediate = posthogNode.captureExceptionImmediate;
    flush = posthogNode.flush;
    isFeatureEnabled = posthogNode.isFeatureEnabled;
    constructor(apiKey: string, options: unknown) {
      posthogNode.constructed(apiKey, options);
    }
  },
}));

// Neutral per-Worker config — the canonical transport behaviour is independent
// of which Worker instantiates it; the API/web adapters assert their own
// service/source/worker constants in apps/*/src/*posthog.spec.ts.
const client = createPosthogClient({
  service: 'aeci-test',
  worker: 'aeci-test',
  source: 'test-source',
});

const DURATION_BOUNDS = [
  5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 1500, 2500, 5000, 7500, 10000,
];

function makeEnv(overrides: Partial<PosthogEnv> = {}): PosthogEnv {
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
  vi.clearAllMocks();
});

type OtlpAttribute = { key: string; value: { stringValue?: string; doubleValue?: number } };

/** Last request body sent to the intake, parsed. */
function lastBody(): Record<string, never> {
  return JSON.parse(fetchSpy.mock.calls.at(-1)![1]!.body as string);
}

function attributeMap(attributes: OtlpAttribute[]): Record<string, string | number | undefined> {
  return Object.fromEntries(
    attributes.map((a) => [a.key, a.value.doubleValue ?? a.value.stringValue]),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logRecord(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lastBody() as any).resourceLogs[0].scopeLogs[0].logRecords[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logResource(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lastBody() as any).resourceLogs[0].resource;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function metric(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lastBody() as any).resourceMetrics[0].scopeMetrics[0].metrics[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function metricResource(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lastBody() as any).resourceMetrics[0].resource;
}

describe('createPosthogClient — hostnameFromRequest', () => {
  it('uses the request host (with port) as the host dimension', () => {
    expect(client.hostnameFromRequest(makeRequest('https://api.aeci.com/api/health'))).toBe(
      'api.aeci.com',
    );
    expect(client.hostnameFromRequest(makeRequest('http://localhost:8787/x'))).toBe(
      'localhost:8787',
    );
  });

  it('falls back to the worker slug when the URL is unparseable', () => {
    expect(client.hostnameFromRequest({ url: 'not a url' } as Request)).toBe('aeci-test');
  });
});

describe('createPosthogClient — logToPosthog', () => {
  it('is a no-op when POSTHOG_PROJECT_KEY is absent (invariant 3)', () => {
    const { ctx } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv({ POSTHOG_PROJECT_KEY: undefined }), makeRequest(), {
      message: 'x',
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches via ctx.waitUntil and posts to the OTLP logs intake with a Bearer header', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'health' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/i/v1/logs');
    // The Bearer header is REQUIRED on the OTLP intakes; `?api_key=` 401s there.
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer phc_test_token');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('defaults to the US INGEST host (not the management host) when POSTHOG_HOST is unset', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv({ POSTHOG_HOST: undefined }), makeRequest(), {
      message: 'x',
    });
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://us.i.posthog.com/i/v1/logs');
  });

  it('strips a trailing slash off POSTHOG_HOST', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(
      ctx as never,
      makeEnv({ POSTHOG_HOST: 'https://eu.i.posthog.com/' }),
      makeRequest(),
      { message: 'x' },
    );
    await Promise.all(promises);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://eu.i.posthog.com/i/v1/logs');
  });

  it('puts the message in the OTLP body and the remaining fields in record attributes', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), {
      message: 'health',
      latencyMs: 8,
      route: '/api/health',
    });
    await Promise.all(promises);

    const record = logRecord();
    expect(record.body).toEqual({ stringValue: 'health' });
    expect(attributeMap(record.attributes)).toEqual({ latencyMs: 8, route: '/api/health' });
  });

  it.each([
    ['debug', 5, 'DEBUG'],
    ['info', 9, 'INFO'],
    ['warn', 13, 'WARN'],
    ['error', 17, 'ERROR'],
  ] as const)('maps level %s to severityNumber %i / %s', async (level, number, text) => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x', level });
    await Promise.all(promises);
    const record = logRecord();
    expect(record.severityNumber).toBe(number);
    expect(record.severityText).toBe(text);
  });

  it('defaults an unlevelled event to INFO (9)', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    expect(logRecord().severityNumber).toBe(9);
  });

  it('emits nanosecond timestamps as STRINGS (a JS number loses ns precision)', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    const record = logRecord();
    expect(typeof record.timeUnixNano).toBe('string');
    expect(record.timeUnixNano).toMatch(/^\d+000000$/);
    expect(record.observedTimeUnixNano).toBe(record.timeUnixNano);
  });

  it('carries the shared tag vocabulary as RESOURCE attributes, including service.name', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(
      ctx as never,
      makeEnv({ ENV: 'staging' }),
      makeRequest('https://api.aeci.com/x'),
      { message: 'x' },
    );
    await Promise.all(promises);

    expect(attributeMap(logResource().attributes)).toEqual({
      // The Logs explorer's service filter reads ONLY the dotted key.
      'service.name': 'aeci-test',
      env: 'staging',
      app: 'aeci',
      service: 'aeci-test',
      worker: 'aeci-test',
      source: 'test-source',
      version: 'abc123',
      locale: 'en-US',
      host: 'api.aeci.com',
    });
  });

  it('defaults env to development when env.ENV is unset', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv({ ENV: undefined }), makeRequest(), { message: 'x' });
    await Promise.all(promises);
    expect(attributeMap(logResource().attributes).env).toBe('development');
  });

  it('drops undefined/null attributes entirely rather than sending "null"', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv({ COMMIT_SHA: undefined }), makeRequest(), {
      message: 'x',
      present: 'yes',
      missing: undefined,
      empty: null,
    });
    await Promise.all(promises);

    const keys = logRecord().attributes.map((a: OtlpAttribute) => a.key);
    expect(keys).toEqual(['present']);
    // `version` follows the same rule on the resource side.
    expect(attributeMap(logResource().attributes)).not.toHaveProperty('version');
  });

  it('types attribute values: numbers as doubleValue, everything else as stringValue', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), {
      message: 'x',
      count: 42,
      name: 'promote',
      flag: true,
      payload: { a: 1 },
    });
    await Promise.all(promises);

    const byKey = Object.fromEntries(
      logRecord().attributes.map((a: OtlpAttribute) => [a.key, a.value]),
    );
    expect(byKey.count).toEqual({ doubleValue: 42 });
    expect(byKey.name).toEqual({ stringValue: 'promote' });
    expect(byKey.flag).toEqual({ stringValue: 'true' });
    expect(byKey.payload).toEqual({ stringValue: '{"a":1}' });
  });

  it('swallows fetch failures without throwing (invariant 2)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('logToPosthog: forward failed', expect.any(Error));
  });

  it('warns (without throwing) when the intake rejects with a non-2xx — e.g. a rotated token', async () => {
    // The fetch RESOLVES on a 401; a throw-only path would swallow it silently
    // and every log would disappear with no indication at all.
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"No token provided"}', { status: 401 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x' });
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'logToPosthog: intake rejected 401',
      expect.stringContaining('No token provided'),
    );
  });
});

describe('createPosthogClient — posthogDistinctId on logs (AECI-644 / §AW3)', () => {
  it('stamps the verified Supabase user id on every log from a registered request', async () => {
    const request = makeRequest('https://api.aeci.com/api/reviews');
    rememberPosthogDistinctId(request, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');

    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), request, { message: 'x', route: '/api/reviews' });
    await Promise.all(promises);

    // The exact camelCase spelling is load-bearing — it is the property PostHog
    // joins logs to persons on.
    expect(attributeMap(logRecord().attributes)).toEqual({
      route: '/api/reviews',
      posthogDistinctId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
  });

  it('OMITS the key entirely for an anonymous request — no null, no empty string', async () => {
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), { message: 'x', route: '/' });
    await Promise.all(promises);

    // Key ABSENCE, not a falsy value: a `null`/`""`/`"anonymous"` here would
    // mint a bogus person and corrupt every person-linked view in the project.
    const keys = logRecord().attributes.map((a: OtlpAttribute) => a.key);
    expect(keys).not.toContain('posthogDistinctId');
    expect(attributeMap(logRecord().attributes)).not.toHaveProperty('posthogDistinctId');
  });

  it('omits the key on a cron / queue / Workflow request even after another request registered one', async () => {
    // Same isolate, two requests: the authed one registers, the synthetic one
    // the scheduled handler and the promote Workflow build never does.
    const authed = makeRequest('https://api.aeci.com/api/admin/claims');
    rememberPosthogDistinctId(authed, 'user-123');

    const cronRequest = new Request('https://api.aeci.com/__scheduled/algolia-sync');
    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), cronRequest, {
      message: 'cron ran',
      job: 'algolia-sync',
    });
    await Promise.all(promises);

    expect(attributeMap(logRecord().attributes)).toEqual({ job: 'algolia-sync' });
  });

  it('strips a caller-supplied id rather than trusting it (the transport is the only writer)', async () => {
    // The event type says `never`, but a spread can smuggle one past the
    // compiler — so the strip is enforced at runtime too.
    const forged = {
      message: 'x',
      route: '/',
      posthogDistinctId: 'forged-person',
    } as unknown as PosthogLogEvent;

    const { ctx, promises } = makeCtx();
    client.logToPosthog(ctx as never, makeEnv(), makeRequest(), forged);
    await Promise.all(promises);

    expect(attributeMap(logRecord().attributes)).toEqual({ route: '/' });
  });

  it('never puts the id on a metric, even from a registered request (spec §2)', async () => {
    const request = makeRequest('https://api.aeci.com/api/reviews');
    rememberPosthogDistinctId(request, 'user-123');

    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), request, 'aeci.api.reviews', 1, ['outcome:ok']);
    await Promise.all(promises);

    expect(attributeMap(metric().sum.dataPoints[0].attributes)).not.toHaveProperty(
      'posthogDistinctId',
    );
    expect(attributeMap(metricResource().attributes)).not.toHaveProperty('posthogDistinctId');
  });
});

describe('createPosthogClient — submitCount', () => {
  it('is a no-op when POSTHOG_PROJECT_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitCount(
      ctx as never,
      makeEnv({ POSTHOG_PROJECT_KEY: undefined }),
      makeRequest(),
      'aeci.metric',
      1,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a monotonic DELTA sum to the OTLP metrics intake', async () => {
    const { ctx, promises } = makeCtx();
    client.submitCount(
      ctx as never,
      makeEnv(),
      makeRequest('https://api.aeci.com/x'),
      'aeci.api.data_gap',
      2,
      ['gap_type:missing_vendor'],
    );
    await Promise.all(promises);

    expect(fetchSpy.mock.calls[0]![0]).toBe('https://us.i.posthog.com/i/v1/metrics');
    const m = metric();
    expect(m.name).toBe('aeci.api.data_gap');
    expect(m.sum.aggregationTemporality).toBe(1);
    expect(m.sum.isMonotonic).toBe(true);
    // Data points use `asDouble`; `doubleValue` is the ATTRIBUTE wrapper.
    expect(m.sum.dataPoints[0].asDouble).toBe(2);
    expect(typeof m.sum.dataPoints[0].timeUnixNano).toBe('string');
  });

  it('carries ONLY the caller tags on the point, and the vocabulary on the resource', async () => {
    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1, [
      'outcome:ok',
      'job:algolia_sync',
    ]);
    await Promise.all(promises);

    // Repeating the shared vocabulary per point multiplies the series count
    // against PostHog's 1,000-series guardrail for zero extra information.
    expect(attributeMap(metric().sum.dataPoints[0].attributes)).toEqual({
      outcome: 'ok',
      job: 'algolia_sync',
    });
    expect(attributeMap(metricResource().attributes)).toEqual({
      'service.name': 'aeci-test',
      env: 'preview',
      app: 'aeci',
      service: 'aeci-test',
      worker: 'aeci-test',
      source: 'test-source',
      version: 'abc123',
      locale: 'en-US',
    });
  });

  it('does NOT put `host` on the metrics resource (AECI-645 / §AW4 cardinality)', async () => {
    const { ctx, promises } = makeCtx();
    client.submitCount(
      ctx as never,
      makeEnv(),
      // A per-PR preview Worker hostname: unbounded cardinality, one per PR forever.
      makeRequest('https://aeci-web-pr-123.aec-integrations.workers.dev/x'),
      'aeci.metric',
      1,
    );
    await Promise.all(promises);

    expect(attributeMap(metricResource().attributes)).not.toHaveProperty('host');
    // Logs keep it — they are not a series model, and it answers "which
    // hostname served this".
    const { ctx: ctx2, promises: p2 } = makeCtx();
    client.logToPosthog(
      ctx2 as never,
      makeEnv(),
      makeRequest('https://aeci-web-pr-123.aec-integrations.workers.dev/x'),
      { message: 'x' },
    );
    await Promise.all(p2);
    expect(attributeMap(logResource().attributes).host).toBe(
      'aeci-web-pr-123.aec-integrations.workers.dev',
    );
  });

  it('splits tag strings on the FIRST colon only (route patterns contain colons)', async () => {
    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1, [
      'endpoint:/api/products/:slug',
      'bare',
    ]);
    await Promise.all(promises);

    expect(attributeMap(metric().sum.dataPoints[0].attributes)).toEqual({
      endpoint: '/api/products/:slug',
      bare: '',
    });
  });

  it('warns when the metrics intake rejects with a non-2xx (silent metric drop otherwise)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"quota"}', { status: 403 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.submitCount(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('submitCount: intake rejected 403', expect.any(String));
  });
});

describe('createPosthogClient — submitGauge', () => {
  it('is a no-op when POSTHOG_PROJECT_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitGauge(
      ctx as never,
      makeEnv({ POSTHOG_PROJECT_KEY: undefined }),
      makeRequest(),
      'aeci.algolia.index_drift',
      0,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a gauge point (no aggregationTemporality — a gauge has none)', async () => {
    const { ctx, promises } = makeCtx();
    client.submitGauge(ctx as never, makeEnv(), makeRequest(), 'aeci.algolia.index_drift', -5, [
      'entity:vendors',
    ]);
    await Promise.all(promises);

    const m = metric();
    expect(m.name).toBe('aeci.algolia.index_drift');
    expect(m.gauge.dataPoints[0].asDouble).toBe(-5);
    expect(m.gauge).not.toHaveProperty('aggregationTemporality');
    expect(attributeMap(m.gauge.dataPoints[0].attributes)).toEqual({ entity: 'vendors' });
  });
});

describe('createPosthogClient — submitDistribution', () => {
  it('is a no-op when POSTHOG_PROJECT_KEY is absent', () => {
    const { ctx } = makeCtx();
    client.submitDistribution(
      ctx as never,
      makeEnv({ POSTHOG_PROJECT_KEY: undefined }),
      makeRequest(),
      'aeci.metric',
      5,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a DELTA histogram with the explicit ms bounds', async () => {
    const { ctx, promises } = makeCtx();
    client.submitDistribution(
      ctx as never,
      makeEnv(),
      makeRequest(),
      'aeci.api.query.duration_ms',
      23,
      ['endpoint:/api/products/:slug'],
    );
    await Promise.all(promises);

    const m = metric();
    expect(m.name).toBe('aeci.api.query.duration_ms');
    expect(m.unit).toBe('ms');
    expect(m.histogram.aggregationTemporality).toBe(1);
    expect(m.histogram.dataPoints[0].explicitBounds).toEqual(DURATION_BOUNDS);
    expect(m.histogram.dataPoints[0].count).toBe(1);
    expect(m.histogram.dataPoints[0].sum).toBe(23);
  });

  it('emits bounds.length + 1 bucketCounts', async () => {
    const { ctx, promises } = makeCtx();
    client.submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 23);
    await Promise.all(promises);

    const buckets = metric().histogram.dataPoints[0].bucketCounts;
    expect(buckets).toHaveLength(DURATION_BOUNDS.length + 1);
    expect(buckets.reduce((a: number, b: number) => a + b, 0)).toBe(1);
  });

  it.each([
    // [value, index of the bucket that must hold the single observation]
    [1, 0], // below the first bound
    [5, 0], // ON a bound: buckets are `prev < v <= bound`
    [23, 2], // 10 < 23 <= 25
    [1500, 10], // ON the 1.5 s p95 alert boundary
    [99999, DURATION_BOUNDS.length], // overflow bucket past the last bound
  ])('places %i ms in bucket %i', async (value, index) => {
    const { ctx, promises } = makeCtx();
    client.submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', value);
    await Promise.all(promises);

    const buckets: number[] = metric().histogram.dataPoints[0].bucketCounts;
    expect(buckets[index]).toBe(1);
    expect(buckets.filter((c) => c !== 0)).toEqual([1]);
  });

  it('swallows fetch failures without throwing', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.submitDistribution(ctx as never, makeEnv(), makeRequest(), 'aeci.metric', 1);
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('submitDistribution: forward failed', expect.any(Error));
  });
});

describe('createPosthogClient — captureEvent / captureException', () => {
  it('are no-ops when POSTHOG_PROJECT_KEY is absent', () => {
    const { ctx } = makeCtx();
    const env = makeEnv({ POSTHOG_PROJECT_KEY: undefined });
    client.captureEvent(ctx as never, env, makeRequest(), 'promote_completed');
    client.captureException(ctx as never, env, makeRequest(), new Error('x'));
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(posthogNode.constructed).not.toHaveBeenCalled();
    expect(posthogNode.capture).not.toHaveBeenCalled();
  });

  it('builds the client PER CALL with the workerd option set', () => {
    const { ctx } = makeCtx();
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'promote_completed');
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'promote_completed');

    expect(posthogNode.constructed).toHaveBeenCalledTimes(2);
    expect(posthogNode.constructed).toHaveBeenLastCalledWith('phc_test_token', {
      host: 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
      disableGeoip: true,
    });
  });

  it('captures with the shared vocabulary plus the caller properties', () => {
    const { ctx } = makeCtx();
    client.captureEvent(
      ctx as never,
      makeEnv({ ENV: 'production' }),
      makeRequest('https://www.aecintegrations.com/x'),
      'promote_completed',
      { job_id: 'job-1' },
    );

    expect(posthogNode.capture).toHaveBeenCalledWith({
      distinctId: 'aeci-test',
      event: 'promote_completed',
      properties: {
        env: 'production',
        app: 'aeci',
        service: 'aeci-test',
        worker: 'aeci-test',
        source: 'test-source',
        version: 'abc123',
        locale: 'en-US',
        host: 'www.aecintegrations.com',
        job_id: 'job-1',
      },
    });
  });

  it('defaults distinctId to the service slug and never mints a per-request id', () => {
    const { ctx } = makeCtx();
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'a');
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'b', {}, 'user-7');

    expect(posthogNode.capture.mock.calls[0]![0].distinctId).toBe('aeci-test');
    expect(posthogNode.capture.mock.calls[1]![0].distinctId).toBe('user-7');
  });

  it('flushes inside ctx.waitUntil and NEVER calls a *Immediate method', async () => {
    const { ctx, promises } = makeCtx();
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'promote_completed');

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(posthogNode.flush).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
    // `captureImmediate`/`captureExceptionImmediate` resolve before the network
    // send completes; the isolate tears down mid-flight and the event vanishes.
    expect(posthogNode.captureImmediate).not.toHaveBeenCalled();
    expect(posthogNode.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it('captureException forwards the error with the vocabulary and the default distinctId', async () => {
    const { ctx, promises } = makeCtx();
    const error = new Error('boom');
    client.captureException(ctx as never, makeEnv(), makeRequest(), error, { route: '/x' });

    expect(posthogNode.captureException).toHaveBeenCalledWith(
      error,
      'aeci-test',
      expect.objectContaining({ env: 'preview', service: 'aeci-test', route: '/x' }),
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(promises);
    expect(posthogNode.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it('swallows a flush rejection without throwing', async () => {
    posthogNode.flush.mockRejectedValueOnce(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, promises } = makeCtx();
    client.captureEvent(ctx as never, makeEnv(), makeRequest(), 'x');
    await expect(Promise.all(promises)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith('captureEvent: flush failed', expect.any(Error));
  });
});

describe('createPosthogClient — isFeatureEnabled', () => {
  it('returns the fallback without a network call when the project key is absent', async () => {
    await expect(
      client.isFeatureEnabled(
        makeEnv({ POSTHOG_PROJECT_KEY: undefined }),
        'vendor_portal_beta',
        'user-1',
        true,
      ),
    ).resolves.toBe(true);
    expect(posthogNode.constructed).not.toHaveBeenCalled();
  });

  it('returns the evaluated value', async () => {
    posthogNode.isFeatureEnabled.mockResolvedValueOnce(false);
    await expect(
      client.isFeatureEnabled(makeEnv(), 'vendor_portal_beta', 'user-1', true),
    ).resolves.toBe(false);
    expect(posthogNode.isFeatureEnabled).toHaveBeenCalledWith('vendor_portal_beta', 'user-1', {
      sendFeatureFlagEvents: false,
    });
  });

  it('falls back when the flag is unknown (undefined)', async () => {
    posthogNode.isFeatureEnabled.mockResolvedValueOnce(undefined);
    await expect(client.isFeatureEnabled(makeEnv(), 'missing', 'user-1', true)).resolves.toBe(true);
  });

  it('falls back (and warns) when evaluation throws', async () => {
    posthogNode.isFeatureEnabled.mockRejectedValueOnce(new Error('timeout'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(client.isFeatureEnabled(makeEnv(), 'flag', 'user-1', false)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('isFeatureEnabled: evaluation failed', expect.any(Error));
  });
});
