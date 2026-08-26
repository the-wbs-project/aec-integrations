/**
 * Moderation-queue health metrics (AECI-206 / Phase 5.15).
 *
 * The moderation queue is the set of `status='pending'` reviews awaiting an
 * admin approve/reject (`routes/admin-reviews.ts`). Unlike the submit/moderate
 * *action* counts (emitted inline on each request), the queue's **standing
 * state** — how deep it is and how long the oldest item has waited — has no
 * request to ride on: if nobody moderates, nothing fires. So a daily cron
 * (`scheduled.ts`, 06:00 UTC) snapshots it and this pure emitter maps the
 * snapshot to two gauges (cf. `home-stats-metrics.ts` / `algolia-sync-metrics.ts`,
 * which keep the job handler free of metric-vocabulary detail):
 *
 *   - `aeci.moderation.queue_depth` (gauge) — count of pending reviews.
 *   - `aeci.moderation.queue_oldest_age_hours` (gauge) — age in hours of the
 *     oldest pending review; **0 when the queue is empty**. The "moderation
 *     backlog" monitor alerts when this exceeds a threshold.
 *
 * Both are **gauges** (a level, not a delta) and are emitted on **every** run —
 * including an empty queue (depth 0 / age 0) — so the series always reports.
 * That makes the always-emitted point double as the cron-liveness heartbeat the
 * "not running" no-data check can watch (same always-reports pattern as the
 * Algolia index-drift gauge).
 *
 * The transport is injected as a `sink` so this stays free of `ExecutionContext`
 * / `fetch` / Datadog-key plumbing and is trivially unit-tested.
 */

/** Telemetry transport, narrowed to the gauge submitter this module needs. The
 *  caller binds `(ctx, env, request)` and forwards to the shared client's
 *  `submitGauge`. */
export type ModerationMetricSink = {
  gauge(metric: string, value: number, tags: string[]): void;
};

/** A point-in-time snapshot of the pending-review queue. */
export type ModerationQueueSnapshot = {
  /** Number of `status='pending'` reviews. */
  pendingCount: number;
  /** Age (hours) of the oldest pending review; 0 when the queue is empty. */
  oldestPendingAgeHours: number;
};

/** Emit the queue-depth + oldest-age gauges for one moderation-queue snapshot. */
export function emitModerationQueueMetrics(
  sink: ModerationMetricSink,
  snapshot: ModerationQueueSnapshot,
): void {
  sink.gauge('aeci.moderation.queue_depth', snapshot.pendingCount, []);
  sink.gauge('aeci.moderation.queue_oldest_age_hours', snapshot.oldestPendingAgeHours, []);
}

/**
 * Compute the oldest-pending age in hours from a snapshot's parts — `0` for an
 * empty queue or a missing timestamp, never negative. Pure + exported so the
 * cron's clock math is unit-tested without a DB. `now` and `oldestCreatedAt` are
 * epoch milliseconds.
 */
export function oldestPendingAgeHours(
  pendingCount: number,
  oldestCreatedAtMs: number | null,
  nowMs: number,
): number {
  if (pendingCount === 0 || oldestCreatedAtMs === null) return 0;
  return Math.max(0, (nowMs - oldestCreatedAtMs) / 3_600_000);
}
