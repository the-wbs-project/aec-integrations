/**
 * The daily retention prune (AECI-584 / Phase 8.3 P3.2 — the
 * `ADMIN_PANEL_SPEC.md` §7.4 enforcer).
 *
 * A scheduled job (`../scheduled.ts`, cron `0 3 * * *`) deletes `page_views`
 * older than 400 days and `job_runs` older than 90. It is the **first scheduled
 * `DELETE` in the system's history**, which is why so much of this file is about
 * refusing to delete rather than deleting.
 *
 * ─── The one hazard that matters ─────────────────────────────────────────────
 *
 * Pruning raw `page_views` is irreversible — D1 Time Travel recovers only ~30
 * days — and `metrics_daily` (§7.1 / AECI-581) is the ONLY thing that survives
 * it. If this job outruns the 00:15 snapshot cron, that day's traffic is gone
 * permanently: no snapshot, no raw rows, nothing to recompute from. So the gate
 * below verifies a `metrics_daily` row exists for EVERY day inside the cut
 * window before deleting anything, rather than trusting that the schedule held.
 *
 * ─── Contract (§7.4, four binding rules) ─────────────────────────────────────
 *
 *   1. **Chunked deletes.** D1 bills rows *written*, and a delete is a write; a
 *      single unbounded `DELETE` over the first cut window is the wrong first
 *      run. Every statement this module emits provably touches at most
 *      {@link PRUNE_CHUNK_ROWS} rows.
 *   2. **Never prune a day the snapshot has not captured** — see
 *      {@link findSnapshotGap}. A gap aborts the WHOLE run (both tables), not
 *      just the `page_views` half: a gap means the §7.1 pipeline is unhealthy,
 *      and the right posture for a destructive job with a failed precondition is
 *      to do nothing and alert. Deferring a day of `job_runs` pruning costs ~120
 *      rows.
 *   3. **Hard exclusions.** `audit_log`, `workflow_instances` and
 *      `workflow_transitions` are governed by `STAGE_1_SPEC.md` §26.6
 *      (indefinite — and this cron is not the vehicle for changing that);
 *      `metrics_daily` is the long memory §7.1 exists to keep. {@link PRUNABLE}
 *      is the complete list of tables this module can touch, and a spec asserts
 *      the four are untouched by a real run.
 *   4. **One summary `audit_log` row per run**, in the SAME batch as the delete
 *      — `actor_type='system'`, `action='retention.pruned'`. Scheduled deletion
 *      is the explicit exception to the ADR 0022 / §13 D11 carve-out that
 *      exempts `metrics_daily` and `job_runs` bookkeeping: deletion is the one
 *      write whose fact cannot be recovered from the data afterwards. A run that
 *      deletes NOTHING writes no row — there is no fact to preserve, and 365
 *      no-op rows a year in an indefinite-retention table is a real cost.
 *
 * ─── Why a rowid cursor ──────────────────────────────────────────────────────
 *
 * `page_views` has no leading-`created_at` index — all five are
 * `(dimension, created_at)` — so a bare `DELETE … WHERE created_at < ?` is a
 * full table scan. `id` is `AUTOINCREMENT` and therefore co-monotonic with
 * `created_at`, so {@link planChunks} pages the PK instead and each statement
 * carries an explicit `id` range. Note that `created_at < cutoff` stays in every
 * DELETE: **the predicate is authoritative and the cursor is only pagination**,
 * so if that monotonicity is ever violated (clock skew, a backdated import) the
 * failure is under-deletion, never over-deletion.
 *
 * The cursor also produces the row COUNT, which is the harder half. §7.4 wants
 * `rowsDeleted` in the audit row, and neither surface can supply it: D1 does not
 * report `meta.changes` usefully for batched writes, and the test harness's
 * `db.batch` shim returns `[]` outright (`src/test/d1.ts`). Counting the ids we
 * selected is the only form of that number both surfaces agree on. A
 * `DELETE … LIMIT n` chunk would be simpler and could not answer it at all.
 *
 * Two shapes are avoided deliberately. Neither is a claim about what D1 rejects
 * — **local D1 (`wrangler d1 execute --local`) accepted `DELETE … LIMIT 1` and a
 * 150-term `IN (…)` when this was written** — they are avoided because the
 * portability is not worth relying on and neither buys anything here:
 *
 *   - **`DELETE … LIMIT`** depends on `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which
 *     is a build flag rather than standard SQLite, and it cannot report a count.
 *   - **`… WHERE id IN (?, ?, …)`** would put the chunk size into the bound
 *     parameter count, and D1's documented per-query parameter cap is well below
 *     {@link PRUNE_CHUNK_ROWS}. Every statement below binds three regardless of
 *     chunk size, so the limit is simply not reachable.
 *
 * The general hazard is real even if these two instances are not: the harness is
 * better-sqlite3, not workerd, so a divergence in SQLite build options passes
 * every spec and fails in production — see the `SQLITE_MAX_COMPOUND_SELECT = 5`
 * note in `routes/admin-system.ts` for one that actually bit.
 */

