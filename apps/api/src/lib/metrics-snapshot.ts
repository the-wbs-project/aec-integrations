/**
 * The daily `metrics_daily` snapshot (AECI-581 / Phase 8.3 P2.1 — the
 * `ADMIN_PANEL_SPEC.md` §7.1 producer).
 *
 * A scheduled job (`../scheduled.ts`, cron `15 0 * * *`) captures the prior
 * COMPLETE UTC day: one row per `(day, metric)` for every key in
 * `ADMIN_SNAPSHOT_METRIC_KEYS`. This module is the only writer.
 *
 * ─── Why the table exists at all ─────────────────────────────────────────────
 *
 * §4: nothing in D1 can answer "how many did we have on July 3rd". `stats_cache`
 * is overwritten by the 07:00 cron so no history survives, and `audit_log` gives
 * genuine *additions* but not net totals — 827 `integration.created` events back
 * 496 live rows, because the 2026-07-25 reset removed rows with no per-row audit.
 * A snapshot is the only honest answer, and only from the day it starts running.
 *
 * ─── Two metric families, one day label ──────────────────────────────────────
 *
 * **Flows** count events *inside* the day (page views, `*.created` events, new
 * profiles). **Stocks** are an instantaneous sample (products that exist, queue
 * depth) and have no window at all. Running 15 minutes into day D is what lets
 * both carry the label `D-1` honestly: D-1's flows are complete, and the stock
 * sample is ~15 minutes past the end of D-1 rather than the ~7 hours a 07:00 slot
 * would cost. `computed_at` records the actual sample instant either way.
 *
 * Stocks are captured even though no screen reads them yet (§5.4 / §5.5 will),
 * because a stock is unrecoverable retroactively: a day not sampled is gone.
 *
 * ─── Contract (§7.1) ─────────────────────────────────────────────────────────
 *
 *   - **Flow metrics delegate to `metricSeries`** (`./admin-analytics`), the same
 *     function `GET /api/admin/metrics/timeseries` aggregates with. That is
 *     load-bearing, not tidiness: the endpoint falls back to live aggregation for
 *     any day this job has not captured, so a second implementation here would
 *     let a chart change value at the snapshot boundary. It also inherits the
 *     `/admin`+`/account` route exclusion and the NULL-safe HUMAN/BOT predicates.
 *   - **Idempotent per `(day, metric)`** — a re-run corrects rather than
 *     duplicates, which is what makes a missed day recoverable.
 *   - **Per key, outside any batch, each inside its own try/catch** — partial
 *     failure of one metric must never abort the others. `runMetricsSnapshot`
 *     never throws; the crash surface is the caller.
 *   - **No `audit_log` row.** Derived bookkeeping, exempt from the §26.1
 *     audit-in-batch invariant under ADR 0022 / §13 D11 — and forcing these
 *     writes into a batch to carry one would destroy the isolation above.
 *     Observability is Datadog (below) plus AECI-583's `job_runs` row.
 *
 * Everything written here is `source: 'measured'`. The `'reconstructed'` label
 * belongs to the historical backfill (`./metrics-backfill`), which may never
 * overwrite a row this job wrote.
 */

import {
  ADMIN_SNAPSHOT_METRIC_KEYS,
  type AdminMetricKey,
  type AdminSnapshotMetricKey,
} from '@aeci/shared';
import { eq, isNotNull, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  claims,
  feedback,
  integrations,
  mailingList,
  metricsDaily,
  products,
  profiles,
  reviews,
  vendorRequests,
  vendors,
} from '../db/schema';
import { countAll, metricSeries, utcDayWindow, type InternalFilterState } from './admin-analytics';
import { COUNTED_REVIEW_STATUS } from './recompute-counts';

/** `promotion_status` value marking a row live — what `POST /api/promote` writes. */
const PROMOTED = 'promoted';

/**
 * The snapshot stores the UNFILTERED figure only.
 *
 * `ANALYTICS_INTERNAL_ASNS` (§13 D10) is read-time configuration, not data:
 * baking today's ASN list into a stored row would silently rot the moment the
 * list changes, and D10 constraint 2 makes the unfiltered number the canonical
 * one regardless. The endpoint therefore bypasses the snapshot entirely when the
 * filter is applied — see `routes/admin-metrics.ts`.
 */
const UNFILTERED: InternalFilterState = {
  available: false,
  applied: false,
  asns: [],
  predicate: undefined,
};

