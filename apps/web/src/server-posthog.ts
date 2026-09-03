/**
 * SSR Worker → observability (logs + custom metrics + events).
 *
 * **This module is the call-site surface for the whole SSR Worker.** The
 * runtime, the queue consumer and the server routes import `logToPosthog` /
 * `submitCount` / `submitGauge` / `submitDistribution` / `hostnameFromRequest`
 * from here.
 *
 * It is a thin adapter over the shared transport (`@aeci/shared/posthog`),
 * configured for the SSR Worker: `service: 'aeci-web'`, `worker: 'aeci-web'`,
 * `source: 'worker-angular'` (the API Worker's counterpart is
 * `apps/api/src/posthog.ts`). The transport logic — `ctx.waitUntil` dispatch,
 * swallow-on-failure, no-op without `POSTHOG_PROJECT_KEY`, the OTLP intake
 * URLs, and the tag vocabulary — lives in the shared module.
 *
 * This file used to fan out to a second vendor: AECI-642 shipped the PostHog
 * transport *beside* Datadog for a verified dual-run, and this module was the
 * only one that knew two vendors existed. AECI-651 deleted the Datadog leg, and
 * — exactly as that design predicted — it collapsed back to `export const { … }
 * = client` without a single call site changing. See ADR 0024.
 *
 * `shouldEmitRenderLog` is vendor-neutral policy and lives in
 * `./server-render-log.ts`.
 */

import { createPosthogClient } from '@aeci/shared/posthog';

export type { PosthogLogEvent, PosthogLogLevel } from '@aeci/shared/posthog';

const client = createPosthogClient({
  service: 'aeci-web',
  worker: 'aeci-web',
  source: 'worker-angular',
});

export const {
  /** Request `host`, the dimension operators pivot on. */
  hostnameFromRequest,
  /** Structured log → PostHog OTLP logs. */
  logToPosthog,
  /** Count metric → PostHog OTLP sum. */
  submitCount,
  /** Gauge metric → PostHog OTLP gauge. */
  submitGauge,
  /**
   * Duration observation → PostHog OTLP histogram with explicit ms bounds.
   * Resolves p95 server-side; never buckets client-side.
   */
  submitDistribution,
  captureEvent,
  captureException,
  isFeatureEnabled,
} = client;
