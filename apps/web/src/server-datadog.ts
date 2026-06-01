/**
 * SSR Worker → Datadog Logs.
 *
 * Posts a structured log event to the Datadog HTTP intake. AECI-31 requires
 * every entry to carry the dimensions `service`, `host`, `source`, `env`,
 * `worker`, and `locale` so we can pivot in Datadog across the Worker pair
 * without manual tagging. `service`, `hostname`, and `ddsource` are reserved
 * top-level attributes; `env`/`worker`/`locale` are emitted as `ddtags` so
 * Datadog promotes `env` to its standard environment facet. Phase 1 is
 * English-only so `locale` is hard-coded; expand alongside `LOCALES` in
 * `server-runtime.ts` when adding locales.
 *
 * Two non-negotiable behaviours:
 *
 *   1. The fetch is dispatched via `ctx.waitUntil(...)` so it never blocks the
 *      response back to the user. This is the §"never blocks responses"
 *      contract from the issue.
 *   2. Failure to forward (network down, Datadog 5xx, missing key) MUST NOT
 *      throw — observability outages cannot take the site down. Errors are
 *      logged to `console.warn` and swallowed.
 *
 * `DD_API_KEY` is the only required secret. When it is absent (local dev
 * without the secret provisioned), `logToDatadog` is a no-op — same defensive
 * pattern as `injectDatadogBootstrap`.
 */

import type { WebEnv } from './env';

export type DdLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DdLogEvent = {
  message: string;
  level?: DdLogLevel;
  [key: string]: unknown;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

const DEFAULT_SITE = 'us5.datadoghq.com';
const SERVICE = 'aeci-web';
const WORKER = 'aeci-web';
const APP = 'aeci'; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = 'en-US'; // Phase 1; revisit when LOCALES grows in server-runtime.ts.
const DD_SOURCE = 'worker-angular';

/**
 * Derives the Datadog `hostname` from a `Request`. Workers have no machine
 * hostname, so we use the request `host` header (e.g. `localhost:8788` in
 * dev, `aeci.com` in production) — that's the dimension operators actually
 * want to pivot on. Falls back to the `WORKER` slug if the URL is unparseable.
 */
export function hostnameFromRequest(request: Request): string {
  try {
    return new URL(request.url).host || WORKER;
  } catch {
    return WORKER;
  }
}

export function logToDatadog(
  ctx: WaitUntilContext,
  env: WebEnv,
  request: Request,
  event: DdLogEvent,
): void {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const ddEnv = env.ENV ?? 'development';
  const { message, level, ...rest } = event;
  const payload = {
    ...rest,
    message,
    status: level ?? 'info',
    service: SERVICE,
    hostname: hostnameFromRequest(request),
    ddsource: DD_SOURCE,
    ddtags: `env:${ddEnv},app:${APP},worker:${WORKER},locale:${LOCALE}`,
  };

  const site = env.DD_SITE || DEFAULT_SITE;
  const url = `https://http-intake.logs.${site}/api/v2/logs`;

  ctx.waitUntil(
    (async () => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'dd-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        // Swallow — observability MUST NOT break the request path.
        console.warn('logToDatadog: forward failed', error);
      }
    })(),
  );
}

/**
 * SSR Worker → Datadog custom metrics (AECI-66 / Phase 2.20).
 *
 * AECI-31 only stood up the *logs* pipe (`logToDatadog` above → the logs
 * intake). Phase 2 §14 also needs true custom metrics with percentiles, so
 * these helpers POST to the Datadog *metrics* intake. They are NOT DogStatsD —
 * Workers can't run an agent — they're direct HTTP submissions that reuse the
 * exact AECI-31 discipline:
 *
 *   1. `ctx.waitUntil(...)` so the POST never blocks the response.
 *   2. Failure to forward MUST NOT throw — swallow + `console.warn`.
 *   3. No `DD_API_KEY` → no-op (dev convenience). Metric submission
 *      authenticates with the API key alone; no app key at runtime.
 *
 * Note the host differs from the logs intake: metrics use `api.{site}`, logs
 * use `http-intake.logs.{site}`.
 *
 * Two metric shapes are supported:
 *   - `submitDistribution` → `/api/v1/distribution_points` (global distribution;
 *     Datadog computes p50/p95/p99 server-side). Used for the two duration
 *     metrics so percentiles are accurate across the fleet.
 *   - `submitCount` → `/api/v2/series` with `type: 1` (count). Used for the
 *     purge counter.
 *
 * Caller tags are appended to the shared base tags (`env`, `app`, `service`,
 * `worker`, `locale`) — the same vocabulary as the logs `ddtags` string.
 */

/** v2 metric intake type enum: 0 unspecified, 1 count, 2 rate, 3 gauge. */
const DD_METRIC_TYPE_COUNT = 1;

function metricBaseTags(env: WebEnv): string[] {
  const ddEnv = env.ENV ?? 'development';
  return [
    `env:${ddEnv}`,
    `app:${APP}`,
    `service:${SERVICE}`,
    `worker:${WORKER}`,
    `locale:${LOCALE}`,
  ];
}

function postMetric(ctx: WaitUntilContext, apiKey: string, url: string, payload: unknown): void {
  ctx.waitUntil(
    (async () => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'dd-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        // Swallow — observability MUST NOT break the request path.
        console.warn('submitMetric: forward failed', error);
      }
    })(),
  );
}

/**
 * Submit a single distribution point. `value` is the measured sample (e.g. a
 * render duration in ms); Datadog aggregates points into a distribution so
 * percentile queries (`p95:aeci.page.render.duration_ms`) work without
 * client-side bucketing.
 */
export function submitDistribution(
  ctx: WaitUntilContext,
  env: WebEnv,
  request: Request,
  metric: string,
  value: number,
  tags: string[] = [],
): void {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const site = env.DD_SITE || DEFAULT_SITE;
  const url = `https://api.${site}/api/v1/distribution_points`;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    series: [
      {
        metric,
        points: [[timestamp, [value]]],
        host: hostnameFromRequest(request),
        tags: [...metricBaseTags(env), ...tags],
      },
    ],
  };
  postMetric(ctx, apiKey, url, payload);
}

/**
 * Submit a count metric (monotonic increment over the submission interval).
 * Used for `aeci.cache.purge`, where each call records one purge event.
 */
export function submitCount(
  ctx: WaitUntilContext,
  env: WebEnv,
  request: Request,
  metric: string,
  value: number,
  tags: string[] = [],
): void {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const site = env.DD_SITE || DEFAULT_SITE;
  const url = `https://api.${site}/api/v2/series`;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    series: [
      {
        metric,
        type: DD_METRIC_TYPE_COUNT,
        points: [{ timestamp, value }],
        tags: [...metricBaseTags(env), ...tags],
        resources: [{ name: hostnameFromRequest(request), type: 'host' }],
      },
    ],
  };
  postMetric(ctx, apiKey, url, payload);
}
