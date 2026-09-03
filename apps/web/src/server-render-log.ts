/**
 * SSR render-log gate (AECI-103) — policy, not transport.
 *
 * Lived in `server-datadog.ts` until AECI-642 moved it here: the rule below is
 * about *what is worth logging*, which is independent of which observability
 * vendor receives it. Keeping it in a vendor-named module meant the
 * Datadog → PostHog swap would have dragged an unrelated decision along with
 * it (and PH-final's deletion of the Datadog adapter would have deleted it).
 */

import { isPublicSite } from '@aeci/shared/deploy-env';

import type { WebEnv } from './env';

/**
 * Gate for the per-render `ssr.render` smoke-signal log (AECI-103).
 *
 * AECI-31 logged `ssr.render` on every SSR render to prove the
 * API↔Worker↔observability logs pipe end-to-end. At production traffic that's
 * one log line per page render — unbounded ingest volume/cost. The per-render
 * *volume* signal now lives in the bounded `aeci.ssr.render` count metric
 * (`server-runtime.ts`), so the log is demoted to a pipe-health/error smoke
 * signal:
 *
 *   - errors (`status >= 400`) are logged in every env — full fidelity; the
 *     non-cacheable branch's 404/5xx visibility leans on this,
 *   - all renders are logged off the public tiers (dev/preview/staging volume is
 *     tiny and the full stream is useful for verifying the pipe),
 *   - public-site (production + demo) 2xx renders are NOT logged — the count
 *     metric carries that signal at audience-traffic volume.
 *
 * Deterministic by design (no sampling): the count metric, not a log sample,
 * is the bounded public-tier heartbeat. See docs/OBSERVABILITY.md.
 */
export function shouldEmitRenderLog(env: WebEnv, status: number): boolean {
  if (status >= 400) return true;
  return !isPublicSite(env.ENV);
}
