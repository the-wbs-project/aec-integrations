/**
 * Shared Worker → PostHog transport (AECI-642 / PH-1, `docs/POSTHOG_MIGRATION_SPEC.md` §AW1).
 *
 * The PostHog counterpart of `./datadog.ts`, built to the same shape so the two
 * can run side by side for the dual-run window (§3.1) and the Datadog leg can be
 * deleted one line at a time at PH-final (AECI-651). One shared factory,
 * parameterized by the only three values that differ per Worker
 * (`service`, `worker`, `source`); each Worker instantiates it in a thin adapter
 * (`apps/api/src/posthog.ts`, `apps/web/src/server-posthog.ts`).
 *
 * ## Three pipes, two mechanisms (spec §2)
 *
 *   - **events + exceptions** → `posthog-node`'s workerd export
 *     (`posthog-node/edge`), a client built per call.
 *   - **logs + metrics** → hand-rolled OTLP/HTTP JSON `POST` to
 *     `{host}/i/v1/logs` and `{host}/i/v1/metrics`. The SDK's metrics client
 *     aggregates in memory over a 10 s window, which is wrong for short-lived
 *     isolates: the isolate is gone long before the window closes. Emit per
 *     call instead.
 *
 * All three intakes authenticate with the **publishable `phc_` project token**
 * (`POSTHOG_PROJECT_KEY`), so Worker telemetry needs no secrets at all —
 * `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST` are plain per-env wrangler vars.
 *
 * ## Auth shape (verified against the live intakes 2026-08-24, project 525793)
 *
 * `POST https://us.i.posthog.com/i/v1/logs` and `.../i/v1/metrics`, with
 * `content-type: application/json` + `Authorization: Bearer <phc_ token>`, both
 * return `200 {}`. Matches PostHog's own docs (posthog.com/docs/metrics:
 * `OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer <ph_project_token>"`;
 * posthog.com/docs/logs/installation/python; the `capture-logs` service README).
 *
 * **The Bearer header is REQUIRED on the OTLP intakes** even though the token is
 * the publishable one: passing it as `?api_key=` instead returns
 * `401 {"error":"No token provided"}`. That is the opposite of the `/capture/`
 * intake, which takes the key in the JSON body and no auth header — so do not
 * generalize either convention to the other.
 *
 * If a hand-rolled capture fallback is ever needed (it should not be — the
 * `posthog-node/edge` client owns the events/exceptions pipe), the working
 * single-event endpoints are `/capture/` and `/i/v0/e/`. **`/i/v1/e/` does not
 * exist and 404s** — a silent typo that looks exactly like a config problem.
 *
 * ## Four invariants (unchanged from the Datadog transport)
 *
 *   1. Every dispatch goes through `ctx.waitUntil(...)` so it never blocks the
 *      response back to the user.
 *   2. A forwarding failure MUST NOT throw — observability outages cannot take
 *      the site down. Errors are logged to `console.warn` and swallowed.
 *   3. No `POSTHOG_PROJECT_KEY` → total no-op. Keyless local/preview is the
 *      design, not a degraded mode.
 *   4. One tag vocabulary on all pipes: `env` · `app:aeci` · `service` ·
 *      `worker` · `version` · `locale` · `host`, emitted as OTLP **resource**
 *      attributes (plus `service.name`, which is the only key the Logs
 *      explorer's service filter reads) and as event properties on the
 *      `posthog-node` pipe.
 *
 *      **One deliberate exception: `host` is NOT on the metrics pipe**
 *      (AECI-645 / §AW4). The AW4 arithmetic over the ~50-metric catalogue
 *      already sums to ≈854 point-attribute series against a 1,000-series
 *      guardrail, and `host` on the preview tier is unbounded — one Worker
 *      hostname per PR, forever. Logs and events keep it. The full reasoning is
 *      on `metricResourceAttributes` below; do not "restore consistency" here
 *      without redoing that arithmetic.
 *
 * ## pnpm trap (spec §2 — read before touching `package.json`)
 *
 * `posthog-node` must be declared in **each consuming app's** `package.json`
 * (`apps/api`, `apps/web`), not only in this package. The Angular production
 * build resolves the bare specifier from the *importing file*, so it succeeds
 * from here; the Vite dev server resolves it from the *app root*, so it fails
 * there. **A green `pnpm build` does not prove `pnpm dev` works — check both.**
 *
 * ## Host split gotcha (spec §2)
 *
 * `us.posthog.com` is the **management** API; `us.i.posthog.com` is **ingest**.
 * They are trivially easy to swap and the failure mode is a confusing 404 with
 * no mention of the host. `POSTHOG_HOST` is always the ingest host.
 */

