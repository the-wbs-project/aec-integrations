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
 * `shouldEmitRenderLog` below is web-only (the AECI-103 render-log gate) and
 * stays here — it is policy, not transport.
 */

import { createDatadogClient } from '@aeci/shared/datadog';

import type { WebEnv } from './env';

export type { DdLogEvent, DdLogLevel } from '@aeci/shared/datadog';

const client = createDatadogClient({
  service: 'aeci-web',
  worker: 'aeci-web',
  ddSource: 'worker-angular',
});

export const { hostnameFromRequest, logToDatadog, submitDistribution, submitCount } = client;

/**
 * Gate for the per-render `ssr.render` smoke-signal log (AECI-103).
 *
 * AECI-31 logged `ssr.render` on every SSR render to prove the
 * API↔Worker↔Datadog logs pipe end-to-end. At production traffic that's one
 * log line per page render — unbounded ingest volume/cost. The per-render
 * *volume* signal now lives in the bounded `aeci.ssr.render` count metric
 * (`server-runtime.ts`), so the log is demoted to a pipe-health/error smoke
 * signal:
 *
 *   - errors (`status >= 400`) are logged in every env — full fidelity; the
 *     non-cacheable branch's 404/5xx visibility leans on this,
 *   - all renders are logged in non-prod (dev volume is tiny and the full
 *     stream is useful for verifying the pipe),
 *   - prod 2xx renders are NOT logged — the count metric carries that signal.
 *
 * Deterministic by design (no sampling): the count metric, not a log sample,
 * is the bounded prod heartbeat. See docs/OBSERVABILITY.md.
 */
export function shouldEmitRenderLog(env: WebEnv, status: number): boolean {
  if (status >= 400) return true;
  return (env.ENV ?? 'development') !== 'production';
}