import {
  JOB_RUNS_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  PAGE_VIEWS_RETENTION_DAYS,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, gt, gte, lt, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { jobRuns, metricsDaily, pageViews } from '../db/schema';
import { shiftDay } from './admin-analytics';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';

// ---------------------------------------------------------------------------
// Configuration (§7.4: "the window lives in a config constant, not a literal")
// ---------------------------------------------------------------------------

/**
 * Rows per DELETE statement. Small enough that no single statement is a
 * surprise, large enough that a steady-state day (~1,000 `page_views`) is two
 * statements. Deliberately NOT a bound-parameter count — see the header.
 */
export const PRUNE_CHUNK_ROWS = 500;

/**
 * Per-table ceiling on chunks in one run, i.e. ≤10,000 rows/table/run. Steady
 * state is ~1,000 `page_views` + ~120 `job_runs` rows per day, so this is ~10×
 * headroom; it exists so a catch-up run (a shortened window, a cron that stopped
 * firing for a month) is spread over several nights instead of becoming one
 * enormous batch. Hitting it is reported as `truncated`, not as a failure — the
 * next run continues from where this one stopped.
 */
export const MAX_CHUNKS_PER_TABLE = 20;

/**
 * Cap on `missingDays` in the skip report. The gap that matters is *that there
 * is one*; a 400-day window with no snapshots at all would otherwise put 400
 * date strings into a `job_runs.detail` payload and a Datadog log line.
 */
const MAX_REPORTED_MISSING_DAYS = 10;

/**
 * The complete list of tables this module may delete from. Rule 3 of §7.4 in
 * executable form: `audit_log`, `workflow_instances`, `workflow_transitions` and
 * `metrics_daily` are absent, and `retention-prune.spec.ts` asserts a real run
 * leaves all four untouched.
 */
export const PRUNABLE = ['page_views', 'job_runs'] as const;
export type PrunableTable = (typeof PRUNABLE)[number];

/**
 * Resolve a retention window: the reviewed `@aeci/shared` default unless a valid
 * env override is present.
 *
 * An invalid or too-short override is IGNORED rather than clamped, and reported
 * through `onInvalid` so the operator finds out. Clamping a typo'd `4` to 30
 * would silently start deleting a year of data on the next tick; falling back to
 * 400 does nothing, which is the correct failure direction for this job.
 */
export function resolveRetentionDays(
  raw: string | undefined,
  fallbackDays: number,
  onInvalid?: (reason: string) => void,
): number {
  if (raw === undefined || raw.trim() === '') return fallbackDays;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    onInvalid?.(`"${raw}" is not a whole number of days`);
    return fallbackDays;
  }
  if (parsed < MIN_RETENTION_DAYS) {
    onInvalid?.(
      `${parsed} is below the ${MIN_RETENTION_DAYS}-day floor (D1 Time Travel's recovery horizon)`,
    );
    return fallbackDays;
  }
  return parsed;
}

