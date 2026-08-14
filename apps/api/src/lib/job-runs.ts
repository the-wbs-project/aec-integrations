/**
 * `job_runs` bookkeeping — the §7.2 write path (AECI-583 / Phase 8.3 P3.1).
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §7.2, `docs/DATABASE_SCHEMA.md` §9.3.
 *
 * Two gaps this closes. A cron's outcome used to exist ONLY as a Datadog metric,
 * so nothing in D1 could answer "did the 08:00 Algolia sync run today"; and the
 * ten data-quality findings existed ONLY in an email — computed at 04:00, sent,
 * discarded. One row per run, carrying a per-job payload, fixes both.
 *
 * ─── No `audit_log` row (§13 D11 / ADR 0022) ──────────────────────────────────
 *
 * `job_runs` is derived, log-class, cron-internal bookkeeping and is exempt from
 * the §26.1 audit-in-batch invariant. It is also self-evidently the wrong thing
 * to audit: `job_runs` IS the observability record, so an `audit_log` row about
 * it would be auditing the audit. Written the way `stats_cache` is
 * (`lib/home-stats.ts` `upsertStat`) — plain single statements, OUTSIDE any
 * `db.batch`, each inside its own try/catch.
 *
 * Note the boundary this does NOT cross: the exemption keys on **entity class,
 * not actor class**. A cron that writes *domain* state still emits its
 * `audit_log` row in the same batch as the mutation.
 *
 * ─── Why nothing here can throw ───────────────────────────────────────────────
 *
 * A bookkeeping write must never abort, delay, or alter the job it records. So
 * every function in this module swallows its own errors: `startJobRun` returns
 * `null` on any failure and every downstream call no-ops on a `null` handle. The
 * job then runs uninstrumented, which is a strictly better failure than a
 * green-path job taken down by its own observability.
 */

import type { AdminCronJob } from '@aeci/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { jobRuns } from '../db/schema';
import type { AlgoliaIndexDrift } from './algolia-drift';
import type { EntityOrphanResult } from './algolia-orphans';
import type { IndexEntityResult } from './algolia-sync';
import type { DataQualityCheckResult } from './data-quality';
import type { EmailOutcome } from './email';
import type { HomeStatKeyOutcome } from './home-stats';
import type { MetricsSnapshotResult } from './metrics-snapshot';
import type { ReconcileResult } from './reconciliation-sweep';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The §7.2 closed set. In-flight is represented by `outcome IS NULL` alongside
 * `finished_at IS NULL`, NOT by a fourth `'running'` member — a second encoding
 * of the same state would let the two disagree, and this union assigns straight
 * into `AdminCronRunSchema.last_outcome` with no translation.
 */
export type JobRunOutcome = 'ok' | 'failed' | 'skipped';

/** What an instrumented cron handler returns instead of `void`. */
export interface JobRunReport {
  outcome: JobRunOutcome;
  detail?: JobRunDetail;
}

/**
 * A live token for one in-flight run. `null` means the entry insert did not land
 * (or there is no D1 binding), and every downstream call no-ops.
 *
 * Carrying `db` and `job` alongside the id means the caller cannot pair the wrong
 * id with the wrong client, both writes share one `first-primary` session (so the
 * read side never sees a replica-lagged half-row), and `finishJobRun` can tag its
 * own failure without the caller repeating the job id.
 */
export type JobRunHandle = { db: Db; id: number; job: AdminCronJob } | null;

/**
 * Where a bookkeeping-write outcome is reported. Injected rather than imported so
 * this module stays free of `ctx` / `env` / `Request` plumbing — the same seam
 * `SyncMetricSink` / `ModerationMetricSink` and `algolia-orphans`' `emit` use.
 */
export type JobRunSink = (event: {
  phase: 'start' | 'finish';
  job: AdminCronJob;
  outcome: 'ok' | 'failed';
  /** Present only on `outcome: 'failed'`. */
  reason?: string;
}) => void;

