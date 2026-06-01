/**
 * API Worker → Datadog Logs.
 *
 * Mirror of `apps/web/src/server-datadog.ts` but tagged for the API Worker
 * (`service: 'aeci-api'`, `ddsource: 'worker'`, `hostname: 'aeci-api'`,
 * `ddtags: env:…,worker:aeci-api,…`). Two helpers live in parallel
 * intentionally per AECI-31; once Phase 2 introduces structured audit-log
 * forwarding (§26.5) and we know the real shared surface, a common helper can
 * be hoisted into `@aeci/shared`. For now duplication keeps each Worker
 * standalone and avoids premature abstraction.
 *
 * Contract (same as the SSR helper):
 *   1. `ctx.waitUntil(...)` dispatches the POST so it never blocks the
 *      response back to the user (§"never blocks responses").
 *   2. Failure to forward MUST NOT throw — swallow + `console.warn`.
 *   3. No `DD_API_KEY` → no-op (dev convenience).
 */

import type { Env } from './env';

export type DdLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DdLogEvent = {
  message: string;
  level?: DdLogLevel;
  [key: string]: unknown;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

const DEFAULT_SITE = 'us5.datadoghq.com';
const SERVICE = 'aeci-api';
const WORKER = 'aeci-api';
const APP = 'aeci'; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = 'en-US'; // Phase 1; tracks LOCALES in the SSR runtime.
const DD_SOURCE = 'worker';

/**
 * Derives the Datadog `hostname` from a `Request`. Workers have no machine
 * hostname, so we use the request `host` header (e.g. `localhost:8787` in dev,
 * `api.aeci.com` in production) — that's the dimension operators actually want
 * to pivot on. Falls back to the `WORKER` slug if the URL is unparseable, so
 * the field is never empty.
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
  env: Env,
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
        console.warn('logToDatadog: forward failed', error);
      }
    })(),
  );
}

/**
 * API Worker → Datadog custom metrics (AECI-66 / Phase 2.20).
 *
 * Mirror of `apps/web/src/server-datadog.ts`'s metric helpers, tagged for the
 * API Worker. AECI-31 only built the logs pipe; these POST to the Datadog
 * *metrics* intake (`api.{site}`, distinct from the logs `http-intake.logs`
 * host) and keep the same discipline: `ctx.waitUntil` (never blocks), swallow
 * errors, no-op without `DD_API_KEY`.
 *
 *   - `submitDistribution` → `/api/v1/distribution_points` (Datadog computes
 *     percentiles). Used for `aeci.api.query.duration_ms`.
 *   - `submitCount` → `/api/v2/series` (`type: 1`, count). Kept for parity with
 *     the SSR helper.
 */

/** v2 metric intake type enum: 0 unspecified, 1 count, 2 rate, 3 gauge. */
const DD_METRIC_TYPE_COUNT = 1;

function metricBaseTags(env: Env): string[] {
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
        console.warn('submitMetric: forward failed', error);
      }
    })(),
  );
}

/**
 * Submit a single distribution point (e.g. an API query duration in ms).
 * Datadog aggregates points so percentile queries
 * (`p95:aeci.api.query.duration_ms`) resolve server-side.
 */
export function submitDistribution(
  ctx: WaitUntilContext,
  env: Env,
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

/** Submit a count metric. Kept for parity with the SSR helper. */
export function submitCount(
  ctx: WaitUntilContext,
  env: Env,
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
