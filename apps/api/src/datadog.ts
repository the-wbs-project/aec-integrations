/**
 * API Worker → Datadog (logs + custom metrics).
 *
 * Thin adapter over the shared transport (`@aeci/shared/datadog`, AECI-112),
 * configured for the API Worker: `service: 'aeci-api'`, `ddsource: 'worker'`,
 * `worker: 'aeci-api'`. The transport logic — `ctx.waitUntil` dispatch,
 * swallow-on-failure, no-op without `DD_API_KEY`, the logs/metrics intake URLs,
 * and the `env/app/service/worker/locale` tag vocabulary — lives in the shared
 * module and is shared with the SSR Worker (`apps/web/src/server-datadog.ts`).
 *
 * **Not a call site surface any more (AECI-642).** The Worker imports its
 * telemetry from `./posthog.ts`, which fans out to PostHog *and* to this module
 * for the §3.1 dual-run window. This file stays a pure Datadog adapter so
 * PH-final (AECI-651) can delete it outright.
 */

import { createDatadogClient } from '@aeci/shared/datadog';

export type { DdLogEvent, DdLogLevel } from '@aeci/shared/datadog';

const client = createDatadogClient({
  service: 'aeci-api',
  worker: 'aeci-api',
  ddSource: 'worker',
});

export const { hostnameFromRequest, logToDatadog, submitDistribution, submitCount, submitGauge } =
  client;