/**
 * The shared envelope for a run with nothing to report but a cause: a credential
 * skip (`reason: 'no_creds'`) or a crash (the error message). `outcome` already
 * classifies which of the two it is, so `reason` only has to explain. Written by
 * {@link withJobRun} on the throw path, which cannot know a per-job shape.
 */
export interface JobRunReasonDetail {
  job: AdminCronJob;
  reason: string;
}

/**
 * The 09:00 drift job measures, then heals. The halves are recorded separately so
 * a `failed` headline can still say which one failed.
 *
 * Both halves discriminate on `ran`, not on success, because for the sweep the
 * two are genuinely different facts: a sweep that completed with one index
 * erroring still produced counts worth showing. Collapsing them into a single
 * `ok` would force a completed-but-partial sweep to be reported as if it had
 * never run.
 */
export type DriftReportDetail =
  | { ran: true; drifted: AlgoliaIndexDrift[] }
  | { ran: false; reason: string };

/** The orphan sweep's per-index result, minus `orphanIds` — an unbounded id list
 *  the sweep already logs to Datadog. Counts are what §5.6 renders. */
export type OrphanSweepDetail =
  | {
      ran: true;
      /** False when any index errored. The sweep still produced counts. */
      ok: boolean;
      totalOrphans: number;
      totalDeleted: number;
      entities: OrphanSweepEntityDetail[];
    }
  | { ran: false; reason: string };

/** Project one `EntityOrphanResult` into its stored form, dropping `orphanIds`. */
export function toOrphanSweepEntity(result: EntityOrphanResult): OrphanSweepEntityDetail {
  return {
    entity: result.entity,
    indexName: result.indexName,
    indexCount: result.indexCount,
    promotedCount: result.promotedCount,
    orphans: result.orphanIds.length,
    deleted: result.deleted,
    skippedBySafetyCap: result.skippedBySafetyCap,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
  };
}

export interface OrphanSweepEntityDetail {
  entity: string;
  indexName: string;
  indexCount: number;
  promotedCount: number;
  /** Objects in the index with no promoted D1 row (`index − D1`). */
  orphans: number;
  /** Actually removed — 0 when the safety cap refused, or on a delete error. */
  deleted: number;
  skippedBySafetyCap: boolean;
  ok: boolean;
  error?: string;
}

/** The analytics digest's numbers, projected. Deliberately NOT the whole
 *  `AnalyticsMetrics`: `botActivity` is every crawler active in the day, i.e.
 *  unbounded, and the rendered `html`/`text` are large and re-derivable. */
export interface AnalyticsDigestSummary {
  pageViewsHuman: number;
  pageViewsBot: number;
  newUsers: number;
  totalUsers: number;
  pendingModeration: number;
}

/**
 * The per-job `detail` payload, discriminated on the `AdminCronJob` id — the same
 * value the row's `job` column carries, repeated inside the JSON so a payload
 * read on its own (a `wrangler d1` query, a future export) is self-describing and
 * narrows without correlating two fields.
 *
 * Two families: {@link JobRunReasonDetail} for a skip or a crash, and the eight
 * fully-populated report shapes below. Payloads stay SMALL — no rendered emails,
 * no unbounded arrays; Datadog already carries the fine-grained breakdowns.
 */