import { PostHog } from 'posthog-node/edge';

export type PosthogLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PosthogLogEvent = {
  message: string;
  level?: PosthogLogLevel;
  [key: string]: unknown;
};

/**
 * Minimal Worker-env surface the transport reads. Both the API Worker's `Env`
 * and the SSR Worker's `WebEnv` satisfy this structurally, so the configured
 * client accepts either without a cast — which means this `ENV` union must stay
 * a superset of theirs, or every `forwardAuditLog`/`logToPosthog` call site
 * fails to typecheck. `stage2` is the TEMPORARY Stage 2 test tier (AECI-637);
 * remove it here in the same commit as the two `env.ts` unions at teardown.
 */
export type PosthogEnv = {
  /** Publishable `phc_` project token. Absent → the whole transport no-ops. */
  POSTHOG_PROJECT_KEY?: string;
  /** Ingest origin, e.g. `https://us.i.posthog.com`. NOT the management host. */
  POSTHOG_HOST?: string;
  ENV?: 'development' | 'preview' | 'staging' | 'demo' | 'production' | 'stage2';
  /** Deploy SHA (AECI-74) — rides every pipe as the `version` dimension. */
  COMMIT_SHA?: string;
};

/** Per-Worker identity — the only values that differ between the two adapters. */
export type PosthogClientConfig = {
  /** OTLP `service.name` resource attribute + `service` tag, e.g. `aeci-api`. */
  service: string;
  /** `worker` tag dimension (equals `service` today), e.g. `aeci-web`. */
  worker: string;
  /** Provenance dimension, e.g. `worker` (API) / `worker-angular` (web). */
  source: string;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

export type PosthogClient = {
  hostnameFromRequest(request: Request): string;
  logToPosthog(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    event: PosthogLogEvent,
  ): void;
  submitDistribution(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
  submitCount(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
  submitGauge(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags?: string[],
  ): void;
  captureEvent(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    event: string,
    properties?: Record<string, unknown>,
    distinctId?: string,
  ): void;
  captureException(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    error: unknown,
    properties?: Record<string, unknown>,
    distinctId?: string,
  ): void;
  isFeatureEnabled(
    env: PosthogEnv,
    key: string,
    distinctId: string,
    fallback: boolean,
  ): Promise<boolean>;
};

/** Ingest origin (NOT `us.posthog.com`, which is the management API). */
const DEFAULT_HOST = 'https://us.i.posthog.com';
const APP = 'aeci'; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = 'en-US'; // Phase 1; expand alongside LOCALES in server-runtime.ts.

/** OTLP instrumentation-scope name; constant across both Workers. */
const SCOPE_NAME = 'aeci-worker';

const LOGS_PATH = '/i/v1/logs';
const METRICS_PATH = '/i/v1/metrics';

/**
 * OTLP severity mapping (spec §2, copied verbatim). `severityNumber` is what
 * the Logs explorer filters on (`severity_number >= 13` is the saved
 * warn-and-above view); `severityText` is the human label beside it.
 */
const SEVERITY: Record<PosthogLogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: 'DEBUG' },
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
};

/** OTLP `AggregationTemporality`: 0 unspecified, 1 DELTA, 2 CUMULATIVE. */
const TEMPORALITY_DELTA = 1;

/**
 * Explicit histogram bounds for `submitDistribution`, in milliseconds
 * (spec §2, copied verbatim). Chosen to bracket the 1.5 s p95 render/query
 * alert thresholds, so the bucket boundary the alert reads is a real boundary
 * rather than an interpolation. `bucketCounts` always has `bounds.length + 1`
 * entries — one overflow bucket past the last bound.
 */
const DURATION_BUCKET_BOUNDS = [
  5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 1500, 2500, 5000, 7500, 10000,
];

type OtlpAttribute = { key: string; value: { stringValue: string } | { doubleValue: number } };

/**
 * OTLP timestamps are `fixed64` nanoseconds. Serialized as a **string** — a JS
 * number cannot hold ns-since-epoch without losing precision, and protobuf JSON
 * mandates the string form for 64-bit fixed fields.
 */
function nowUnixNano(): string {
  return `${Date.now()}000000`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Numbers → `doubleValue`, everything else → `stringValue` (spec §2).
 *
 * `doubleValue` is the **attribute-value** wrapper only. Metric *data points*
 * use `asDouble` (see `submitCount`/`submitGauge`); the two are easy to confuse
 * and the payload is rejected if they are swapped.
 */
function attributeValue(value: unknown): OtlpAttribute['value'] {
  if (typeof value === 'number' && Number.isFinite(value)) return { doubleValue: value };
  return { stringValue: stringifyValue(value) };
}

/** `undefined`/`null` entries are dropped entirely rather than sent as "null". */
function toAttributes(record: Record<string, unknown>): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    attributes.push({ key, value: attributeValue(value) });
  }
  return attributes;
}