/** Both windows, resolved from the two optional overrides. */
export function resolveRetentionWindows(
  env: { PAGE_VIEWS_RETENTION_DAYS?: string; JOB_RUNS_RETENTION_DAYS?: string },
  onInvalid?: (table: PrunableTable, reason: string) => void,
): Record<PrunableTable, number> {
  return {
    page_views: resolveRetentionDays(
      env.PAGE_VIEWS_RETENTION_DAYS,
      PAGE_VIEWS_RETENTION_DAYS,
      (reason) => onInvalid?.('page_views', reason),
    ),
    job_runs: resolveRetentionDays(env.JOB_RUNS_RETENTION_DAYS, JOB_RUNS_RETENTION_DAYS, (reason) =>
      onInvalid?.('job_runs', reason),
    ),
  };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface PrunedTable {
  table: PrunableTable;
  /** Exclusive ISO instant; always a UTC midnight. */
  cutoff: string;
  rowsDeleted: number;
  /** True when {@link MAX_CHUNKS_PER_TABLE} stopped the run short. */
  truncated: boolean;
}

export type RetentionPruneResult =
  | {
      status: 'pruned';
      tables: PrunedTable[];
      rowsDeleted: number;
      /** The one summary row written in the same batch, for the §26.5 forward.
       *  Absent when `rowsDeleted` is 0 — no delete, no batch, no audit row. */
      auditEntry?: AuditLogEntry;
    }
  | {
      status: 'skipped';
      reason: 'metrics_daily_gap';
      /** Inclusive day range that would have been pruned. */
      window: { fromDay: string; toDay: string };
      missingCount: number;
      /** First {@link MAX_REPORTED_MISSING_DAYS}, oldest first. */
      missingDays: string[];
      tables: PrunedTable[];
      rowsDeleted: 0;
    };

// ---------------------------------------------------------------------------
// Cutoffs and probes
// ---------------------------------------------------------------------------

/**
 * The exclusive cutoff instant for a window, snapped to a UTC midnight.
 *
 * Whole-day boundaries are load-bearing, not tidiness: they make the cut window
 * a set of COMPLETE days, so the `metrics_daily` gate can be exact (a snapshot
 * covers a whole day) and the row counts line up with the day series the panel
 * charts. A rolling `now - 400d` instant would delete a partial day whose
 * snapshot is fine but whose boundary nothing else in the system shares.
 */
export function cutoffFor(now: Date, retentionDays: number): { day: string; iso: string } {
  const day = shiftDay(now.toISOString().slice(0, 10), -retentionDays);
  return { day, iso: `${day}T00:00:00.000Z` };
}

/** The oldest surviving row's `created_at`, or null on an empty table. Reads ONE
 *  row off the PK index — this is the probe that makes the whole "deletes
 *  nothing until ~2027-07" era cost a single row read per table per night. */
async function oldestCreatedAt(db: Db, table: PrunableTable): Promise<string | null> {
  if (table === 'page_views') {
    const [row] = await db
      .select({ createdAt: pageViews.createdAt })
      .from(pageViews)
      .orderBy(asc(pageViews.id))
      .limit(1);
    return row?.createdAt ?? null;
  }
  const [row] = await db
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .orderBy(asc(jobRuns.id))
    .limit(1);
  return row?.startedAt ?? null;
}

/**
 * §7.4 rule 2. Every UTC day in `[fromDay, toDay]` that has no `metrics_daily`
 * row at all.
 *
 * **Presence of ANY row for the day counts as captured**, deliberately — not all
 * 19 keys. AECI-581's backfill zero-fills the flow series but cannot reconstruct
 * stocks (§7.1: a past total is unrecoverable), so a "all keys present" test
 * would deadlock the prune on every pre-snapshot day, forever.
 *
 * The read is a PK index seek: `metrics_daily`'s primary key leads with `day`
 * precisely to serve this probe.
 */
export async function findSnapshotGap(db: Db, fromDay: string, toDay: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ day: metricsDaily.day })
    .from(metricsDaily)
    .where(and(gte(metricsDaily.day, fromDay), lte(metricsDaily.day, toDay)));
  const captured = new Set(rows.map((r) => r.day));
  return daysBetween(fromDay, toDay).filter((day) => !captured.has(day));
}

/**
 * Every `YYYY-MM-DD` in `[fromDay, toDay]`, inclusive.
 *
 * Deliberately NOT `enumerateDays(utcRangeWindow(…))` from `./admin-analytics`:
 * that pair caps at `ADMIN_METRICS_MAX_DAYS` and throws an `ApiError` past it,
 * which is right for a request but wrong here — a cron that stopped firing for a
 * year produces a longer-than-400-day cut window, and the gate must evaluate it,
 * not crash on it.
 */
function daysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let day = fromDay; day <= toDay; day = shiftDay(day, 1)) out.push(day);
  return out;
}

// ---------------------------------------------------------------------------
// Chunk planning
// ---------------------------------------------------------------------------

