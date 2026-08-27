/**
 * API Worker → Datadog (logs + custom metrics).
 *
 * Thin adapter over the shared transport (`@aeci/shared/datadog`, AECI-112),
 * configured for the API Worker: `service: 'aeci-api'`, `ddsource: 'worker'`,
 * `worker: 'aeci-api'`. The transport logic — `ctx.waitUntil` dispatch,
 * swallow-on-failure, no-op without `DD_API_KEY`, the logs/metrics intake URLs,
 * and the `env/app/service/worker/locale` tag vocabulary — lives in the shared
 * module and is shared with the SSR Worker (`apps/web/src/server-datadog.ts`).
 */

import { createDatadogClient } from '@aeci/shared/datadog';

export type { DdLogEvent, DdLogLevel } from '@aeci/shared/datadog';

const client = createDatadogClient({
  service: 'aeci-api',
  worker: 'aeci-api',
  ddSource: 'worker',
});

export const {
  hostnameFromRequest,
  logToDatadog,
  logBatchToDatadog,
  submitDistribution,
  submitCount,
  submitGauge,
} = client;