/**
 * Splits `key:value` tag strings on the **first** colon only. Route patterns are
 * tag values and contain colons (`endpoint:/api/products/:slug`); splitting on
 * every colon would shred them into `endpoint` → `/api/products/` and lose the
 * parameter. A tag with no colon becomes a keyed attribute with an empty value.
 */
function tagsToAttributes(tags: readonly string[]): OtlpAttribute[] {
  return tags.map((tag) => {
    const separator = tag.indexOf(':');
    if (separator === -1) return { key: tag, value: { stringValue: '' } };
    return {
      key: tag.slice(0, separator),
      value: { stringValue: tag.slice(separator + 1) },
    };
  });
}

/**
 * Bucket index for one observation under {@link DURATION_BUCKET_BOUNDS}. OTLP
 * explicit-bound semantics are `bounds[i-1] < v <= bounds[i]`, with a final
 * overflow bucket for everything above the last bound — hence
 * `bounds.length + 1` counts.
 */
function bucketCountsFor(value: number): number[] {
  const counts = new Array<number>(DURATION_BUCKET_BOUNDS.length + 1).fill(0);
  const index = DURATION_BUCKET_BOUNDS.findIndex((bound) => value <= bound);
  counts[index === -1 ? DURATION_BUCKET_BOUNDS.length : index] = 1;
  return counts;
}

/**
 * Builds a Worker-tagged PostHog transport. Methods are closures over `config`
 * (no `this`), so callers may destructure / re-export them by reference.
 */