export type JobRunDetail =
  | JobRunReasonDetail
  | { job: 'algolia-sync'; durationMs: number; cutoff: string; entities: IndexEntityResult[] }
  | { job: 'algolia-drift'; report: DriftReportDetail; sweep: OrphanSweepDetail }
  | {
      job: 'home-stats';
      durationMs: number;
      written: number;
      failed: number;
      skipped: number;
      keys: HomeStatKeyOutcome[];
    }
  | {
      job: 'metrics-snapshot';
      day: string;
      durationMs: number;
      written: number;
      failed: number;
      metrics: MetricsSnapshotResult['metrics'];
    }
  | { job: 'moderation-snapshot'; pendingCount: number; oldestPendingAgeHours: number }
  | ({ job: 'request-reconcile' } & ReconcileResult)
  | {
      job: 'data-quality';
      durationMs: number;
      checks: DataQualityCheckResult[];
      email: EmailOutcome;
    }
  | {
      job: 'analytics-digest';
      dayLabel: string;
      email: EmailOutcome;
      recipients: number;
      metrics: AnalyticsDigestSummary;
    }
  | {
      job: 'waf-poll';
      window: { startIso: string; endIso: string; host: string };
      groups: number;
      events: number;
      truncated: boolean;
    }
  | {
      job: 'retention-prune';
      durationMs: number;
      rowsDeleted: number;
      /** One entry per prunable table, ALWAYS both, zeros included — "the prune
       *  ran and removed nothing" and "the prune did not consider this table"
       *  are different facts and this row has to distinguish them. */
      tables: RetentionPrunedTableDetail[];
    }
  /** The §7.4 refusal: a day inside the cut window had no `metrics_daily` row,
   *  so NOTHING was deleted from either table. Distinct from the shape above
   *  because the operator's next question is "which days", and answering it from
   *  a bare `reason` string is not possible. `missingDays` is capped. */
  | {
      job: 'retention-prune';
      reason: 'metrics_daily_gap';
      window: { fromDay: string; toDay: string };
      missingCount: number;
      missingDays: string[];
    };

/** The per-table half of the retention prune's detail. Mirrors `PrunedTable`
 *  (`./retention-prune`) minus nothing — it is small and fully bounded. */
export interface RetentionPrunedTableDetail {
  table: string;
  cutoff: string;
  rowsDeleted: number;
  truncated: boolean;
}

/**
 * Defensive ceiling on the serialized payload. Nothing today comes close — the
 * data-quality set is the largest at ~6-8 KB (ten checks × `SAMPLE_LIMIT` 10
 * sample lines) — but `detail` is the one field a future job could make
 * unbounded, and a 1 MB row is a D1 failure rather than a large row.
 */
export const DETAIL_MAX_BYTES = 64 * 1024;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize-check the payload, substituting a sentinel when it is too large or
 * not JSON-representable. Returning a *replacement* rather than dropping the
 * detail entirely keeps the row's `job` discriminator readable, so the read side
 * still narrows and can say why the payload is missing.
 */