interface ChunkPlan {
  statements: BatchStmt[];
  rowsDeleted: number;
  truncated: boolean;
}

/**
 * Build the DELETE statements for one table without executing anything.
 *
 * Planning and committing are separate so that every chunk across BOTH tables
 * lands in one atomic `db.batch` together with the single audit row — which is
 * how §7.4's "one summary row per run, in the same batch as the delete" survives
 * chunking at all. D1 has no interactive transactions; the batch is the only
 * atomic unit available (ADR 0016).
 *
 * Each iteration reads up to {@link PRUNE_CHUNK_ROWS} ids in PK order and emits
 * a DELETE bounded by that id range, so `rowsDeleted` is exact (counted from the
 * ids actually seen) rather than inferred from a result — D1 does not report
 * `meta.changes` reliably for batched writes, and the test harness's batch shim
 * returns `[]` outright.
 */
async function planChunks(db: Db, table: PrunableTable, cutoffIso: string): Promise<ChunkPlan> {
  const statements: BatchStmt[] = [];
  let rowsDeleted = 0;
  let cursor = 0;

  for (let chunk = 0; chunk < MAX_CHUNKS_PER_TABLE; chunk += 1) {
    const ids =
      table === 'page_views'
        ? (
            await db
              .select({ id: pageViews.id })
              .from(pageViews)
              .where(and(lt(pageViews.createdAt, cutoffIso), gt(pageViews.id, cursor)))
              .orderBy(asc(pageViews.id))
              .limit(PRUNE_CHUNK_ROWS)
          ).map((r) => r.id)
        : (
            await db
              .select({ id: jobRuns.id })
              .from(jobRuns)
              .where(and(lt(jobRuns.startedAt, cutoffIso), gt(jobRuns.id, cursor)))
              .orderBy(asc(jobRuns.id))
              .limit(PRUNE_CHUNK_ROWS)
          ).map((r) => r.id);

    if (ids.length === 0) return { statements, rowsDeleted, truncated: false };

    const lastId = ids[ids.length - 1] as number;
    // The date predicate is repeated on purpose: the id range is pagination, the
    // predicate is the authority. See the header note on monotonicity.
    statements.push(
      table === 'page_views'
        ? db
            .delete(pageViews)
            .where(
              and(
                lt(pageViews.createdAt, cutoffIso),
                gt(pageViews.id, cursor),
                lte(pageViews.id, lastId),
              ),
            )
        : db
            .delete(jobRuns)
            .where(
              and(
                lt(jobRuns.startedAt, cutoffIso),
                gt(jobRuns.id, cursor),
                lte(jobRuns.id, lastId),
              ),
            ),
    );
    rowsDeleted += ids.length;
    cursor = lastId;

    if (ids.length < PRUNE_CHUNK_ROWS) return { statements, rowsDeleted, truncated: false };
  }

  return { statements, rowsDeleted, truncated: true };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Prune both tables, or refuse to.
 *
 * Never throws for an operational reason — a snapshot gap is reported as
 * `status: 'skipped'`, not raised. A genuine D1 failure DOES propagate: the
 * caller records `outcome: 'failed'` and the batch (being atomic) has changed
 * nothing.
 */
export async function runRetentionPrune(
  db: Db,
  now: Date,
  windows: Record<PrunableTable, number>,
): Promise<RetentionPruneResult> {
  const cutoffs = {
    page_views: cutoffFor(now, windows.page_views),
    job_runs: cutoffFor(now, windows.job_runs),
  } as const;

  const oldestPageView = await oldestCreatedAt(db, 'page_views');
  const pageViewsHaveWork = oldestPageView !== null && oldestPageView < cutoffs.page_views.iso;

  // §7.4 rule 2 — evaluated BEFORE any planning, and it gates the whole run.
  if (pageViewsHaveWork) {
    const fromDay = (oldestPageView as string).slice(0, 10);
    // The last COMPLETE day the cutoff removes: the cutoff is that day's
    // midnight, so the final affected day is the one before it.
    const toDay = shiftDay(cutoffs.page_views.day, -1);
    const missing = fromDay <= toDay ? await findSnapshotGap(db, fromDay, toDay) : [];
    if (missing.length > 0) {
      return {
        status: 'skipped',
        reason: 'metrics_daily_gap',
        window: { fromDay, toDay },
        missingCount: missing.length,
        missingDays: missing.slice(0, MAX_REPORTED_MISSING_DAYS),
        // Both tables reported at zero rather than omitted, so the
        // `rows_deleted` series stays continuous and a threshold monitor can be
        // written against it. A skip is a run, not an absence.
        tables: PRUNABLE.map((table) => ({
          table,
          cutoff: cutoffs[table].iso,
          rowsDeleted: 0,
          truncated: false,
        })),
        rowsDeleted: 0,
      };
    }
  }

  const statements: BatchStmt[] = [];
  const tables: PrunedTable[] = [];

  for (const table of PRUNABLE) {
    const cutoff = cutoffs[table];
    // `page_views` already has its probe; re-probing `job_runs` is one row.
    const oldest = table === 'page_views' ? oldestPageView : await oldestCreatedAt(db, table);
    if (oldest === null || oldest >= cutoff.iso) {
      tables.push({ table, cutoff: cutoff.iso, rowsDeleted: 0, truncated: false });
      continue;
    }
    const plan = await planChunks(db, table, cutoff.iso);
    statements.push(...plan.statements);
    tables.push({
      table,
      cutoff: cutoff.iso,
      rowsDeleted: plan.rowsDeleted,
      truncated: plan.truncated,
    });
  }

  const rowsDeleted = tables.reduce((sum, t) => sum + t.rowsDeleted, 0);
  if (rowsDeleted === 0) return { status: 'pruned', tables, rowsDeleted: 0 };

  // §7.4 rule 4 / ADR 0022's exception. ONE row for the run, carrying the
  // per-table `{table, cutoff, rowsDeleted}` triples the spec names, in the SAME
  // batch as every delete — atomic on D1, so there is no window in which rows
  // are gone and the fact of their deletion is not recorded.
  const auditEntry: AuditLogEntry = {
    actorType: 'system',
    action: 'retention.pruned',
    entityType: 'retention',
    metadata: {
      rowsDeleted,
      tables: tables
        .filter((t) => t.rowsDeleted > 0)
        .map((t) => ({ table: t.table, cutoff: t.cutoff, rowsDeleted: t.rowsDeleted })),
    },
  };
  statements.push(auditInsert(db, auditEntry));

  await db.batch(statements as BatchTuple);

  return { status: 'pruned', tables, rowsDeleted, auditEntry };
}

// ---------------------------------------------------------------------------
// Observability (docs/OBSERVABILITY.md)
// ---------------------------------------------------------------------------

/** Datadog transport, narrowed to what this module emits — the same injected
 *  seam as `SnapshotMetricSink`, so this file stays free of `ctx`/`env`/`Request`. */
export type RetentionMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  distribution(metric: string, value: number, tags: string[]): void;
};

