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
  ADMIN_RETROACTIVE_METRIC_KEYS,
  ADMIN_SNAPSHOT_METRIC_KEYS,
  type AdminMetricKey,
  type AdminSnapshotMetricKey,
  type AdminSnapshotSource,
} from '@aeci/shared';
import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  claims,
  connectorEvidencedPairs,
  feedback,
  integrations,
  mailingList,
  metricsDaily,
  pageViews,
  products,
  profiles,
  reviews,
  vendorRequests,
  vendors,
} from '../db/schema';
import {
  countAll,
  enumerateDays,
  metricSeries,
  shiftDay,
  snapshotSeries,
  utcDayWindow,
  utcRangeWindow,
  type InternalFilterState,
  type SnapshotPoint,
  type UtcWindow,
} from './admin-analytics';
import {
  collectAnalyticsMetrics,
  humanViewsAfterAutomation,
  windowsForDay,
} from './analytics-digest';
import { OPERATOR_PAIR_LOOKBACK_DAYS } from './page-view-predicates';
import { COUNTED_REVIEW_STATUS } from './recompute-counts';
import { SWARM_PRIOR_LOOKBACK_DAYS } from './swarm-detection';

/** Error text, however the throw was shaped. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The post-automation human count for `day` (AECI-745) — the same subtraction the
 * digest's headline and `/admin/overview`'s tile perform, stored so the chart can
 * plot the filtered series.
 *
 * Written through `collectAnalyticsMetrics` + `humanViewsAfterAutomation` rather
 * than as its own `humanViews − detectSwarms(...)` expression, because an
 * open-coded subtraction here would be a third definition of the headline and the
 * whole point of AECI-745 was to get to one.
 *
 * **Throws when the detector did not run**, which `snapshotOneMetric` catches per
 * key: the row is skipped and the day stays uncovered. Storing the raw count
 * under this key would silently freeze an unfiltered figure into the long memory
 * as if it had been filtered, and unlike a live read a stored row is never
 * re-derived — that is exactly the corruption `--force` exists to prevent in the
 * backfill.
 */
