/**
 * API Worker → observability (logs + custom metrics + events).
 *
 * **This module is the call-site surface for the whole Worker.** Every route,
 * lib and cron imports `logToPosthog` / `submitCount` / `submitGauge` /
 * `submitDistribution` / `hostnameFromRequest` from here.
 *
 * It is a thin adapter over the shared transport (`@aeci/shared/posthog`),
 * configured for the API Worker: `service: 'aeci-api'`, `worker: 'aeci-api'`,
 * `source: 'worker'` (the SSR Worker's counterpart is
 * `apps/web/src/server-posthog.ts`). The transport logic — `ctx.waitUntil`
 * dispatch, swallow-on-failure, no-op without `POSTHOG_PROJECT_KEY`, the OTLP
 * intake URLs, and the tag vocabulary — lives in the shared module.
 *
 * This file used to fan out to a second vendor: AECI-642 shipped the PostHog
 * transport *beside* Datadog for a verified dual-run, and this module was the
 * only one that knew two vendors existed. AECI-651 deleted the Datadog leg, and
 * — exactly as that design predicted — it collapsed back to `export const { … }
 * = client` without a single call site changing. See ADR 0024.
 *
 * One deliberate exception to "everything imports from here": the auth layer
 * (`lib/user-auth.ts`, `lib/authz.ts`) imports `rememberPosthogDistinctId`
 * straight from `@aeci/shared/posthog` (AECI-644 / §AW3). It registers identity
 * rather than emitting telemetry, and must keep working in the dozen route
 * specs that `vi.mock('../posthog')` to silence telemetry — behind that mock it
 * would silently stop registering.
 */

import { createPosthogClient } from '@aeci/shared/posthog';

export type { PosthogLogEvent, PosthogLogLevel } from '@aeci/shared/posthog';

const client = createPosthogClient({
  service: 'aeci-api',
  worker: 'aeci-api',
  source: 'worker',
});

export const {
  /** Request `host`, the dimension operators pivot on. */
  hostnameFromRequest,
  /** Structured log → PostHog OTLP logs. */
  logToPosthog,
  /**
   * N related structured logs → ONE request (AECI-666).
   *
   * The batched sibling of {@link logToPosthog}, for a caller whose line count
   * scales with its payload — the promote's §26.5 audit forwards, one entry per
   * created/updated row. Looping the single-event helper issued one `fetch` per
   * entry, all at once into `waitUntil`; a Worker invocation may hold only a
   * bounded number of open connections, and past it the runtime cancels the
   * stalled responses into `fetch` promises that never settle. The work then
   * vanishes with no error and the invocation is killed as hung.
   */
  logBatchToPosthog,
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