export const RETENTION_RUN_METRIC = 'aeci.retention.prune';
export const RETENTION_ROWS_METRIC = 'aeci.retention.rows_deleted';
export const RETENTION_DURATION_METRIC = 'aeci.retention.prune.duration_ms';
export const RETENTION_TRUNCATED_METRIC = 'aeci.retention.prune.truncated';

/**
 * Emit the metrics for one completed run.
 *
 * `aeci.retention.rows_deleted` is emitted for EVERY table on EVERY run,
 * including zeros: §7.4 asks for a runaway prune to be visible in Datadog before
 * it is visible as missing data, and a series that only appears when something
 * was deleted cannot be alerted on with a threshold. The always-emitted
 * `aeci.retention.prune` count doubles as the cron-liveness heartbeat.
 */
export function emitRetentionPruneMetrics(
  sink: RetentionMetricSink,
  result: RetentionPruneResult,
  durationMs: number,
): void {
  const base = ['trigger:cron'];
  for (const t of result.tables) {
    sink.count(RETENTION_ROWS_METRIC, t.rowsDeleted, [...base, `table:${t.table}`]);
    if (t.truncated) sink.count(RETENTION_TRUNCATED_METRIC, 1, [...base, `table:${t.table}`]);
  }
  sink.count(
    RETENTION_RUN_METRIC,
    1,
    result.status === 'skipped'
      ? [...base, 'outcome:skipped', `reason:${result.reason}`]
      : [...base, 'outcome:ok'],
  );
  sink.distribution(RETENTION_DURATION_METRIC, durationMs, base);
}