export async function computeHumanViewsAfterAutomation(db: Db, day: string): Promise<number> {
  const metrics = await collectAnalyticsMetrics(db, windowsForDay(day));
  if (!metrics.automation) {
    throw new Error(`automation detector did not run for ${day}; refusing to store a raw count`);
  }
  return humanViewsAfterAutomation(metrics).day;
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
  'traffic.page_views_human_after_automation': computeHumanViewsAfterAutomation,
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
  // BOTH delivered-tier tables (AECI-721 / §13.5 site 10). This is the one
  // lockstep site that writes a TIME SERIES — `metrics_daily`, once a day, by cron
  // (AECI-581) — and therefore the only one where getting it wrong cannot be
  // repaired after the fact: a bare `count(integrations)` would write a permanent,
  // unexplained step down of 19 into recorded history on the day the migration ran.
  //
  // Summing both tables is also what makes a BACKFILL unnecessary. The migration
  // moves rows between the two tables and creates none, so under this expression
  // the series is continuous across it — there is no step to annotate and no
  // history to rewrite, which is the honest way to satisfy §13.5's "backfill or
  // annotate the series deliberately".
  'catalog.integrations_total': async (db) =>
    (await countAll(db, integrations)) + (await countAll(db, connectorEvidencedPairs)),
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
 * Upsert one `(day, metric)` row, `measured` unless told otherwise.
 *
 * Unconditional on conflict, and that IS the precedence rule: a measured write
 * always wins, so re-running the job for a day corrects it, and a same-day
 * capture always beats an approximate backfill row. The converse guard — a
 * `reconstructed` write never overwriting a `measured` row — lives in
 * `./metrics-backfill`, which is the only producer of that label.
 *
 * `source` is a parameter for exactly one caller: the AECI-827 re-check, which
 * CORRECTS an existing row rather than capturing a day and therefore passes the
 * stored row's own label back. Forcing `measured` there would relabel a
 * reconstructed row as captured — dropping the `reconstructed` flag the
 * timeseries reports per point, and locking `./metrics-backfill` out of that row
 * forever, since it may never overwrite a `measured` one. A correction changes
 * the value, never the provenance.
 */
async function upsertMetric(
  db: Db,
  day: string,
  metric: AdminSnapshotMetricKey,
  value: number,
  now: Date,
  source: AdminSnapshotSource = 'measured',
): Promise<void> {
  const computedAt = now.toISOString();
  await db
    .insert(metricsDaily)
    .values({ day, metric, value, source, computedAt })
    .onConflictDoUpdate({
      target: [metricsDaily.day, metricsDaily.metric],
      set: { value, source, computedAt },
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

// ---------------------------------------------------------------------------
// The re-check pass (AECI-827 / ADR 0027)
// ---------------------------------------------------------------------------

/**
 * Days of margin on top of the retro-join's own reach.
 *
 * The minimum correct window has **zero** slack, which is why this constant
 * exists rather than the bare arithmetic. An anchor written at `T` reaches back
 * to `T - 30d`, so the last anchor that can still move day `X` lands at
 * `(X+30)T23:59` and is seen only by the run on `X+31`. At exactly 30 days of
 * window, one missed night at that offset strands the day forever with nothing
 * to detect it — the same failure class as the defect this pass closes.
 *
 * Three days is cheap, but not free, and the difference is worth knowing before
 * anyone widens it further. `EXPLAIN QUERY PLAN` on the recompute shows the outer
 * read taking two `(is_bot, created_at)` ranges off `page_views_bot_idx` — `HUMAN`
 * leads on `is_bot`, so it is a bounded index range rather than the full scan the
 * absence of a leading-`created_at` index would otherwise force. Rows read
 * therefore scale roughly linearly with the window: ~3% more per extra day, on a
 * base of ~1,000 `page_views` rows/day. Cheap at three days; re-measure before
 * making it thirty.
 */
export const SNAPSHOT_RECHECK_SLACK_DAYS = 3;

/**
 * Above this many distinct days moved in one night, the pass writes NOTHING.
 *
 * Retro-join drift is a handful of days a month. A window-wide diff is not
 * drift — it is a predicate change, a threshold tune, an `is_bot` backfill, or
 * data loss — and rewriting a table kept forever on that evidence, unattended,
 * with no dry run, is precisely what `ops:backfill-metrics-daily` exists to
 * stop. Its `--dry-run` prints `buildValueDiffProbes`' day-by-day report and
 * `--apply` needs `--allow-production`. This pass defers to it rather than
 * racing it.
 */
export const SNAPSHOT_RECHECK_MAX_CORRECTED_DAYS = 10;

/** One `(day, metric)` the pass rewrote, with both values so the report can be
 *  read without a second query. */
export type SnapshotCorrection = {
  day: string;
  metric: AdminMetricKey;
  /** The value that was stored before this run. */
  stored: number;
  /** The value this run wrote. */
  value: number;
  /** The provenance of the row being corrected, carried so the write can put it
   *  back. A correction changes the value, never whether the day was captured or
   *  reconstructed — see {@link upsertMetric}. */
  reconstructed: boolean;
};

/** A `(day, metric)` the pass declined to rewrite, and why. Reported rather than
 *  dropped: a refusal is evidence about the data, not an absence of news. */
export type SnapshotRefusal = {
  day: string;
  metric: AdminMetricKey;
  stored: number;
  recomputed: number;
  reason: 'increase' | 'raw_rows_absent';
};

export type MetricsRecheckResult = {
  /** `skipped` = a deliberate refusal, nothing written, not a fault.
   *  `failed` = the pass could not establish its own preconditions. The two are
   *  separate because only one of them should turn the job red. */
  status: 'ok' | 'skipped' | 'failed';
  /** Inclusive window actually examined. Absent when there was none to examine. */
  window?: { fromDay: string; toDay: string; days: number };
  /** On `ok`, what this run WROTE. On `skipped`, what it would have written —
   *  reported rather than discarded, because that listing is the operator's basis
   *  for deciding whether to run the backfill. Read it against `status`, never
   *  alone; `emitMetricsRecheckMetrics` counts it only on `ok` for that reason. */
  corrections: SnapshotCorrection[];
  refusals: SnapshotRefusal[];
  /** Days in the window with no stored `traffic.page_views_human` row. Not
   *  corrected (the pass never inserts) and reported so the blind spot below is
   *  visible rather than assumed away. */
  uncoveredDays: string[];
  /** Per-key outcomes, same shape and same isolation as the primary pass. */
  metrics: SnapshotKeyOutcome[];
  /** Why nothing was written. Present on `skipped` and `failed`. */
  reason?: string;
};

/**
 * The inclusive day range to re-check on `today`, or `null` when retention
 * leaves nothing safe to examine.
 *
 * Ends at `today - 2`: `today - 1` is what the primary pass just captured, and
 * re-reading it would be a second answer to a question already answered
 * minutes ago.
 *
 * `retentionDays` clamps the far end. The shipped `page_views` window is 400
 * days so the clamp never binds today, but the per-tier env override's floor is
 * `MIN_RETENTION_DAYS` (30) — inside this window. Without the clamp, a tier
 * running a 30-day retention would recompute days whose source rows the 03:00
 * prune had already deleted, read zero, and overwrite the only surviving record
 * of them. The raw-row guard in {@link diffCorrections} catches the same shape
 * from every other cause; this catches the one cause we can predict.
 */
export function recheckWindow(today: string, retentionDays: number): UtcWindow | null {
  const toDay = shiftDay(today, -2);
  const reach = shiftDay(today, -(OPERATOR_PAIR_LOOKBACK_DAYS + 1 + SNAPSHOT_RECHECK_SLACK_DAYS));
  const retentionFloor = shiftDay(today, -retentionDays);
  // Day labels are `YYYY-MM-DD`, so lexical order IS chronological order.
  const fromDay = reach > retentionFloor ? reach : retentionFloor;
  if (fromDay > toDay) return null;
  return utcRangeWindow(fromDay, toDay);
}

/**
 * Which days in the window still have ANY `page_views` row — no predicates at
 * all, deliberately.
 *
 * This is the guard that stops the pass writing a wrong value, and it is not
 * optional. `metricSeries`' `perDay` map is **not** zero-filled: a day with no
 * matching rows simply does not appear in it. So the natural
 * `perDay.get(day) ?? 0` turns *every* cause of "the source rows are gone" —
 * a prune, an ops purge, a botched restore — into a diff of `stored → 0`, which
 * the pass would then write over the only surviving record of that day.
 *
 * `metrics-backfill.ts` refuses the same shape for the same reason, where it is
 * the `stale` arm of {@link buildValueDiffProbes}: *"a run that collapsed
 * absent-from-`src` days to 0 would erase the long memory for every day whose
 * source rows had aged out — which is the one thing this table exists to
 * prevent."*
 *
 * A genuinely quiet day is not caught by this and must not be: it has stored 0,
 * recomputes 0, produces no diff, and never reaches a write.
 *
 * **It has to be unpredicated, which makes it the pass's one table-sized read.**
 * `EXPLAIN QUERY PLAN` gives `SCAN page_views USING COVERING INDEX
 * page_views_bot_idx` — a full index scan rather than a window range, because no
 * index leads with `created_at` (§7.4 records the same fact about the prune's
 * `DELETE`). So this query's cost grows with the TABLE, not the window: ~400k
 * index entries at the 400-day retention steady state, once a night. Cheap per
 * entry and still a rounding error against D1's monthly allowance, but it is the
 * line to look at first if the pass ever needs to get cheaper.
 *
 * The tempting optimisation — derive presence from the HUMAN and BOT maps, which
 * together cover every value of `is_bot` — does not work. Both are filtered by
 * `NOT_INTERNAL`, so a day whose only rows are the operator's would read as
 * absent, and "the operator browsed alone that day" is exactly the case this
 * guard must not confuse with data loss.
 */
async function daysWithRawPageViews(db: Db, w: UtcWindow): Promise<Set<string>> {
  const rows = await db
    .select({ day: sql<string>`substr(${pageViews.createdAt}, 1, 10)` })
    .from(pageViews)
    .where(and(gte(pageViews.createdAt, w.startIso), lt(pageViews.createdAt, w.endIso)))
    .groupBy(sql`substr(${pageViews.createdAt}, 1, 10)`);
  return new Set(rows.map((r) => r.day));
}

/**
 * The pure core: recomputed vs stored, with every write rule applied.
 *
 * Kept pure and exported so the rules can be tested without a database, because
 * each one exists to prevent a different way of corrupting a table that is kept
 * forever:
 *
 *   - **Never insert.** A day with no stored row is skipped outright. Not
 *     because coverage is someone else's job, but because `findSnapshotGap`
 *     (`retention-prune.ts`) probes `selectDistinct({day})` with **no `metric`
 *     predicate** — *any* single row tells the 03:00 prune the day is captured.
 *     Inserting one traffic key for a day the primary pass never covered would
 *     clear the prune to delete that day's `page_views` while seventeen keys,
 *     including every stock, were still missing. Stocks are unrecoverable
 *     retroactively (§7.1), so that is permanent.
 *   - **Raw rows must exist** — see {@link daysWithRawPageViews}.
 *   - **Values may only fall.** The retro-join can only REMOVE rows from the
 *     admitted set, so all three keys are monotone decreasing under it. An
 *     increase therefore cannot be convergence: it is a predicate change, an
 *     `is_bot` backfill (AECI-582 class), or restored rows. Refused and
 *     reported, never written.
 */
export function diffCorrections(
  metric: AdminMetricKey,
  days: readonly string[],
  recomputed: ReadonlyMap<string, number>,
  stored: ReadonlyMap<string, SnapshotPoint>,
  present: ReadonlySet<string>,
): { corrections: SnapshotCorrection[]; refusals: SnapshotRefusal[] } {
  const corrections: SnapshotCorrection[] = [];
  const refusals: SnapshotRefusal[] = [];
  for (const day of days) {
    const captured = stored.get(day);
    if (!captured) continue;
    const value = recomputed.get(day) ?? 0;
    if (value === captured.value) continue;
    if (!present.has(day)) {
      refusals.push({
        day,
        metric,
        stored: captured.value,
        recomputed: value,
        reason: 'raw_rows_absent',
      });
      continue;
    }
    if (value > captured.value) {
      refusals.push({ day, metric, stored: captured.value, recomputed: value, reason: 'increase' });
      continue;
    }
    corrections.push({
      day,
      metric,
      stored: captured.value,
      value,
      reconstructed: captured.reconstructed,
    });
  }
  return { corrections, refusals };
}

/**
 * The days whose stored `traffic.page_views_human_after_automation` must be
 * recomputed because a day feeding its detector moved.
 *
 * `flagged(X)` is a pure function of the populations of days `[X-14, X]`:
 * `detectSwarms` reads `humanWindow` (the same `HUMAN + NOT_INTERNAL`
 * population this pass just diffed) over day `X`, plus `countPriorFlaggedDays`
 * over a window that **ends** at `X`'s start — backward-only. It imports no
 * configuration outside its own module, and `client_verdict` has exactly one
 * writer, at ingest. So a moved raw human count is the only signal that can
 * reach it from this side.
 *
 * **The blind spot, stated rather than assumed away.** A day in the window with
 * no stored `traffic.page_views_human` row cannot enter the moved set — there is
 * nothing to compare against — so a population change on it is invisible here.
 * Those days are reported as `uncoveredDays` and fixed by filling coverage with
 * `ops:backfill-metrics-daily`, which is the same tool the 03:00 prune's own
 * snapshot-gap abort points at.
 *
 * **What no automatic pass can reach**, and therefore an operational obligation
 * rather than a gap in this function: tuning `SWARM_MIN_VIEWS`,
 * `SWARM_MIN_ASN_RATIO` or the `ASN_ROTATOR_*` constants changes `flagged(X)`
 * for every stored day with **no** change to any raw count, so this set is empty
 * and the stored series silently mixes two definitions. That key is
 * `NOT_BACKFILLABLE`, so there is no repair tool at all. See
 * `POST_LAUNCH_MONITORING.md` §3.
 */
export function automationTriggerDays(
  days: readonly string[],
  movedDays: ReadonlySet<string>,
): string[] {
  const inWindow = new Set(days);
  const out = new Set<string>();
  for (const moved of movedDays) {
    for (let i = 0; i <= SWARM_PRIOR_LOOKBACK_DAYS; i += 1) {
      const affected = shiftDay(moved, i);
      if (inWindow.has(affected)) out.add(affected);
    }
  }
  return [...out].sort();
}

/** The one key with no live series, handled separately by the pass. */
const AFTER_AUTOMATION: AdminMetricKey = 'traffic.page_views_human_after_automation';

/**
 * Re-check the trailing retro-join window and correct the days that moved
 * (AECI-827 / ADR 0027).
 *
 * Runs AFTER the primary capture, and the order is load-bearing rather than
 * arbitrary: a missed *stock* sample is unrecoverable (§7.1), while everything
 * this pass touches is recomputable from `page_views` for 400 days. If a run is
 * cut short, it must be this half that is lost.
 *
 * **Correction-only.** It never inserts a row and never touches a stock — the
 * narrowed {@link AdminRetroactiveMetricKey} makes the second of those a compile
 * error rather than a convention, because re-running the primary producers for
 * an old day would stamp today's totals onto it.
 *
 * Steady-state cost is seven queries and zero writes: one grouped recompute and
 * one stored read per key, plus the raw-row probe. Verified with
 * `EXPLAIN QUERY PLAN` against local D1, because the better-sqlite3 harness cannot
 * fail on a plan regression: the outer read is two `(is_bot, created_at)` ranges on
 * `page_views_bot_idx`, and the retro-join is
 * `SEARCH op USING COVERING INDEX page_views_operator_pair_idx`. That second line
 * is the load-bearing one — without the partial index (migration `0019`) the
 * planner runs `SCAN op` once per candidate row, measured at 8 ms against 4.3 s
 * over 41k rows. **If this pass ever looks slow, check for that index first.**
 * Rows read scale with the window (~33× a single day at 33 days), which is ~0.01%
 * of D1's included monthly allowance — bounded, not free.
 *
 * Never throws. Like {@link runMetricsSnapshot}, the crash surface is the caller.
 */
export async function runMetricsSnapshotRecheck(
  db: Db,
  today: string,
  now: Date,
  opts: { retentionDays: number },
): Promise<MetricsRecheckResult> {
  const base: MetricsRecheckResult = {
    status: 'ok',
    corrections: [],
    refusals: [],
    uncoveredDays: [],
    metrics: [],
  };

  let w: UtcWindow | null;
  try {
    w = recheckWindow(today, opts.retentionDays);
  } catch (error) {
    return { ...base, status: 'failed', reason: messageOf(error) };
  }
  if (!w) {
    return {
      ...base,
      status: 'skipped',
      reason: `page_views retention (${opts.retentionDays}d) leaves no completed day safe to re-check`,
    };
  }

  const window = { fromDay: w.fromDay, toDay: w.toDay, days: w.days };
  const days = enumerateDays(w);

  // The raw-row probe is a precondition, not a metric: without it the pass
  // cannot tell "this day genuinely fell" from "this day's rows are gone", and
  // guessing is how a permanent record gets overwritten with a zero.
  let present: Set<string>;
  try {
    present = await daysWithRawPageViews(db, w);
  } catch (error) {
    return { ...base, window, status: 'failed', reason: messageOf(error) };
  }

  const corrections: SnapshotCorrection[] = [];
  const refusals: SnapshotRefusal[] = [];
  const metrics: SnapshotKeyOutcome[] = [];
  let humanStored: Map<string, SnapshotPoint> | undefined;

  for (const metric of ADMIN_RETROACTIVE_METRIC_KEYS) {
    const startedAt = Date.now();
    try {
      const { perDay } = await metricSeries(db, metric, w, UNFILTERED);
      const stored = await snapshotSeries(db, metric, w);
      if (metric === 'traffic.page_views_human') humanStored = stored;
      const diff = diffCorrections(metric, days, perDay, stored, present);
      corrections.push(...diff.corrections);
      refusals.push(...diff.refusals);
      metrics.push({ metric, status: 'written', durationMs: Date.now() - startedAt });
    } catch (error) {
      metrics.push({
        metric,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: messageOf(error),
      });
    }
  }

  const uncoveredDays = humanStored ? days.filter((day) => !humanStored.has(day)) : [];

  // The cap is on DAYS, not cells: three keys moving on one day is one day of
  // drift, and it is days that distinguish drift from a definition change.
  const movedDays = new Set(corrections.map((c) => c.day));
  if (movedDays.size > SNAPSHOT_RECHECK_MAX_CORRECTED_DAYS) {
    return {
      status: 'skipped',
      window,
      // Reported, not discarded: what WOULD have moved is the operator's whole
      // basis for deciding whether to run the backfill.
      corrections,
      refusals,
      uncoveredDays,
      metrics,
      reason:
        `${movedDays.size} days moved, above the ${SNAPSHOT_RECHECK_MAX_CORRECTED_DAYS}-day ceiling; ` +
        'wrote nothing. A window-wide diff is a definition change, not retro-join drift — ' +
        'review it with "pnpm --filter @aeci/api ops:backfill-metrics-daily" (dry-run by default).',
    };
  }

  // ─── The pair, computed before either half is written ──────────────────────
  //
  // Correcting the raw human count while leaving the filtered one stale renders
  // a filtered series ABOVE the unfiltered one on `/admin/traffic` — a defect
  // produced BY the fix. So the filtered value is computed first and the two are
  // written together or not at all: a day left consistently stale beats one left
  // inconsistently fresh.
  const humanMoved = new Set(
    corrections.filter((c) => c.metric === 'traffic.page_views_human').map((c) => c.day),
  );
  const blocked = new Set<string>();
  if (humanMoved.size > 0 && humanStored) {
    const startedAt = Date.now();
    try {
      const storedAuto = await snapshotSeries(db, AFTER_AUTOMATION, w);
      const failures: string[] = [];
      for (const day of automationTriggerDays(days, humanMoved)) {
        const captured = storedAuto.get(day);
        // Never insert — same reason as every other key.
        if (!captured) continue;
        if (!present.has(day)) {
          refusals.push({
            day,
            metric: AFTER_AUTOMATION,
            stored: captured.value,
            recomputed: 0,
            reason: 'raw_rows_absent',
          });
          if (humanMoved.has(day)) blocked.add(day);
          continue;
        }
        try {
          const value = await computeHumanViewsAfterAutomation(db, day);
          if (value !== captured.value) {
            corrections.push({
              day,
              metric: AFTER_AUTOMATION,
              stored: captured.value,
              value,
              reconstructed: captured.reconstructed,
            });
          }
        } catch (error) {
          // The detector did not run for this day. Hold the pair together.
          failures.push(`${day}: ${messageOf(error)}`);
          if (humanMoved.has(day)) blocked.add(day);
        }
      }
      metrics.push({
        metric: AFTER_AUTOMATION,
        status: failures.length === 0 ? 'written' : 'failed',
        durationMs: Date.now() - startedAt,
        ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
      });
    } catch (error) {
      metrics.push({
        metric: AFTER_AUTOMATION,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: messageOf(error),
      });
      for (const day of humanMoved) blocked.add(day);
    }
  }

  const writable = corrections.filter(
    (c) => !(blocked.has(c.day) && c.metric === 'traffic.page_views_human'),
  );

  const written: SnapshotCorrection[] = [];
  for (const c of writable) {
    try {
      await upsertMetric(
        db,
        c.day,
        c.metric,
        c.value,
        now,
        c.reconstructed ? 'reconstructed' : 'measured',
      );
      written.push(c);
    } catch (error) {
      metrics.push({
        metric: c.metric,
        status: 'failed',
        durationMs: 0,
        error: `${c.day}: ${messageOf(error)}`,
      });
    }
  }

  return { status: 'ok', window, corrections: written, refusals, uncoveredDays, metrics };
}

/**
 * Emit one re-check run's telemetry.
 *
 * A SEPARATE metric family from the primary pass's, on purpose: the two halves
 * of this cron fail for different reasons and a monitor must be able to say
 * which one broke without reading `job_runs.detail`. A quiet run still emits
 * `…recheck.run{outcome:ok}` with zero corrections, which is what makes "the
 * pass stopped correcting" distinguishable from "there was nothing to correct".
 */
export function emitMetricsRecheckMetrics(
  sink: SnapshotMetricSink,
  result: MetricsRecheckResult,
  durationMs: number,
): void {
  const base = ['trigger:cron'];
  const failed = result.metrics.filter((m) => m.status === 'failed').length;
  const outcome =
    result.status === 'ok'
      ? failed > 0
        ? 'failed'
        : 'ok'
      : (result.status as 'skipped' | 'failed');
  // Only a run that WROTE emits corrections. On a `skipped` run `corrections`
  // carries what would have moved — reported so the operator can decide whether
  // to run the backfill — and counting that as work done would overstate the
  // pass on the one night it deliberately did nothing.
  if (result.status === 'ok') {
    for (const c of result.corrections) {
      sink.count('aeci.metrics_snapshot.recheck.correction', 1, [...base, `metric:${c.metric}`]);
    }
  }
  for (const r of result.refusals) {
    sink.count('aeci.metrics_snapshot.recheck.refused', 1, [
      ...base,
      `metric:${r.metric}`,
      `reason:${r.reason}`,
    ]);
  }
  sink.count('aeci.metrics_snapshot.recheck.run', 1, [...base, `outcome:${outcome}`]);
  sink.distribution('aeci.metrics_snapshot.recheck.run.duration_ms', durationMs, base);
}

/** True when the run should count against the job's outcome (§7.2). A refusal is
 *  not a fault; a failed precondition or a failed key is. */
export function recheckFailureCount(result: MetricsRecheckResult): number {
  return (
    (result.status === 'failed' ? 1 : 0) +
    result.metrics.filter((m) => m.status === 'failed').length
  );
}

/**
 * How many `corrections` / `refusals` entries reach `job_runs.detail`.
 *
 * Bounded in the TYPE rather than left to `capDetail`, because `capDetail`
 * replaces the **entire** detail with a sentinel when it overflows — so an
 * unbounded array here would take the primary pass's twenty per-metric outcomes
 * down with it, losing the record of the half of the job that matters most.
 * The counts are always exact; only the listing is truncated.
 */
export const RECHECK_DETAIL_MAX_ENTRIES = 20;

/** The bounded projection of a re-check run that `job_runs.detail` carries. */
export type MetricsRecheckSummary = {
  status: MetricsRecheckResult['status'];
  window?: { fromDay: string; toDay: string; days: number };
  /** Exact counts, regardless of how much of the listing survived the cap. */
  corrected: number;
  refused: number;
  uncovered: number;
  failedKeys: number;
  corrections: SnapshotCorrection[];
  refusals: SnapshotRefusal[];
  reason?: string;
};

export function summarizeRecheck(result: MetricsRecheckResult): MetricsRecheckSummary {
  return {
    status: result.status,
    ...(result.window ? { window: result.window } : {}),
    corrected: result.corrections.length,
    refused: result.refusals.length,
    uncovered: result.uncoveredDays.length,
    failedKeys: result.metrics.filter((m) => m.status === 'failed').length,
    corrections: result.corrections.slice(0, RECHECK_DETAIL_MAX_ENTRIES),
    refusals: result.refusals.slice(0, RECHECK_DETAIL_MAX_ENTRIES),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
