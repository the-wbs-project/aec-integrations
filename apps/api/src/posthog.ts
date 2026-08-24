/**
 * API Worker → observability (logs + custom metrics + events).
 *
 * **This module is the call-site surface for the whole Worker.** Every route,
 * lib and cron imports `logToPosthog` / `submitCount` / `submitGauge` /
 * `submitDistribution` / `hostnameFromRequest` from here — not from
 * `./datadog`, which is now only the pure Datadog adapter this module fans out
 * to (AECI-642 / `docs/POSTHOG_MIGRATION_SPEC.md` §AW1).
 *
 * ## Why the fan-out lives here rather than in `./datadog`
 *
 * §3.1 ships the PostHog transport **beside** Datadog for a 2–4 week verified
 * dual-run, so both vendors receive every log and metric. Three placements were
 * possible; this one was chosen because it makes the deletion trivial:
 *
 *   - `./datadog.ts` stays a *thin, pure* Datadog adapter (unchanged shape,
 *     unchanged tests) — nothing about the migration leaks into it.
 *   - `./posthog.ts` (this file) is the *only* module that knows two vendors
 *     exist, and it names them one line at a time.
 *   - Call sites import from here and never learn about either vendor.
 *
 * At PH-final (AECI-651) the Datadog leg dies by deleting **one line per
 * function** plus the `./datadog` import, and this file collapses back into the
 * same `export const { … } = client` shape `./datadog.ts` has today. No call
 * site changes again.
 *
 * Each leg keeps its own no-op-without-config behaviour (`DD_API_KEY` for one,
 * `POSTHOG_PROJECT_KEY` for the other) and each swallows its own failures, so a
 * vendor outage — or a missing key on one side only — cannot affect the other
 * leg or the request path.
 *
 * Worker identity is pinned here: `service: 'aeci-api'`, `worker: 'aeci-api'`,
 * `source: 'worker'` (the SSR Worker's counterpart is
 * `apps/web/src/server-posthog.ts`).
 */

import { createPosthogClient, type PosthogEnv, type PosthogLogEvent } from '@aeci/shared/posthog';

import {
  logToDatadog,
  submitCount as submitCountToDatadog,
  submitDistribution as submitDistributionToDatadog,
  submitGauge as submitGaugeToDatadog,
} from './datadog';
import type { Env } from './env';

export type { PosthogLogEvent, PosthogLogLevel } from '@aeci/shared/posthog';

/**
 * Dual-run aliases. `DdLogEvent`/`DdLogLevel` were the log-event type names
 * before the migration; they are kept pointing at the vendor-neutral types so
 * an in-flight branch importing the old names still compiles. Delete at
 * PH-final.
 */
export type {
  PosthogLogEvent as DdLogEvent,
  PosthogLogLevel as DdLogLevel,
} from '@aeci/shared/posthog';

const client = createPosthogClient({
  service: 'aeci-api',
  worker: 'aeci-api',
  source: 'worker',
});

/**
 * The env surface the fan-out reads. Deliberately structural rather than the
 * Worker's `Env`: partial env objects in tests and tooling stay callable, and
 * both legs get exactly the fields they need.
 */
type TelemetryEnv = PosthogEnv & Pick<Env, 'DD_API_KEY' | 'DD_SITE'>;

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

/** Request `host`, the dimension operators pivot on. Vendor-independent. */
export const hostnameFromRequest = client.hostnameFromRequest;

/** PostHog-only (no Datadog equivalent) — see the shared transport. */
export const captureEvent = client.captureEvent;
export const captureException = client.captureException;
export const isFeatureEnabled = client.isFeatureEnabled;

/** Structured log → PostHog OTLP logs (+ Datadog logs for the dual-run window). */
export function logToPosthog(
  ctx: WaitUntilContext,
  env: TelemetryEnv,
  request: Request,
  event: PosthogLogEvent,
): void {
  client.logToPosthog(ctx, env, request, event);
  logToDatadog(ctx, env, request, event); // DUAL-RUN: delete at PH-final (AECI-651).
}

/** Count metric → PostHog OTLP sum (+ Datadog count for the dual-run window). */
export function submitCount(
  ctx: WaitUntilContext,
  env: TelemetryEnv,
  request: Request,
  metric: string,
  value: number,
  tags: string[] = [],
): void {
  client.submitCount(ctx, env, request, metric, value, tags);
  submitCountToDatadog(ctx, env, request, metric, value, tags); // DUAL-RUN: delete at PH-final.
}

/** Gauge metric → PostHog OTLP gauge (+ Datadog gauge for the dual-run window). */
export function submitGauge(
  ctx: WaitUntilContext,
  env: TelemetryEnv,
  request: Request,
  metric: string,
  value: number,
  tags: string[] = [],
): void {
  client.submitGauge(ctx, env, request, metric, value, tags);
  submitGaugeToDatadog(ctx, env, request, metric, value, tags); // DUAL-RUN: delete at PH-final.
}

/**
 * Duration observation → PostHog OTLP histogram with explicit ms bounds
 * (+ a Datadog distribution point for the dual-run window). Both resolve p95
 * server-side; neither buckets client-side.
 */
export function submitDistribution(
  ctx: WaitUntilContext,
  env: TelemetryEnv,
  request: Request,
  metric: string,
  value: number,
  tags: string[] = [],
): void {
  client.submitDistribution(ctx, env, request, metric, value, tags);
  submitDistributionToDatadog(ctx, env, request, metric, value, tags); // DUAL-RUN: delete at PH-final.
}
