/**
 * `job_runs` bookkeeping — the §7.2 write path (AECI-583 / Phase 8.3 P3.1).
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §7.2, `docs/DATABASE_SCHEMA.md` §9.3.
 *
 * Two gaps this closes. A cron's outcome used to exist ONLY as a Datadog metric,
 * so nothing in D1 could answer "did the 08:00 Algolia sync run today"; and the
 * data-quality findings existed ONLY in an email — computed at 04:00, sent,
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

import type { AdminCronJob, AdminTrafficClass } from '@aeci/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { jobRuns } from '../db/schema';
import type { AlgoliaIndexDrift } from './algolia-drift';
import type { EntityOrphanResult } from './algolia-orphans';
import type { IndexEntityResult } from './algolia-sync';
import type { DataQualityCheckResult } from './data-quality';
import type { EmailOutcome } from './email';
import type { HomeStatKeyOutcome } from './home-stats';
import type { MetricsRecheckSummary, MetricsSnapshotResult } from './metrics-snapshot';
import type { ContestReconcileResult, ReconcileResult } from './reconciliation-sweep';
import type { StripeReconcileCounts } from './stripe-reconcile';

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

/**
 * The one `job_runs.job` value that is NOT a Cloudflare cron (AECI-1476): the
 * GitHub Actions IndexNow runner, recorded by its result route. It is kept OUT of
 * `AdminCronJob` on purpose. That enum is the cron vocabulary: `CRON_SCHEDULES`,
 * `CRON_JOBS`, the dispatcher map and `GET /api/admin/system` all key on it, and a
 * runner has no Cloudflare trigger. `job_runs.job` has no CHECK, so storing it
 * needs no migration. Every reader filters on `job`, so these rows never reach the
 * admin cron screen.
 */
export const INDEXNOW_SEND_JOB = 'indexnow-send';
export type RunnerJob = typeof INDEXNOW_SEND_JOB;

/** Everything `job_runs.job` may store: the cron ids plus the runner id. */
export type JobRunJob = AdminCronJob | RunnerJob;

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
  job: JobRunJob;
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
  job: JobRunJob;
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
  // AECI-1460 stopped writing the residual's fields: the PostHog floor, the
  // swarm read-out, the verdict rollup, `pageViewsHumanNetAutomation` and the
  // corroborated floor. Rows written before the cut-over still carry them, and
  // nothing reads them back.
  /**
   * Human views the operator-pair retro-join removed (AECI-683).
   *
   * The single most useful number for deciding whether
   * `OPERATOR_PAIR_LOOKBACK_DAYS` is tuned right: it should track the operator's
   * actual browsing and drop to 0 on days they did not use the site. A figure
   * that stays high on a quiet day means the pair rule is over-reaching.
   */
  operatorLeakViews?: number;
  /**
   * True when the morning's top products and top sources tables were NOT filtered
   * by class, because the day had no classes or the read failed (AECI-1460).
   * `undefined` means a row written before AECI-1460.
   */
  tablesUnclassified?: boolean;
  /**
   * The D19 classes the email led with (AECI-1346). `classifierVersion` and
   * `classViews` are null when the day was not classified or the read failed.
   * `classificationReadFailed` tells the two apart. `undefined` on every field
   * means a row written before AECI-1346.
   */
  classifierVersion?: string | null;
  /** Non-internal views per class for the reported day. */
  classViews?: Record<AdminTrafficClass, number> | null;
  /**
   * The seams the email flagged: the classifier version change over
   * `[prior day, reported day]`, and the §3d collection-method rows in the same
   * span. Null when the class read failed.
   */
  classificationSeam?: {
    version: { from_version: string; to_version: string; changed_on: string } | null;
    method: { at: string; arrivalsComparable: boolean }[];
  } | null;
  classificationReadFailed?: boolean;
}

