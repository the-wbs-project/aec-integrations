/**
 * Per-run Algolia-sync metric emission (AECI-141 / Phase 3.8).
 *
 * Both writers of the index — the daily cron (`scheduled.ts:runAlgoliaSync`,
 * `trigger:cron`) and the post-promote hook (`promote.ts:syncAlgoliaAfterPromote`,
 * `trigger:promote`) — finish with the same `IndexEntityResult[]` shape and want
 * the same Datadog signals. This is the single place that maps a completed run to
 * its metrics, so the two callers don't drift.
 *
 * The metric vocabulary (mirrors `docs/OBSERVABILITY.md`):
 *   - `aeci.algolia.sync` (count, value 1) — one per entity, `outcome:ok|failed`.
 *     The AECI-139 success/outcome signal, hoisted here unchanged.
 *   - `aeci.algolia.sync.records` (count, value = record count) — per entity,
 *     `op:saved|deleted`. Records pushed this run. NOTE: the value is the count of
 *     records, not 1, so dashboards/monitors must query it with `sum:`, not `count:`.
 *   - `aeci.algolia.sync.duration_ms` (distribution) — one per run, wall-clock of
 *     the push work. Enable percentile aggregations in Datadog to query p50/p95/p99.
 *
 * Only a **completed** run flows through here. The cron's early-return paths
 * (`outcome:skipped_no_creds` when creds are absent, `outcome:failed` when the
 * watermark read/write throws before any push) stay inline in the caller — they
 * are not per-entity, completed-run signals.
 *
 * The transport is injected as a `sink` (cf. AECI-140's `reportAlgoliaDrift`,
 * which injects `emitGauge`/`onDrift`) so this stays a pure, fast-to-unit-test
 * function with no `ExecutionContext` / `fetch` / Datadog-key plumbing.
 */

import type { IndexEntityResult } from './algolia-sync';

/** Which writer produced the run — the `trigger` tag value. */
export type AlgoliaSyncTrigger = 'cron' | 'promote';

/** Datadog transport, narrowed to the two submitters this module needs. The
 *  caller binds `(ctx, env, request)` and forwards to the shared client's
 *  `submitCount` / `submitDistribution`. */
export type SyncMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  distribution(metric: string, value: number, tags: string[]): void;
};

/**
 * Emit the metrics for one completed Algolia sync run: per-entity outcome and
 * records-pushed counts, plus a single run-level duration distribution.
 */
export function emitAlgoliaSyncMetrics(
  sink: SyncMetricSink,
  trigger: AlgoliaSyncTrigger,
  results: readonly IndexEntityResult[],
  durationMs: number,
): void {
  for (const result of results) {
    const base = [`trigger:${trigger}`, `entity:${result.entity}`];
    sink.count('aeci.algolia.sync', 1, [...base, `outcome:${result.ok ? 'ok' : 'failed'}`]);
    sink.count('aeci.algolia.sync.records', result.saved, [...base, 'op:saved']);
    sink.count('aeci.algolia.sync.records', result.deleted, [...base, 'op:deleted']);
  }
  sink.distribution('aeci.algolia.sync.duration_ms', durationMs, [`trigger:${trigger}`]);
}