// ---------------------------------------------------------------------------
// Producers (pure; exported for unit tests). Each returns the metric's value for
// `day`. Flows delegate to the shared aggregator; stocks are `COUNT(*)` as of the
// call, using the same `countAll` the overview counts with.
// ---------------------------------------------------------------------------

/** One flow metric's value for `day`, via the endpoint's own aggregator. */
export async function computeFlowMetric(
  db: Db,
  metric: AdminMetricKey,
  day: string,
): Promise<number> {
  const { perDay } = await metricSeries(db, metric, utcDayWindow(day), UNFILTERED);
  return perDay.get(day) ?? 0;
}

/** Reviews the public surfaces count — `approved` only, matching the review APIs
 *  and the denormalized `products.review_count`. */
const APPROVED_REVIEWS = eq(reviews.status, COUNTED_REVIEW_STATUS);

/** The moderation queue's depth, defined exactly as the 06:00 moderation cron
 *  and the overview's `pending_reviews` define it. */
const PENDING_REVIEWS = eq(reviews.status, 'pending');

/** Open vendor requests, using the overview's own predicate (`status = 'open'`)
 *  rather than a wider `('open','in_review')` — the two numbers appear on the
 *  same console and must not disagree. */
const OPEN_REQUESTS = eq(vendorRequests.status, 'open');

type Producer = (db: Db, day: string) => Promise<number>;

/**
 * One producer per key, typed `Record<AdminSnapshotMetricKey, …>` so a key added
 * to the shared vocabulary without a producer (or vice versa) is a compile error.
 * `ADMIN_SNAPSHOT_METRIC_KEYS` drives the deterministic write order.
 */