export function createPosthogClient(config: PosthogClientConfig): PosthogClient {
  const { service, worker, source } = config;

  /**
   * Derives the `host` dimension from a `Request`. Workers have no machine
   * hostname, so we use the request `host` header (e.g. `localhost:8787` in dev,
   * `www.aecintegrations.com` in production) — the dimension operators actually
   * pivot on, and the one that separates the non-prod tiers sharing project
   * 525793 (spec §3.6). Falls back to the `worker` slug if the URL is
   * unparseable, so the field is never empty.
   */
  function hostnameFromRequest(request: Request): string {
    try {
      return new URL(request.url).host || worker;
    } catch {
      return worker;
    }
  }

  /** Trailing slashes on `POSTHOG_HOST` would produce `//i/v1/logs`. */
  function ingestHost(env: PosthogEnv): string {
    return (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');
  }

  /**
   * The one tag vocabulary (invariant 4), minus `host`. Rides as OTLP
   * **resource** attributes on the logs/metrics pipes and as event properties on
   * the `posthog-node` pipe: series identity includes resource attributes, so
   * repeating this set on every data point would multiply the series count
   * against PostHog's 1,000-series guardrail (spec §3.5) for zero extra
   * information. `service.name` is mandatory and separate from `service` — the
   * Logs explorer's service filter reads only the dotted key. Everything here is
   * ×1 within a project except `version`, which is ×2 while two deploy versions
   * are live.
   */
  function baseDimensions(env: PosthogEnv): Record<string, unknown> {
    return {
      env: env.ENV ?? 'development',
      app: APP,
      service,
      worker,
      source,
      version: env.COMMIT_SHA,
      locale: LOCALE,
    };
  }

  /**
   * Log/event dimensions: the full vocabulary INCLUDING `host`.
   *
   * Logs are not a series model, so a high-cardinality hostname costs nothing
   * there and genuinely answers "which hostname served this" — the question that
   * separates the four non-prod tiers sharing project 525793 (spec §3.6) and the
   * three prod hostnames.
   */
  function logDimensions(env: PosthogEnv, request: Request): Record<string, unknown> {
    return { ...baseDimensions(env), host: hostnameFromRequest(request) };
  }

  function logResourceAttributes(env: PosthogEnv, request: Request): OtlpAttribute[] {
    return toAttributes({ 'service.name': service, ...logDimensions(env, request) });
  }

  /**
   * Metric resource attributes: the vocabulary **without `host`** — a deliberate,
   * arithmetic-backed exception to invariant 4's "one tag vocabulary on all
   * pipes" (AECI-645 / §AW4, recorded in `docs/OBSERVABILITY.md`).
   *
   * The AW4 arithmetic over the ~50-metric catalogue sums to ≈854 point-attribute
   * series — 85% of PostHog's 1,000-series-per-window guardrail before any
   * resource attribute applies — and `version` alone already doubles that to
   * ≈1,708 during a deploy overlap. `host` is what makes it unrecoverable: in the
   * non-prod project the preview tier deploys **one Worker per PR**
   * (`aeci-web-pr-123.<subdomain>.workers.dev`), so `host` is unbounded
   * cardinality that grows with every PR opened, forever. Even in production it
   * would be ×2–3 (apex, `www.`, `prod.`) for no analytical gain, because `env`
   * already identifies the tier.
   *
   * The hostname is still recoverable per request from the log side.
   */
  function metricResourceAttributes(env: PosthogEnv): OtlpAttribute[] {
    return toAttributes({ 'service.name': service, ...baseDimensions(env) });
  }

  /**
   * POST an OTLP JSON payload to a PostHog intake, dispatched via
   * `ctx.waitUntil` so it never blocks the response. BOTH failure modes are
   * swallowed (observability MUST NOT break the request path) but BOTH are
   * surfaced to `console.warn` — so a silent outage is at least visible in
   * Cloudflare Workers Observability (`wrangler tail` / the dashboard):
   *
   *   - **network/throw** → `<label>: forward failed`.
   *   - **non-2xx** (e.g. `401` wrong/rotated project token, `403` a
   *     project-quota or plan drop, `413` payload too large) →
   *     `<label>: intake rejected <status>` plus a bounded response-body
   *     snippet. This is the load-bearing case: the intake `fetch` *resolves*
   *     on a 4xx/5xx, so a throw-only `catch` never fires and a rejected key
   *     drops every log and metric with no indication at all. AECi has already
   *     lived that incident once on the Datadog transport; without the `res.ok`
   *     check "the key is set but nothing reaches PostHog" is undiagnosable.
   */
  function postToIntake(
    ctx: WaitUntilContext,
    projectKey: string,
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
              authorization: `Bearer ${projectKey}`,
            },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            let snippet = '';
            try {
              snippet = (await res.text()).slice(0, 512);
            } catch {
              // Body already consumed / unreadable — the status alone still names it.
            }
            console.warn(`${label}: intake rejected ${res.status}`, snippet);
          }
        } catch (error) {
          // Swallow — observability MUST NOT break the request path.
          console.warn(`${label}: forward failed`, error);
        }
      })(),
    );
  }

  /**
   * Wraps one OTLP metric descriptor in the resource/scope envelope.
   *
   * Takes no `Request` on purpose: the metrics pipe deliberately does NOT carry
   * `host` (see {@link metricResourceAttributes}), and dropping the parameter
   * makes that structural rather than a comment somebody can quietly undo.
   */
  function postMetric(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    projectKey: string,
    metric: Record<string, unknown>,
    label: string,
  ): void {
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: metricResourceAttributes(env) },
          scopeMetrics: [{ scope: { name: SCOPE_NAME }, metrics: [metric] }],
        },
      ],
    };
    postToIntake(ctx, projectKey, `${ingestHost(env)}${METRICS_PATH}`, payload, label);
  }

  function logToPosthog(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    event: PosthogLogEvent,
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const { message, level, ...rest } = event;
    const severity = SEVERITY[level ?? 'info'];
    const timeUnixNano = nowUnixNano();

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: logResourceAttributes(env, request) },
          scopeLogs: [
            {
              scope: { name: SCOPE_NAME },
              logRecords: [
                {
                  timeUnixNano,
                  observedTimeUnixNano: timeUnixNano,
                  severityNumber: severity.number,
                  severityText: severity.text,
                  body: { stringValue: message },
                  attributes: toAttributes(rest),
                },
              ],
            },
          ],
        },
      ],
    };

    postToIntake(ctx, projectKey, `${ingestHost(env)}${LOGS_PATH}`, payload, 'logToPosthog');
  }

  /**
   * Submit a single duration observation (e.g. a render/query duration in ms) as
   * a one-point OTLP **histogram** with explicit bounds, so percentile queries
   * (p95) resolve server-side without client-side bucketing — the PostHog
   * equivalent of a Datadog distribution point.
   */
  function submitDistribution(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags: string[] = [],
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const timeUnixNano = nowUnixNano();
    postMetric(
      ctx,
      env,
      projectKey,
      {
        name: metric,
        unit: 'ms',
        histogram: {
          aggregationTemporality: TEMPORALITY_DELTA,
          dataPoints: [
            {
              startTimeUnixNano: timeUnixNano,
              timeUnixNano,
              count: 1,
              sum: value,
              bucketCounts: bucketCountsFor(value),
              explicitBounds: DURATION_BUCKET_BOUNDS,
              // Point attributes carry ONLY the caller's tags — the shared
              // vocabulary rides as resource attributes (invariant 4).
              attributes: tagsToAttributes(tags),
            },
          ],
        },
      },
      'submitDistribution',
    );
  }

  /** Submit a count metric (a monotonic DELTA increment over the interval). */
  function submitCount(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags: string[] = [],
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const timeUnixNano = nowUnixNano();
    postMetric(
      ctx,
      env,
      projectKey,
      {
        name: metric,
        sum: {
          aggregationTemporality: TEMPORALITY_DELTA,
          isMonotonic: true,
          dataPoints: [
            {
              startTimeUnixNano: timeUnixNano,
              timeUnixNano,
              asDouble: value,
              attributes: tagsToAttributes(tags),
            },
          ],
        },
      },
      'submitCount',
    );
  }

  /**
   * Submit a gauge metric (a level, not a delta — the value as-of submission).
   * Right for periodic snapshots like the daily Algolia index-drift count
   * (`aeci.algolia.index_drift`, AECI-140) or `aeci.product_counts.drift`, where
   * each run reports the current state rather than an increment.
   *
   * OTLP's `Gauge` message has no `aggregationTemporality` field (a gauge is
   * temporality-free by definition), so unlike the sum/histogram pipes this one
   * omits it rather than sending `1`.
   */
  function submitGauge(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    metric: string,
    value: number,
    tags: string[] = [],
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const timeUnixNano = nowUnixNano();
    postMetric(
      ctx,
      env,
      projectKey,
      {
        name: metric,
        gauge: {
          dataPoints: [
            {
              startTimeUnixNano: timeUnixNano,
              timeUnixNano,
              asDouble: value,
              attributes: tagsToAttributes(tags),
            },
          ],
        },
      },
      'submitGauge',
    );
  }

  /**
   * Builds a `posthog-node` client for ONE call.
   *
   * Per-request construction is deliberate (spec §2): a module-scoped client
   * would carry a queue across isolates that may never be flushed by the isolate
   * that owns it. `flushAt: 1` + `flushInterval: 0` make every capture a single
   * immediate send; `fetchRetryCount: 0` because retry-with-backoff inside
   * `waitUntil` is the wrong trade (it extends the isolate's lifetime to chase a
   * telemetry event); `disableGeoip: true` because otherwise every server-side
   * event geo-resolves to the Worker's egress datacentre and the geography
   * breakdowns become noise.
   */
  function nodeClient(env: PosthogEnv, projectKey: string): PostHog {
    return new PostHog(projectKey, {
      host: ingestHost(env),
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
      disableGeoip: true,
    });
  }

  /**
   * Flush via `ctx.waitUntil(client.flush())` — **never** `captureImmediate` /
   * `captureExceptionImmediate`. Those resolve before the network send actually
   * completes, so the isolate tears down mid-flight and the event simply
   * vanishes; it is the single most expensive mistake available in this file
   * (spec §2, workerd gotchas). `flush()` returns the promise that settles when
   * the send finishes, which is exactly what `waitUntil` needs to keep the
   * isolate alive for.
   */
  function flushInBackground(ctx: WaitUntilContext, client: PostHog, label: string): void {
    ctx.waitUntil(
      client.flush().catch((error: unknown) => {
        // Swallow — observability MUST NOT break the request path.
        console.warn(`${label}: flush failed`, error);
      }),
    );
  }

  /**
   * Capture a product/ops event on the `posthog-node` pipe.
   *
   * `distinctId` defaults to the service slug (`aeci-api` / `aeci-web`) per
   * spec §3.10: server-side mirrors NEVER mint a per-request id, which would
   * inflate the person count by one person per request and make every
   * person-scoped insight meaningless.
   */
  function captureEvent(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    event: string,
    properties: Record<string, unknown> = {},
    distinctId?: string,
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const client = nodeClient(env, projectKey);
    client.capture({
      distinctId: distinctId ?? service,
      event,
      properties: { ...logDimensions(env, request), ...properties },
    });
    flushInBackground(ctx, client, 'captureEvent');
  }

  /** Capture a server-side exception into PostHog error tracking. */
  function captureException(
    ctx: WaitUntilContext,
    env: PosthogEnv,
    request: Request,
    error: unknown,
    properties: Record<string, unknown> = {},
    distinctId?: string,
  ): void {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return;

    const client = nodeClient(env, projectKey);
    client.captureException(error, distinctId ?? service, {
      ...logDimensions(env, request),
      ...properties,
    });
    flushInBackground(ctx, client, 'captureException');
  }

  /**
   * Server-side feature-flag evaluation (AW9 / AECI-650 consumes this).
   *
   * **This costs a network round-trip per call.** Local evaluation would need a
   * personal API key (`phx_`) or a project secret key inside the client, and
   * neither may ever become a Worker secret — a publishable-token-only telemetry
   * surface is one of the properties this migration buys (spec §2). So the round
   * trip is genuinely unavailable to optimize away, not merely unimplemented;
   * budget for it at the call site rather than reaching for `secretKey`.
   *
   * Returns `fallback` on a missing project key, an evaluation error, or an
   * `undefined` result (flag not found). `sendFeatureFlagEvents` is off because
   * there is no `ctx` here to flush a `$feature_flag_called` event with — it
   * would be enqueued and dropped.
   */
  async function isFeatureEnabled(
    env: PosthogEnv,
    key: string,
    distinctId: string,
    fallback: boolean,
  ): Promise<boolean> {
    const projectKey = env.POSTHOG_PROJECT_KEY;
    if (!projectKey) return fallback;

    try {
      const client = nodeClient(env, projectKey);
      const value = await client.isFeatureEnabled(key, distinctId, {
        sendFeatureFlagEvents: false,
      });
      return value ?? fallback;
    } catch (error) {
      // Swallow — a flag lookup failure must never break the request path.
      console.warn('isFeatureEnabled: evaluation failed', error);
      return fallback;
    }
  }

  return {
    hostnameFromRequest,
    logToPosthog,
    submitDistribution,
    submitCount,
    submitGauge,
    captureEvent,
    captureException,
    isFeatureEnabled,
  };
}
