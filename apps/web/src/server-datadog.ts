/**
 * SSR Worker → Datadog (logs + custom metrics).
 *
 * Thin adapter over the shared transport (`@aeci/shared/datadog`, AECI-112),
 * configured for the SSR Worker: `service: 'aeci-web'`, `ddsource:
 * 'worker-angular'`, `worker: 'aeci-web'`. The transport logic — `ctx.waitUntil`
 * dispatch, swallow-on-failure, no-op without `DD_API_KEY`, the logs/metrics
 * intake URLs, and the `env/app/service/worker/locale` tag vocabulary — lives in
 * the shared module and is shared with the API Worker (`apps/api/src/datadog.ts`).
 *
 * **Not a call site surface any more (AECI-642).** The Worker imports its
 * telemetry from `./server-posthog.ts`, which fans out to PostHog *and* to this
 * module for the §3.1 dual-run window. This file stays a pure Datadog adapter so
 * PH-final (AECI-651) can delete it outright. `shouldEmitRenderLog` moved to
 * `./server-render-log.ts` — it is policy, not transport, and must outlive this
 * file.
 */

import { createDatadogClient } from '@aeci/shared/datadog';

export type { DdLogEvent, DdLogLevel } from '@aeci/shared/datadog';

const client = createDatadogClient({
  service: 'aeci-web',
  worker: 'aeci-web',
  ddSource: 'worker-angular',
});

export const { hostnameFromRequest, logToDatadog, submitDistribution, submitCount, submitGauge } =
  client;