const PRODUCERS: Record<AdminSnapshotMetricKey, Producer> = {
  // ── Flows ────────────────────────────────────────────────────────────────
  'traffic.page_views_human': (db, day) => computeFlowMetric(db, 'traffic.page_views_human', day),
  'traffic.page_views_bot': (db, day) => computeFlowMetric(db, 'traffic.page_views_bot', day),
  'traffic.unique_visitors': (db, day) => computeFlowMetric(db, 'traffic.unique_visitors', day),
  'catalog.products_created': (db, day) => computeFlowMetric(db, 'catalog.products_created', day),
  'catalog.integrations_created': (db, day) =>
    computeFlowMetric(db, 'catalog.integrations_created', day),
  'catalog.vendors_created': (db, day) => computeFlowMetric(db, 'catalog.vendors_created', day),
  'catalog.claims_created': (db, day) => computeFlowMetric(db, 'catalog.claims_created', day),
  'accounts.sign_ins_new': (db, day) => computeFlowMetric(db, 'accounts.sign_ins_new', day),

  // ── Stocks ───────────────────────────────────────────────────────────────
  // The `promotion_status` filter is what the key name promises. It is a no-op
  // today — all 171 products read 'promoted' (§4), which is also why the overview
  // carries `funnel_is_promoted_cohort_only` — but it is the right number the day
  // a Tier-1 retract endpoint writes 'retracted' instead of hard-deleting.
  'catalog.products_promoted': (db) =>
    countAll(db, products, eq(products.promotionStatus, PROMOTED)),
  'catalog.vendors_promoted': (db) => countAll(db, vendors, eq(vendors.promotionStatus, PROMOTED)),
  'catalog.integrations_total': (db) => countAll(db, integrations),
  'catalog.claims_total': (db) => countAll(db, claims),
  'catalog.reviews_approved': (db) => countAll(db, reviews, APPROVED_REVIEWS),
  'accounts.profiles_total': (db) => countAll(db, profiles),
  'audience.subscribers_active': (db) =>
    countAll(db, mailingList, isNull(mailingList.unsubscribedAt)),
  'audience.subscribers_unsubscribed': (db) =>
    countAll(db, mailingList, isNotNull(mailingList.unsubscribedAt)),
  'audience.feedback_total': (db) => countAll(db, feedback),
  'queue.reviews_pending': (db) => countAll(db, reviews, PENDING_REVIEWS),
  'queue.requests_open': (db) => countAll(db, vendorRequests, OPEN_REQUESTS),
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SnapshotKeyStatus = 'written' | 'failed';

export type SnapshotKeyOutcome = {
  metric: AdminSnapshotMetricKey;
  status: SnapshotKeyStatus;
  /** The value written. Absent on `failed`. */
  value?: number;
  /** Wall-clock ms for this metric's compute → upsert; the caller emits it as a
   *  Datadog distribution so one slow producer is visible inside a healthy job. */
  durationMs: number;
  /** Present on `failed` — the compute or write error message. */
  error?: string;
};

export type MetricsSnapshotResult = {
  /** The UTC day captured, `YYYY-MM-DD`. */
  day: string;
  metrics: SnapshotKeyOutcome[];
};

/**
 * Upsert one `(day, metric)` row as `measured`.
 *
 * Unconditional on conflict, and that IS the precedence rule: a measured write
 * always wins, so re-running the job for a day corrects it, and a same-day
 * capture always beats an approximate backfill row. The converse guard — a
 * `reconstructed` write never overwriting a `measured` row — lives in
 * `./metrics-backfill`, which is the only producer of that label.
 */
async function upsertMetric(
  db: Db,
  day: string,
  metric: AdminSnapshotMetricKey,
  value: number,
  now: Date,
): Promise<void> {
  const computedAt = now.toISOString();
  await db
    .insert(metricsDaily)
    .values({ day, metric, value, source: 'measured', computedAt })
    .onConflictDoUpdate({
      target: [metricsDaily.day, metricsDaily.metric],
      set: { value, source: 'measured', computedAt },
    });
}

/** Compute → upsert one metric. Never throws; a failure is reported as an
 *  outcome so the remaining metrics still write. */
async function snapshotOneMetric(
  db: Db,
  day: string,
  metric: AdminSnapshotMetricKey,
  now: Date,
): Promise<Pick<SnapshotKeyOutcome, 'status' | 'value' | 'error'>> {
  try {
    const value = await PRODUCERS[metric](db, day);
    if (!Number.isFinite(value)) {
      return { status: 'failed', error: `producer returned a non-finite value (${value})` };
    }
    await upsertMetric(db, day, metric, value, now);
    return { status: 'written', value };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Capture every metric in the vocabulary for one UTC `day`.
 *
 * Sequential and per-key isolated by design (§7.1, mirroring
 * `lib/home-stats.ts`): each metric computes and writes inside its own
 * try/catch, outside any `db.batch`, so a single failing producer is recorded
 * and the rest still land. Never throws — returns a per-metric outcome list the
 * caller turns into logs and Datadog metrics.
 */
export async function runMetricsSnapshot(
  db: Db,
  day: string,
  now: Date,
): Promise<MetricsSnapshotResult> {
  const metrics: SnapshotKeyOutcome[] = [];
  for (const metric of ADMIN_SNAPSHOT_METRIC_KEYS) {
    const startedAt = Date.now();
    const outcome = await snapshotOneMetric(db, day, metric, now);
    metrics.push({ metric, durationMs: Date.now() - startedAt, ...outcome });
  }
  return { day, metrics };
}

// ---------------------------------------------------------------------------
// Observability (docs/OBSERVABILITY.md)
// ---------------------------------------------------------------------------

/** Telemetry transport, narrowed to what this module emits. The caller binds
 *  `(ctx, env, request)` — same shape as `StatsMetricSink`. */
export type SnapshotMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  distribution(metric: string, value: number, tags: string[]): void;
};

/** Roll the per-metric outcomes up to the run-level `outcome` tag. */
function jobOutcome(result: MetricsSnapshotResult): 'ok' | 'partial' | 'failed' {
  const written = result.metrics.filter((m) => m.status === 'written').length;
  const failed = result.metrics.filter((m) => m.status === 'failed').length;
  if (failed === 0) return 'ok';
  return written > 0 ? 'partial' : 'failed';
}

/**
 * Emit the metrics for one completed snapshot run. The always-emitted
 * `aeci.metrics_snapshot.run` count is the cron-liveness signal — and stays so
 * after AECI-583's `job_runs` row: a run that never starts writes no row either,
 * so only a Datadog no-data check can catch absence. This job has no such monitor
 * yet (`PHASE_8_COMPLETION.md` §F5) and is the one where absence is permanently
 * lossy, since stock metrics for a missed day cannot be reconstructed.
 *
 * Note `partial` exists on this tag but not in `job_runs`, which records a
 * partial run as `failed` (§7.2).
 */
export function emitMetricsSnapshotMetrics(
  sink: SnapshotMetricSink,
  result: MetricsSnapshotResult,
  durationMs: number,
): void {
  const base = ['trigger:cron'];
  for (const m of result.metrics) {
    sink.count('aeci.metrics_snapshot.metric', 1, [
      ...base,
      `metric:${m.metric}`,
      `outcome:${m.status}`,
    ]);
  }
  sink.count('aeci.metrics_snapshot.run', 1, [...base, `outcome:${jobOutcome(result)}`]);
  sink.distribution('aeci.metrics_snapshot.run.duration_ms', durationMs, base);
}