function capDetail(detail: JobRunDetail | undefined, job: AdminCronJob): JobRunDetail | null {
  if (detail === undefined) return null;
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(detail)).length;
  } catch (error) {
    return { job, reason: `detail not serializable: ${reasonOf(error)}` };
  }
  if (bytes > DETAIL_MAX_BYTES) {
    return { job, reason: `detail truncated (${bytes} bytes exceeds ${DETAIL_MAX_BYTES})` };
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Insert the ENTRY row and return a handle.
 *
 * The caller awaits this BEFORE the job starts, which is the whole reason a
 * crashed or timed-out run is detectable: the row is already durable with
 * `finished_at NULL` if the isolate never comes back.
 *
 * Never throws and never rejects — on any failure it reports to the sink and
 * returns `null`. `db` is nullable so a missing D1 binding degrades to "no row"
 * instead of taking down a job that needs no database at all (the WAF poll, and
 * the Algolia halves of the drift job).
 */
export async function startJobRun(
  db: Db | null,
  job: AdminCronJob,
  startedAt: Date,
  sink?: JobRunSink,
): Promise<JobRunHandle> {
  if (!db) return null;
  try {
    // Plain single-statement insert, NOT `db.batch` — there is no audit row to
    // pair it with (ADR 0022), and `.returning()` inside a batch is unrecoverable
    // anyway: the test harness's batch shim returns `[]` (`src/test/d1.ts`), so a
    // future "batch the two writes" refactor would silently break id recovery
    // while passing every spec. RETURNING on a plain insert is already in
    // production use here (`routes/landing-forms.ts`, `routes/auth-profile.ts`)
    // and is supported by better-sqlite3, so the specs exercise the real path.
    const rows = await db
      .insert(jobRuns)
      .values({ job, startedAt: startedAt.toISOString() })
      .returning({ id: jobRuns.id });
    const id = rows[0]?.id;
    if (typeof id !== 'number') {
      sink?.({ phase: 'start', job, outcome: 'failed', reason: 'insert returned no id' });
      return null;
    }
    sink?.({ phase: 'start', job, outcome: 'ok' });
    return { db, id, job };
  } catch (error) {
    sink?.({ phase: 'start', job, outcome: 'failed', reason: reasonOf(error) });
    return null;
  }
}

/**
 * Complete the row. No-ops on a `null` handle. Never throws.
 *
 * The caller AWAITS this — never `ctx.waitUntil`. On the queue path
 * `message.ack()` fires the instant the job returns and the isolate becomes
 * eligible for reclamation, so a deferred finish write races the ack and can be
 * dropped, leaving a permanently-unfinished row for a run that in fact completed.
 * A false timeout is the one lie this table must not tell.
 */
export async function finishJobRun(
  handle: JobRunHandle,
  finish: { outcome: JobRunOutcome; detail?: JobRunDetail; finishedAt: Date },
  sink?: JobRunSink,
): Promise<void> {
  if (!handle) return;
  const { db, id, job } = handle;
  try {
    await db
      .update(jobRuns)
      .set({
        finishedAt: finish.finishedAt.toISOString(),
        outcome: finish.outcome,
        detail: capDetail(finish.detail, job),
      })
      .where(eq(jobRuns.id, id));
    sink?.({ phase: 'finish', job, outcome: 'ok' });
  } catch (error) {
    sink?.({ phase: 'finish', job, outcome: 'failed', reason: reasonOf(error) });
  }
}

/**
 * Run `job` under §7.2 bookkeeping. The whole ordering + isolation + rethrow
 * contract lives here so it is unit-testable without the cron dispatcher:
 *
 * 1. the entry row is AWAITED before `run()` is invoked, so a run the isolate
 *    never returns from leaves an unfinished row;
 * 2. `run()`'s own report decides `ok` / `failed` / `skipped`. The nine cron
 *    impls swallow their operational errors and return normally, so a naive
 *    try/catch here would record `ok` for a run that failed;
 * 3. a THROWN handler is recorded `failed` and **rethrown** — `runReconcileJob`
 *    deliberately lets unexpected throws propagate so the queue consumer
 *    `retry()`s, and bookkeeping must not swallow that. Note the converse, which
 *    is load-bearing: a *reported* `outcome: 'failed'` does NOT throw and so does
 *    NOT trigger a retry. Instrumenting must not widen the retry surface from the
 *    one job that has it today to all ten;
 * 4. every bookkeeping write is failure-isolated, so nothing here can abort,
 *    delay past its own await, or alter the job it records. The throw path uses a
 *    plain `catch` rather than `finally` precisely so nothing can `return` out
 *    from under the rethrow.
 */
export async function withJobRun(
  deps: { db: Db | null; job: AdminCronJob; now?: () => Date; sink?: JobRunSink },
  run: () => Promise<JobRunReport>,
): Promise<void> {
  const clock = deps.now ?? (() => new Date());
  const handle = await startJobRun(deps.db, deps.job, clock(), deps.sink);

  let report: JobRunReport;
  try {
    report = await run();
  } catch (error) {
    await finishJobRun(
      handle,
      {
        outcome: 'failed',
        detail: { job: deps.job, reason: reasonOf(error) },
        finishedAt: clock(),
      },
      deps.sink,
    );
    throw error;
  }

  await finishJobRun(
    handle,
    { outcome: report.outcome, detail: report.detail, finishedAt: clock() },
    deps.sink,
  );
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/** One `job_runs` row, as the read side selects it. `detail` is `unknown`
 *  because it crossed a process boundary — parse it, never assume it. */
export interface JobRunRow {
  id: number;
  job: AdminCronJob;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  detail: unknown;
}

/**
 * The newest run of one job, or `undefined` when it has never run.
 *
 * Plans as `SEARCH job_runs USING INDEX job_runs_job_started_at_idx (job=?)` —
 * an equality seek into the job's slice, then one row off the descending edge, so
 * the cost does not grow with the table. Both alternatives considered (a
 * `GROUP BY job` with SQLite's bare-column-`MAX()` rule, and a `ROW_NUMBER() OVER
 * (PARTITION BY job)` subquery) SCAN the whole index instead — measured against a
 * 9,000-row fixture — and D1 bills rows read. `id DESC` is a free deterministic
 * tie-break because `id` is the rowid, i.e. the index's implicit trailing column;
 * verified by `EXPLAIN QUERY PLAN` to add no temp b-tree.
 *
 * Ten of these fanned out with `Promise.all` beats one clever query for a
 * second reason: zero `UNION` terms, so D1's `SQLITE_MAX_COMPOUND_SELECT = 5`
 * (which better-sqlite3 does not share — see `routes/admin-system.ts`) cannot
 * bite. `db.batch()` would be one round trip instead of ten, but the harness
 * shim returns `[]`, so every spec would see an empty result while production
 * worked.
 */
export async function latestJobRun(db: Db, job: AdminCronJob): Promise<JobRunRow | undefined> {
  const [row] = await db
    .select()
    .from(jobRuns)
    .where(eq(jobRuns.job, job))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1);
  return row;
}

/** The newest run of each of `jobs`, keyed by job. A job that has never run is
 *  absent from the map rather than present-and-null, so the caller's
 *  "no record" branch is the natural fallthrough. */
export async function latestJobRuns(
  db: Db,
  jobs: readonly AdminCronJob[],
): Promise<Partial<Record<AdminCronJob, JobRunRow>>> {
  const rows = await Promise.all(jobs.map((job) => latestJobRun(db, job)));
  const out: Partial<Record<AdminCronJob, JobRunRow>> = {};
  jobs.forEach((job, i) => {
    const row = rows[i];
    if (row) out[job] = row;
  });
  return out;
}

/**
 * The newest **completed** run of one job that actually stored a payload.
 *
 * Not simply the newest row: the 04:00 data-quality job is in flight for its
 * first minutes and has no `detail` yet, and blanking yesterday's stored result
 * for that window is worse than showing it with its own timestamp. Same index and
 * same plan as {@link latestJobRun} — the extra predicates just step past a
 * handful of open rows.
 *
 * `requireDetailKey` steps past one more class: a run that FAILED before it could
 * produce its payload stores a `{ job, reason }` envelope, which is `finished_at`
 * + non-null `detail` and so satisfies the base predicates, yet carries none of
 * the per-job report. Left unguarded it shadows the last run that actually stored
 * one — a data-quality pre-run crash would blank yesterday's checks for ~24h and
 * mislabel a job failure as an unreadable payload. Passing the expected top-level
 * key (`'checks'`) filters to runs whose `detail` carries it, via a
 * `json_extract` on the JSON column (path is bound, not interpolated).
 */
export async function latestCompletedJobRun(
  db: Db,
  job: AdminCronJob,
  opts?: { requireDetailKey?: string },
): Promise<JobRunRow | undefined> {
  const conditions = [
    eq(jobRuns.job, job),
    isNotNull(jobRuns.finishedAt),
    isNotNull(jobRuns.detail),
  ];
  if (opts?.requireDetailKey) {
    conditions.push(
      sql`json_extract(${jobRuns.detail}, ${`$.${opts.requireDetailKey}`}) is not null`,
    );
  }
  const [row] = await db
    .select()
    .from(jobRuns)
    .where(and(...conditions))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1);
  return row;
}

/** The stored orphan-sweep half of a 09:00 `algolia-drift` payload, or `null`
 *  when this row is not one / carries no sweep. Shape-checked rather than cast:
 *  the writer is another process. */
export function orphanSweepDetail(detail: unknown): OrphanSweepDetail | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  if (record['job'] !== 'algolia-drift') return null;
  const sweep = record['sweep'];
  if (!sweep || typeof sweep !== 'object' || Array.isArray(sweep)) return null;
  return sweep as OrphanSweepDetail;
}