/**
 * The per-job `detail` payload, discriminated on the `AdminCronJob` id — the same
 * value the row's `job` column carries, repeated inside the JSON so a payload
 * read on its own (a `wrangler d1` query, a future export) is self-describing and
 * narrows without correlating two fields.
 *
 * Two families: {@link JobRunReasonDetail} for a skip or a crash, and the
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
      /** The AECI-827 trailing re-check (ADR 0027), bounded — see
       *  `RECHECK_DETAIL_MAX_ENTRIES`. Absent when the pass did not run at all. */
      recheck?: MetricsRecheckSummary;
    }
  | { job: 'moderation-snapshot'; pendingCount: number; oldestPendingAgeHours: number }
  | ({
      job: 'request-reconcile';
      /** AECI-1008: the contest `REVIEW - ` issue pass, or the error it hit.
       *  Optional so rows written before it existed still parse. */
      contests?: ContestReconcileResult | { error: string };
    } & ReconcileResult)
  /** The 6-hourly AECI-862 staleness check. `stale` is the headline, but `checked`
   *  has to sit beside it: "0 stale" means something different when 0 claims were
   *  eligible than when 40 were. `readFailure` is present only when the Linear
   *  read itself failed, in which case `stale` is 0 because nothing was asserted,
   *  not because nothing is stale — the §5.6 System screen needs that distinction
   *  to avoid reporting an unreadable board as a clean one. */
  /** The daily AECI-1205 protest reply reminder. `due` is the open, unreplied
   *  protests whose deadline falls in the next 3 days. `emails` counts per-seat sends;
   *  a seat already reminded on an earlier run is a `duplicate`, not a failure. */
  /** The daily AECI-1210 per-vendor snapshot. `day` is the snapshot day (the
   *  prior UTC day at run time) and `vendors` is the rows written, one per
   *  activated vendor. */
  | { job: 'vendor-snapshot'; day: string; vendors: number; durationMs: number }
  /** The AECI-1505 sitemap rebuild, on a tick that found the sitemap dirty.
   *  `builtAt` is the build's START, the value stored in `sitemap:built_at`. A
   *  clean tick writes `skipped` with `reason: 'not_dirty'` instead. */
  | {
      job: 'sitemap-rebuild';
      builtAt: string;
      urlCount: number;
      bytes: number;
      durationMs: number;
      base: string;
    }
  /** The daily AECI-1345 traffic classification writer (D19 Phase 2,
   *  `POST_LAUNCH_MONITORING.md` §3c step 4). `classifierVersion` + `fingerprint`
   *  name the rules; `constants` carries the scalar tunables and the swarm block
   *  only, so the row stays far under {@link DETAIL_MAX_BYTES}. `countsByClass` is
   *  over every row seen, internal included; `rowsWritten` is 0 on a re-run.
   *  `backfill` and `through` are present only on a backfill run (AECI-1444): one
   *  row per day, and the chain ends at the row whose `day` equals `through`. */
  | {
      job: 'traffic-classify';
      day: string;
      durationMs: number;
      classifierVersion: string;
      fingerprint: string;
      constants: Record<string, unknown>;
      rowsSeen: number;
      rowsWritten: number;
      countsByClass: Record<string, number>;
      evidenceIncomplete: number;
      swarmTruncated: boolean;
      backfill?: true;
      through?: string;
    }
  /** The daily AECI-1503 Stripe reconcile (`STAGE_2_PAID_TIERS_SPEC.md` §7.6 point 2).
   *  The counts are {@link StripeReconcileCounts}: `changed` above 0 means a webhook
   *  was missed, and `alert` is the operator email's send outcome (`null` when nothing
   *  changed). A run with failed subscriptions throws, so its row is a reason row. */
  | ({
      job: 'stripe-reconcile';
      durationMs: number;
      alert: EmailOutcome | null;
    } & StripeReconcileCounts)
  | {
      job: 'protest-reply-reminder';
      due: number;
      capped: number;
      emails: Record<EmailOutcome, number>;
    }
  /** The daily AECI-1368 claim owner fallback. `moved` is the routed claims handed
   *  to AECi this run (0 is the normal value), `alert` the digest's send outcome, or
   *  `null` when nothing moved and nothing was sent. The `reminder_*` fields are the
   *  AECI-1513 owner reminder step that runs first. Optional, so rows written before it
   *  still parse. `reminder_error` is present only when that step crashed. */
  | {
      job: 'claim-owner-fallback';
      moved: number;
      capped: number;
      alert: EmailOutcome | null;
      reminder_due?: number;
      reminder_capped?: number;
      reminder_emails?: Record<EmailOutcome, number>;
      reminder_error?: string;
    }
  /** The daily AECI-1435 pending-confirmation expiry. `deleted` is the rows past their
   *  7-day link deleted this run, `unconfirmed` how many of them nobody clicked, and
   *  `capped` 1 when more remain for the next run. */
  | {
      job: 'request-confirmation-expiry';
      deleted: number;
      unconfirmed: number;
      capped: number;
    }
  /** The daily AECI-1236 URL Inspection run. One row per CHUNK (one consumer
   *  invocation), all sharing `runId`; `remaining` is the budget the chunk started
   *  with and `next` what it passed on (null = the run ended here). */
  | {
      job: 'gsc-inspect';
      runId: string;
      remaining: number;
      next: number | null;
      inspected: number;
      closed: number;
      tagged: number;
      errors: number;
      halted?: 'quota' | 'auth';
    }
  | {
      job: 'claim-stale-check';
      checked: number;
      stale: number;
      drifted: number;
      alerted: boolean;
      readFailure?: string;
    }
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
      /** One entry per prunable table, ALWAYS all of them, zeros included — "the prune
       *  ran and removed nothing" and "the prune did not consider this table"
       *  are different facts and this row has to distinguish them. */
      tables: RetentionPrunedTableDetail[];
    }
  /** The weekly §7.6 `asn_registry` refresh (AECI-624). Five counts, because the
   *  operator's question is never "did it run" but "how much of my traffic can
   *  the registry actually speak to" — `seen` vs `matched` answers exactly that,
   *  and `failedChunks > 0` with `written > 0` is a real, reportable partial. */
  | {
      job: 'asn-registry';
      durationMs: number;
      /** Networks the upstream returned (~35,000 from PeeringDB). */
      fetched: number;
      /** Distinct ASNs `page_views` has seen — the join domain. */
      seen: number;
      /** `fetched ∩ seen`. The coverage number. */
      matched: number;
      written: number;
      failedChunks: number;
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
    }
  /** The Stage 2 §7 detector sweep (AECI-302), which became a first-class cron at
   *  the AECI-619 reconciliation. `failed` counts per-nudge send failures and does
   *  NOT make the run `failed` — the sweep is fail-open, and a Resend hiccup on one
   *  recipient is not a failed sweep. `capped` non-zero means `NOTIFY_BATCH_CAP`
   *  stopped the run short and the next day continues the backlog. */
  | {
      job: 'attestation-notify';
      found: number;
      sent: number;
      suppressed: number;
      failed: number;
      skipped: number;
      capped: number;
      /** AECI-1204: findings recorded for the portal with no email (every seat
       *  muted, or the tier policy). Absent on rows written before it. */
      portalOnly?: number;
      /** AECI-1204: digest emails Resend accepted (vendor seats and ops). */
      digestsSent?: number;
    }
  /** The Stage 2 §7 term-expiry warning sweep (AECI-613). `due` is terms inside
   *  the horizon BEFORE the `expiry_notice_sent_at` fence and `suppressed` is what
   *  the fence removed — the pair is what makes "one notice per term" auditable
   *  from the row alone. `warned` counts terms that got a delivered notice AND a
   *  stamped fence. Per-channel outcomes are recorded because a deployed tier
   *  reporting `vendor.skipped` is a real finding (no `SUPABASE_SERVICE_ROLE_KEY`,
   *  or no unbanned seat) while locally it is the expected state.
   *
   *  The `lapse*`, `lapsed_*` and `carried` fields are the term-end pre-step (AECI-1404,
   *  `lib/license-lapse.ts`), which runs first: terms ended, licenses ended,
   *  products carried onto a pool license (`carried`, AECI-1405),
   *  terms the cap left for tomorrow, term batches rolled back, and one
   *  `managed-ended` outcome per address. Optional, so rows written before it still
   *  parse. `lapse_error` is present only when the lapse scan itself crashed. */
  | {
      job: 'entitlement-expiry';
      due: number;
      suppressed: number;
      malformed: number;
      capped: number;
      warned: number;
      batchFailures: number;
      vendor: Record<EmailOutcome, number>;
      admin: Record<EmailOutcome, number>;
      lapsed_terms?: number;
      lapsed_licenses?: number;
      carried?: number;
      /** Contests a last-license lapse re-routed to AECi (ruling B, AECI-1404). */
      rerouted_contests?: number;
      lapse_capped?: number;
      lapse_batch_failures?: number;
      lapse_email?: Record<EmailOutcome, number>;
      lapse_error?: string;
      /** The AECI-1512 unassigned-license reminder (Paid Tiers §7.7). */
      unassigned_due?: number;
      unassigned_capped?: number;
      unassigned_nothing_to_assign?: number;
      unassigned_emails?: Record<EmailOutcome, number>;
      unassigned_error?: string;
    }
  /** The daily IndexNow housekeeping run (AECI-826 / §20.2; every 20 minutes
   *  until AECI-1136). Since AECI-1476 the cron sends nothing: the GitHub Actions
   *  runner does, and each send is its own `indexnow-send` row (below). `pending` is counted after the run,
   *  so a number that climbs across rows is a stuck channel rather than a busy
   *  one, and `expired` is non-zero only when the channel has been down for a
   *  week. `deferred` (AECI-1130) is the part of `pending` the resend window holds
   *  back, so a high `pending` that is mostly `deferred` is not a stuck channel. */
  | {
      job: 'indexnow-drain';
      expired: number;
      pending: number;
      deferred: number;
    }
  /** One recorded IndexNow send (AECI-1476), written by the result route,
   *  `POST /api/internal/indexnow/batch/:batchId/result`, once per non-replayed
   *  result. `batchId` joins it to the `recrawl_submissions` rows and, on an
   *  accepted send, the `indexnow.drained` audit row. A refused batch has no audit
   *  row, so this row is the durable record that names it (ADR 0022 rule 4).
   *  `urls` is how many ids the runner posted; `logged` how many were still
   *  queued and written to the log; `reason` is set on a refusal or a failure. */
  | {
      job: 'indexnow-send';
      batchId: string;
      outcome: 'accepted' | 'refused' | 'failed';
      status: number;
      attempts: number;
      urls: number;
      logged: number;
      deleted: number;
      ignored: number;
      reason?: string;
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
 * data-quality set is the largest at ~6-8 KB (eleven checks × `SAMPLE_LIMIT` 10
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
function capDetail(detail: JobRunDetail | undefined, job: JobRunJob): JobRunDetail | null {
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
 * Record one completed run in a single insert, for a job that is not a cron and so
 * has no entry/exit pair to bracket (AECI-1476: the IndexNow runner's result
 * route). The run happened elsewhere, on a GitHub runner, and the route only
 * learns of it once it is over, so there is no in-flight state to make durable.
 *
 * Same contract as the rest of this module: never throws, never rejects. A failed
 * write reports to the sink and returns `false`, and the caller's response and
 * ledger writes are unchanged. Plain single statement, outside any `db.batch`
 * (ADR 0022: no audit row to pair it with).
 */
export async function recordJobRun(
  db: Db,
  job: RunnerJob,
  run: { startedAt: string; finishedAt: Date; outcome: JobRunOutcome; detail: JobRunDetail },
  sink?: JobRunSink,
): Promise<boolean> {
  try {
    await db.insert(jobRuns).values({
      job,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt.toISOString(),
      outcome: run.outcome,
      detail: capDetail(run.detail, job),
    });
    sink?.({ phase: 'finish', job, outcome: 'ok' });
    return true;
  } catch (error) {
    sink?.({ phase: 'finish', job, outcome: 'failed', reason: reasonOf(error) });
    return false;
  }
}

/**
 * Whether an `indexnow-send` row already names `batchId` (AECI-1476). The result
 * route's second idempotency check, beside the `recrawl_submissions` one: a result
 * that logged nothing (`attempts: 0`, or a refusal whose best-effort log batch
 * failed) has no log rows, so only this row proves it was recorded. Seeks the
 * `(job, started_at)` index to the runner's rows, which `job_runs` retention
 * bounds to about one a day. A read failure answers `false`, so the route records
 * the result rather than refusing it.
 */
export async function hasRecordedIndexNowSend(db: Db, batchId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.job, INDEXNOW_SEND_JOB),
          sql`json_extract(${jobRuns.detail}, '$.batchId') = ${batchId}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Run `job` under §7.2 bookkeeping. The whole ordering + isolation + rethrow
 * contract lives here so it is unit-testable without the cron dispatcher:
 *
 * 1. the entry row is AWAITED before `run()` is invoked, so a run the isolate
 *    never returns from leaves an unfinished row;
 * 2. `run()`'s own report decides `ok` / `failed` / `skipped`. The cron
 *    impls swallow their operational errors and return normally, so a naive
 *    try/catch here would record `ok` for a run that failed;
 * 3. a THROWN handler is recorded `failed` and **rethrown** — `runReconcileJob`
 *    deliberately lets unexpected throws propagate so the queue consumer
 *    `retry()`s, and bookkeeping must not swallow that. Note the converse, which
 *    is load-bearing: a *reported* `outcome: 'failed'` does NOT throw and so does
 *    NOT trigger a retry. Instrumenting must not widen the retry surface from the
 *    one job that has it today to all twelve;
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
  // Filtered on one cron id, so the stored `job` is that id (never the runner's).
  return row && { ...row, job };
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
  // Filtered on one cron id, so the stored `job` is that id (never the runner's).
  return row && { ...row, job };
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
