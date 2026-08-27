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

import { discardResponseBody } from './response-drain';

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
  ENV?: 'development' | 'preview' | 'staging' | 'demo' | 'production';
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
  logBatchToDatadog(
    ctx: WaitUntilContext,
    env: DatadogEnv,
    request: Request,
    events: DdLogEvent[],
  ): void;
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

  /**
   * POST a JSON payload to a Datadog intake, dispatched via `ctx.waitUntil` so it
   * never blocks the response. BOTH failure modes are swallowed (observability
   * MUST NOT break the request path) but BOTH are surfaced to `console.warn` — so
   * a silent outage is at least visible in Cloudflare Workers Observability
   * (`wrangler tail` / the dashboard):
   *
   *   - **network/throw** → `<label>: forward failed`.
   *   - **non-2xx** (e.g. `403` invalid/mis-scoped `DD_API_KEY`, `413` payload too
   *     large, a plan/exclusion drop) → `<label>: intake rejected <status>` plus a
   *     bounded response-body snippet. This is the load-bearing case: the intake
   *     `fetch` *resolves* on a 4xx/5xx, so the throw-only `catch` never fired and
   *     a rejected key dropped every log/metric with no indication at all. Without
   *     the `res.ok` check "the secret is set but nothing reaches Datadog" is
   *     undiagnosable.
   *
   * Every path releases the response body (`discardResponseBody`). The success
   * path has nothing to read, but an unread body holds its connection open, and
   * a Worker invocation that parks too many of those gets its stalled responses
   * cancelled — into `fetch` promises that never settle (AECI-666). Since this
   * transport fires once per log line and once per metric point, it is the
   * highest-volume `fetch` caller in either Worker and the first to hit it.
   */
  function postToIntake(
    ctx: WaitUntilContext,
    apiKey: string,
    url: string,
    payload: unknown,
    label: string,
  ): void {
    ctx.waitUntil(
      (async () => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'dd-api-key': apiKey,
            },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            // Nothing to read on success — but an unread body keeps holding its
            // connection, and enough of those deadlock the invocation (AECI-666).
            discardResponseBody(res);
            return;
          }
          let snippet = '';
          try {
            snippet = (await res.text()).slice(0, 512);
          } catch {
            // Body already consumed / unreadable — the status alone still names it.
            discardResponseBody(res);
          }
          console.warn(`${label}: intake rejected ${res.status}`, snippet);
        } catch (error) {
          // Swallow — observability MUST NOT break the request path.
          console.warn(`${label}: forward failed`, error);
        }
      })(),
    );
  }

  function postMetric(ctx: WaitUntilContext, apiKey: string, url: string, payload: unknown): void {
    postToIntake(ctx, apiKey, url, payload, 'submitMetric');
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

    postToIntake(ctx, apiKey, url, payload, 'logToDatadog');
  }

  /**
   * Forward N log events in ONE request (AECI-666).
   *
   * The v2 logs intake accepts an array, so a caller with a batch of related
   * lines — the promote's §26.5 audit forwards being the motivating case, one
   * entry per created/updated row — must not loop `logToDatadog`. That issued
   * one `fetch` per entry, all dispatched simultaneously into `waitUntil`, and
   * a fat promote bundle was enough on its own to exhaust the invocation's
   * connection budget and start losing hooks silently.
   *
   * Same envelope per event as {@link logToDatadog}, same swallow-and-warn
   * failure handling, and a no-op on an empty array (never post `[]`).
   */
  function logBatchToDatadog(
    ctx: WaitUntilContext,
    env: DatadogEnv,
    request: Request,
    events: DdLogEvent[],
  ): void {
    const apiKey = env.DD_API_KEY;
    if (!apiKey || events.length === 0) return;

    const hostname = hostnameFromRequest(request);
    const ddEnv = env.ENV ?? 'development';
    const ddtags = `env:${ddEnv},app:${APP},worker:${worker},locale:${LOCALE}`;
    const payload = events.map((event) => {
      const { message, level, ...rest } = event;
      return {
        ...rest,
        message,
        status: level ?? 'info',
        service,
        hostname,
        ddsource: ddSource,
        ddtags,
      };
    });

    const site = env.DD_SITE || DEFAULT_SITE;
    postToIntake(
      ctx,
      apiKey,
      `https://http-intake.logs.${site}/api/v2/logs`,
      payload,
      'logBatchToDatadog',
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

  return {
    hostnameFromRequest,
    logToDatadog,
    logBatchToDatadog,
    submitDistribution,
    submitCount,
    submitGauge,
  };
}
