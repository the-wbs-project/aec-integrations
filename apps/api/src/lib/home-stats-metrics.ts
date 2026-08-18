/**
 * Per-run home-stats metric emission (AECI-180 / Phase 4.5).
 *
 * A home-stats run computes the eleven `home.*` `stats_cache` keys (AECI-178) and
 * finishes with a `HomeStatsResult` — fired by the daily cron
 * (`scheduled.ts:runHomeStatsJob`, `trigger:cron`) and by a successful promote's
 * post-commit refresh (`routes/promote.ts`, `trigger:promote`, AECI-305). This is
 * the single place that maps a completed run to its Datadog signals, so those
 * callers stay free of metric-vocabulary detail and the emission is a pure,
 * fast-to-unit-test function (cf. `algolia-sync-metrics.ts`).
 *
 * The metric vocabulary (mirrors `docs/OBSERVABILITY.md`):
 *   - `aeci.stats.compute` (count, value 1) — one per run, `outcome:success`
 *     (every key written/skipped cleanly) | `partial` (some wrote, some failed) |
 *     `failed` (nothing wrote and ≥1 key failed). The 4.3 job-level signal.
 *   - `aeci.stats.compute.duration_ms` (distribution) — one per run, wall-clock of
 *     the whole compute. Enable percentile aggregations in Datadog for p50/p95/p99.
 *   - `aeci.stats.compute.key` (count, value 1) — one per key, `key` +
 *     `outcome:written|skipped|failed`. Lets a dashboard/monitor see *which* key
 *     failed without reading logs.
 *   - `aeci.stats.compute.key.duration_ms` (distribution) — one per key, `key`.
 *     Surfaces a single slow producer hiding inside a healthy job duration.
 *
 * Only a **completed** run flows through here. A caller's pre-compute crash path
 * (a throw before/inside `runHomeStats` returns) stays inline in that caller as a
 * single `aeci.stats.compute{outcome:failed}` count — it has no per-key outcomes
 * and isn't a completed run, exactly as the Algolia crash path stays inline.
 *
 * The transport is injected as a `sink` (cf. `emitAlgoliaSyncMetrics`) so this
 * stays free of `ExecutionContext` / `fetch` / Datadog-key plumbing.
 */

import type { HomeStatsResult } from './home-stats';

/** Which writer produced the run — the `trigger` tag value. `cron` is the daily
 *  compute (`scheduled.ts`); `promote` is the on-write refresh a successful
 *  `POST /api/promote` fires so the home banner doesn't lag the catalog (AECI-305).
 *  A union so a future manual/REST producer (ADR 0013) can add a value without
 *  touching the metric shape. */
export type StatsComputeTrigger = 'cron' | 'promote';

/** Datadog transport, narrowed to the two submitters this module needs. The
 *  caller binds `(ctx, env, request)` and forwards to the shared client's
 *  `submitCount` / `submitDistribution`. */
export type StatsMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  distribution(metric: string, value: number, tags: string[]): void;
};

/**
 * Roll a per-key outcome list up to the run-level `outcome` tag value.
 *
 * Exported so the §7.2 `job_runs` row derives its outcome from the SAME function
 * the Datadog tag does (AECI-583) rather than growing a second opinion of what a
 * partial run is. `job_runs.outcome` has no `'partial'` member, so the caller
 * collapses `partial → failed`: the panel must never claim more success than
 * Datadog does for the same run.
 */
export function jobOutcome(result: HomeStatsResult): 'success' | 'partial' | 'failed' {
  const written = result.keys.filter((k) => k.status === 'written').length;
  const failed = result.keys.filter((k) => k.status === 'failed').length;
  // success: every key written/skipped cleanly; partial: some wrote, some failed;
  // failed: nothing wrote and at least one key failed.
  if (failed === 0) return 'success';
  return written > 0 ? 'partial' : 'failed';
}

/**
 * Emit the metrics for one completed home-stats run: a per-key outcome count +
 * duration distribution for each key, plus a single run-level outcome count and
 * duration distribution.
 */
export function emitHomeStatsMetrics(
  sink: StatsMetricSink,
  trigger: StatsComputeTrigger,
  result: HomeStatsResult,
  durationMs: number,
): void {
  const base = [`trigger:${trigger}`];
  for (const key of result.keys) {
    const keyTags = [...base, `key:${key.key}`];
    sink.count('aeci.stats.compute.key', 1, [...keyTags, `outcome:${key.status}`]);
    sink.distribution('aeci.stats.compute.key.duration_ms', key.durationMs, keyTags);
  }
  sink.count('aeci.stats.compute', 1, [...base, `outcome:${jobOutcome(result)}`]);
  sink.distribution('aeci.stats.compute.duration_ms', durationMs, base);
}
