/**
 * Shared Worker → Datadog transport (AECI-112).
 *
 * Hoisted from the two near-identical per-Worker helpers
 * (`apps/api/src/datadog.ts` + `apps/web/src/server-datadog.ts`). Both were
 * ~95% line-for-line equal — AECI-31 kept them separate to avoid premature
 * abstraction, but AECI-66 then added the metrics layer to *both in lockstep*,
 * the empirical signal that they change together. `createDatadogClient` is the
 * single source of transport truth, parameterized by the only three values that
 * differed (`service`, `worker`, `ddSource`); each Worker instantiates it with
 * its own constants (see the thin adapters in each app).
 *
 * Three non-negotiable behaviours (same as the originals):
 *
 *   1. Every fetch is dispatched via `ctx.waitUntil(...)` so it never blocks the
 *      response back to the user (§"never blocks responses").
 *   2. Failure to forward (network down, Datadog 5xx, missing key) MUST NOT
 *      throw — observability outages cannot take the site down. Errors are
 *      logged to `console.warn` and swallowed.
 *   3. No `DD_API_KEY` → no-op (dev convenience). Metric submission
 *      authenticates with the API key alone; no app key at runtime.
 *
 * Logs post to the logs intake (`http-intake.logs.{site}`); metrics post to the
 * metrics intake (`api.{site}`) — distinct hosts. Caller tags are appended to
 * the shared base tags (`env`, `app`, `service`, `worker`, `locale`), the same
 * vocabulary as the logs `ddtags` string. See docs/OBSERVABILITY.md §14.
 */

export type DdLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DdLogEvent = {
  message: string;
  level?: DdLogLevel;
  [key: string]: unknown;
};

/**
 * Minimal Worker-env surface the transport reads. Both the API Worker's `Env`
 * and the SSR Worker's `WebEnv` satisfy this structurally, so the configured
 * client accepts either without a cast.
 */
export type DatadogEnv = {
  DD_API_KEY?: string;
  DD_SITE?: string;
  ENV?: 'development' | 'preview' | 'staging' | 'production';
};

/** Per-Worker identity — the only values that differed between the two helpers. */
export type DatadogClientConfig = {
  /** `service` reserved attribute + `service:` metric tag, e.g. `aeci-api`. */
  service: string;
  /** `worker:` tag dimension (equals `service` today), e.g. `aeci-web`. */
  worker: string;
  /** `ddsource` reserved attribute, e.g. `worker` (API) / `worker-angular` (web). */
  ddSource: string;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

export type DatadogClient = {
  hostnameFromRequest(request: Request): string;
  logToDatadog(ctx: WaitUntilContext, env: DatadogEnv, request: Request, event: DdLogEvent): void;
  submitDistribution(
    ctx: WaitUntilContext,
    env: DatadogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
  submitCount(
    ctx: WaitUntilContext,
    env: DatadogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
  submitGauge(
    ctx: WaitUntilContext,
    env: DatadogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
};

const DEFAULT_SITE = 'us5.datadoghq.com';
const APP = 'aeci'; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = 'en-US'; // Phase 1; expand alongside LOCALES in server-runtime.ts.

/** v2 metric intake type enum: 0 unspecified, 1 count, 2 rate, 3 gauge. */
const DD_METRIC_TYPE_COUNT = 1;
const DD_METRIC_TYPE_GAUGE = 3;

/**
 * Builds a Worker-tagged Datadog transport. Methods are closures over `config`
 * (no `this`), so callers may destructure / re-export them by reference.
 */
export function createDatadogClient(config: DatadogClientConfig): DatadogClient {
  const { service, worker, ddSource } = config;

  /**
   * Derives the Datadog `hostname` from a `Request`. Workers have no machine
   * hostname, so we use the request `host` header (e.g. `localhost:8787` in dev,
   * `api.aeci.com` in production) — the dimension operators actually pivot on.
   * Falls back to the `worker` slug if the URL is unparseable, so the field is
   * never empty.
   */
  function hostnameFromRequest(request: Request): string {
    try {
      return new URL(request.url).host || worker;
    } catch {
      return worker;
    }
  }

  function metricBaseTags(env: DatadogEnv): string[] {
    const ddEnv = env.ENV ?? 'development';
    return [
      `env:${ddEnv}`,
      `app:${APP}`,
      `service:${service}`,
      `worker:${worker}`,
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

  function logToDatadog(
    ctx: WaitUntilContext,
    env: DatadogEnv,
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
      service,
      hostname: hostnameFromRequest(request),
      ddsource: ddSource,
      ddtags: `env:${ddEnv},app:${APP},worker:${worker},locale:${LOCALE}`,
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
   * Submit a single distribution point (e.g. a render/query duration in ms).
   * Datadog aggregates points so percentile queries (`p95:<metric>`) resolve
   * server-side without client-side bucketing.
   */
  function submitDistribution(
    ctx: WaitUntilContext,
    env: DatadogEnv,
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

  /** Submit a count metric (monotonic increment over the submission interval). */
  function submitCount(
    ctx: WaitUntilContext,
    env: DatadogEnv,
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

  /**
   * Submit a gauge metric (a level, not a delta — the value as-of submission).
   * Right for periodic snapshots like the daily Algolia index-drift count
   * (`aeci.algolia.index_drift`, AECI-140) or `aeci.product_counts.drift`, where
   * each run reports the current state rather than an increment.
   */
  function submitGauge(
    ctx: WaitUntilContext,
    env: DatadogEnv,
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
          type: DD_METRIC_TYPE_GAUGE,
          points: [{ timestamp, value }],
          tags: [...metricBaseTags(env), ...tags],
          resources: [{ name: hostnameFromRequest(request), type: 'host' }],
        },
      ],
    };
    postMetric(ctx, apiKey, url, payload);
  }

  return { hostnameFromRequest, logToDatadog, submitDistribution, submitCount, submitGauge };
}
