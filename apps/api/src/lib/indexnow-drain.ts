/**
 * The IndexNow drain (AECI-826 / §20.2). Since AECI-1476 it is three jobs, and the
 * outbound request is no longer made by the Worker.
 *
 * ─── What it replaced, and why ────────────────────────────────────────────────
 *
 * Until AECI-826 the promote's post-commit hook called `api.indexnow.org`
 * directly, once per promote. That is fine for one promote and catastrophic for
 * the way the catalogue is actually curated: on 2026-09-07 a single session fired
 * eleven submissions inside seven minutes, and **every production submission
 * between 2026-09-07 and 09 came back HTTP 429 — twenty-three of twenty-three,
 * with no `outcome=ok` series at all**. Nothing alerted, because the hook is
 * fail-open by design and it failed open exactly as designed.
 *
 * Payload size was never the constraint. IndexNow accepts 10,000 URLs per request
 * and our largest attempt carried 107. **Request frequency was.** So the promote
 * now writes to `indexnow_queue` and the drain turns any number of buffered
 * promotes into ONE submission a day — the AECI-666 lesson on a different
 * transport: batching beats bounding, bounding beats nothing.
 *
 * ─── Once a day, tiered (AECI-1136) ───────────────────────────────────────────
 *
 * The drain sends once a day, everything up to IndexNow's 10,000-URL cap, in one
 * request. It sends highest tier first (`indexnow_queue.priority`), so if a day ever
 * exceeds 10,000 URLs the part left for tomorrow is tier 4. One submission is one
 * request under a rate limit, because `callIndexNow` does not retry a bare 429
 * (AECI-833).
 *
 * ─── The send moved to a GitHub Actions runner (AECI-1476) ────────────────────
 *
 * From the Worker, IndexNow refused most daily requests with a 429 even at one a
 * day. A one-shot probe from a GitHub-hosted runner (run 40286642092) got a 200
 * the same UTC day. Cloudflare Worker egress IPs are shared with every other
 * Worker, so the limit we were hitting was not ours. So the one outbound POST
 * moved to `apps/api/scripts/indexnow-runner.ts`, run by
 * `.github/workflows/indexnow-send.yml` at 00:20 UTC. **The Worker keeps every
 * decision and every ledger write.** The runner only carries the request.
 *
 *   1. {@link runIndexNowHousekeeping}, the 00:05 cron. It expires rows older than
 *      `INDEXNOW_QUEUE_MAX_AGE_DAYS` in their own batch and reports the
 *      `pending`/`deferred` gauges. It never reads a drain set and never calls
 *      IndexNow. `aeci.indexnow.drain` stays its heartbeat.
 *   2. {@link prepareIndexNowBatch}, `POST /api/internal/indexnow/batch`. It
 *      reads up to `INDEXNOW_MAX_URLS` (10,000) URLs in drain order —
 *      `priority ASC, queued_at ASC, id ASC` — in keyset pages of
 *      `INDEXNOW_DRAIN_BATCH_SIZE`, skipping any URL IndexNow accepted within
 *      `INDEXNOW_RESEND_MIN_DAYS` (AECI-1130). It drops retired-slug rows as the
 *      last gate (AECI-978) and consumes them there: delete and audit row in one
 *      batch. It mints the `batchId` and hands the runner the rest, with the
 *      public `host`, `key` and `keyLocation`.
 *   3. {@link recordIndexNowResult}, `POST /api/internal/indexnow/batch/:batchId/result`.
 *      Idempotent on `batchId`: a batch that already has log rows writes nothing.
 *      It re-reads the posted ids from the queue and ignores any no longer there.
 *      On a 2xx: one `db.batch` with a `recrawl_submissions` row per sent URL
 *      (AECI-1183), the cause copy, the delete of exactly those ids, the orphan
 *      sweep, then the §26.1 `indexnow.drained` audit row carrying the same
 *      `batchId`. On a refusal or a transport failure the log rows go in a batch of
 *      their own with outcome `refused` or `failed`, and the queue rows stay for
 *      tomorrow. That refusal-log batch is best-effort: if it fails, the route warns
 *      `aeci.indexnow.submission_log_failed` and still reports the refusal. A URL
 *      retried tomorrow gets a second log row. The success-path batch is not
 *      best-effort: its log rows are atomic with the delete.
 *
 * The expiry stays on the cron and before the batch read (00:05 then 00:20) for the
 * reason it always ran first: the two delete predicates must never overlap on the
 * same rows, counting a stale row once as expired and once as submitted.
 *
 * ─── Fail-open, and never a throw ─────────────────────────────────────────────
 *
 * §20.2 requires the submission to be best-effort and never to block a write. A
 * missing key and an unparseable `PUBLIC_SITE_URL` resolve to a `skipped`/`failed`
 * result rather than an exception. A **D1** error is the one exception (bar the
 * refusal-log batch, which warns and carries on) and is deliberately left to
 * propagate: on the cron `withJobRun` records the `failed` `job_runs` row and
 * rethrows, and on the routes the error handler returns a 500, which turns the
 * runner red. The cron is queue-less (`queueForJob` returns `QUEUE_LESS`) **on
 * purpose rather than for cost**, and the runner does not retry a refusal: a retry
 * re-submits inside the same rate-limit window, which is the burst behaviour this
 * whole design exists to remove. Tomorrow's run is the backoff.
 */

import type { Db } from '../db/client';
import type { Env } from '../env';

import type { BatchStmt, BatchTuple } from './audit';
import { auditInsert } from './audit';
import { INDEXNOW_MAX_URLS } from './indexnow';
import { isRetiredSlugUrl, listSlugRedirects, retiredSlugPaths } from './slug-redirect';
import {
  countDeferredIndexNowUrls,
  countPendingIndexNowUrls,
  countStaleIndexNowUrls,
  deleteDrainedIndexNowUrls,
  deleteStaleIndexNowUrls,
  hasSubmissionBatch,
  INDEXNOW_DRAIN_BATCH_SIZE,
  INDEXNOW_RESEND_MIN_DAYS,
  insertSubmissionsFromQueue,
  readPendingIndexNowUrls,
  readQueuedIndexNowUrlsByIds,
  staleCutoffIso,
  type PendingIndexNowUrl,
  type RecrawlSubmissionOutcome,
  type SubmissionLogFields,
} from './indexnow-queue';
import { copyCausesToSubmissions, sweepOrphanCauses } from './recrawl-causes';

/** One count per outbound IndexNow submission ATTEMPT. Same name and meaning it
 *  has carried since AECI-236; only the `source` tag changed: `promote` → `cron`
 *  (AECI-826), then `cron` → `runner` (AECI-1476), because the GitHub Actions
 *  runner now makes the request and the result route records it. A successful
 *  result also emits one {@link INDEXNOW_SUBMITTED_URLS_METRIC} count per tier,
 *  tagged `tier:1` … `tier:4`. */
export const INDEXNOW_SUBMIT_METRIC = 'aeci.indexnow.submit';

/** The `source` tag on {@link INDEXNOW_SUBMIT_METRIC} and
 *  {@link INDEXNOW_SUBMITTED_URLS_METRIC} since AECI-1476. */
export const INDEXNOW_SUBMIT_SOURCE = 'source:runner';

/** One count per housekeeping cron run, ALWAYS emitted — including the skipped
 *  case. This is the cron-liveness heartbeat the CI sweep reads
 *  (`observability/posthog/project-config.json`). Since AECI-1476 the cron makes no
 *  submission at all, so this proves the expiry and the gauges ran. Runner liveness
 *  is {@link INDEXNOW_BATCH_METRIC}. */
export const INDEXNOW_DRAIN_METRIC = 'aeci.indexnow.drain';

/** One count per authenticated `POST /api/internal/indexnow/batch` (AECI-1476),
 *  tagged `outcome:ok|empty|skipped`. The runner's liveness heartbeat. Without it
 *  a runner that stopped calling would be silent: the refusal alert needs at least
 *  three submissions in 72 h to fire, and a runner that never calls makes none. */
export const INDEXNOW_BATCH_METRIC = 'aeci.indexnow.batch';

/** Buffer depth AFTER a run. A channel that has stopped draining shows up here
 *  as a number that climbs, which is the signal that was missing when every
 *  submission was failing and the only evidence was a warn log. Emitted by the
 *  cron (`trigger:cron`) and by the result route (`trigger:runner`). */
export const INDEXNOW_PENDING_METRIC = 'aeci.indexnow.pending';

/** URLs dropped by the staleness sweep. Non-zero is always a finding — it means
 *  the channel was down for a week. */
export const INDEXNOW_EXPIRED_METRIC = 'aeci.indexnow.expired';

/** URLs accepted by IndexNow in one run, one data point per tier, tagged
 *  `tier:1` … `tier:4` (AECI-1136). Emitted only on a successful submission, so
 *  it counts URLs that actually reached the engines. Four series at most. */
export const INDEXNOW_SUBMITTED_URLS_METRIC = 'aeci.indexnow.submitted_urls';

/** Queued URLs the resend window is holding back, read AFTER a run (AECI-1130).
 *  Tagged `trigger:cron` from the cron and `trigger:runner` from the result route.
 *  These rows are a subset of `aeci.indexnow.pending`. A pending count made up
 *  mostly of deferred rows is the window working, not a stuck channel. */
export const INDEXNOW_DEFERRED_METRIC = 'aeci.indexnow.deferred';

/** Where the drain reports its numbers. Injected rather than imported, matching
 *  `RetentionMetricSink` / `ModerationMetricSink`, so this module stays free of
 *  `ctx` / `env` / `Request` plumbing. */
export type IndexNowDrainMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  gauge(metric: string, value: number, tags: string[]): void;
};

/** Where the drain reports a failure reason in prose. Same injection seam. */
export type IndexNowDrainLogSink = (event: {
  level: 'info' | 'warn' | 'error';
  message: string;
  reason?: string;
  urls_count?: number;
  status?: number;
  attempts?: number;
  pending?: number;
  /** The batch's id, on `aeci.indexnow.submit_failed` and
   *  `aeci.indexnow.submission_log_failed`. */
  batchId?: string;
  /** The caught error's message, on `aeci.indexnow.submission_log_failed`. */
  error?: string;
}) => void;

/** What the 00:05 housekeeping cron did (AECI-1476). */
export interface IndexNowHousekeepingResult {
  ok: boolean;
  /** `no_creds` (no `INDEXNOW_KEY` / `PUBLIC_SITE_URL`) or
   *  `invalid_public_site_url`. Set only when `ok` is false. */
  reason?: string;
  /** Rows dropped by the staleness sweep. */
  expired: number;
  /** Buffer depth after the run, counted rather than inferred. */
  pending: number;
  /** Queued rows the resend window is holding back (AECI-1130). Part of `pending`. */
  deferred: number;
}

/** The `outcome` tag on `aeci.indexnow.drain`. `refused` is kept in the type for
 *  the history of the series, but since AECI-1476 the cron sends nothing, so it
 *  never reports one. A refusal is now `aeci.indexnow.submit{outcome:failed}`. */
export type IndexNowDrainOutcome = 'ok' | 'skipped' | 'refused' | 'failed';

/**
 * Map a drain result to its heartbeat `outcome` (AECI-864).
 *
 * `refused` is split out from `failed` because the two need different alerting.
 * The combined "Cron job failed" alert fires on any `outcome:failed` above zero,
 * and IndexNow rate-limits per host with an undocumented limit, so counting a
 * refusal as `failed` would page on every throttled tick. Refusals are judged by
 * the ratio alert over `aeci.indexnow.submit` instead, which has a denominator
 * floor for exactly that reason. `failed` is left meaning a local fault, which is
 * never transient and should page on the first occurrence.
 */
export function drainMetricOutcome(result: {
  ok: boolean;
  reason?: string;
  refused?: true;
}): IndexNowDrainOutcome {
  if (result.ok) return 'ok';
  if (result.reason === 'no_creds') return 'skipped';
  if (result.refused) return 'refused';
  return 'failed';
}

/**
 * Map an IndexNow response to the submission log's outcome (AECI-1183).
 *
 * 2xx is `accepted`. Any 4xx is `refused`, a 429 included: the engine answered
 * and said no. A 5xx, or a status of `0` (no response reached us), is `failed`.
 * A status of `0` is stored as NULL because there is no HTTP status to record.
 * Anything else (a 3xx) is `failed` with its status kept.
 */
export function submissionOutcome(status: number): {
  outcome: RecrawlSubmissionOutcome;
  httpStatus: number | null;
} {
  if (status === 0) return { outcome: 'failed', httpStatus: null };
  if (status >= 200 && status < 300) return { outcome: 'accepted', httpStatus: status };
  if (status >= 400 && status < 500) return { outcome: 'refused', httpStatus: status };
  return { outcome: 'failed', httpStatus: status };
}

/** The §26.1 action for the drain's scheduled delete. `audit_log.action` carries
 *  no CHECK (following the `job_runs.job` precedent), so this costs no migration. */
export const INDEXNOW_DRAINED_ACTION = 'indexnow.drained';

/** Where the submission goes: the public host, the key and the verification file.
 *  The key is public by design (the SSR Worker serves it at `/{key}.txt`), so
 *  handing it to the authenticated runner leaks nothing (AECI-1476 R2). */
export interface IndexNowTarget {
  host: string;
  key: string;
  keyLocation: string;
}

/** Resolve the target from the env, or say why there is none. Shared by the cron
 *  and the batch route so both treat a missing or broken pair the same way. */
export function resolveIndexNowTarget(
  env: Pick<Env, 'INDEXNOW_KEY' | 'PUBLIC_SITE_URL'>,
): ({ ok: true } & IndexNowTarget) | { ok: false; reason: 'no_creds' | 'invalid_public_site_url' } {
  const key = env.INDEXNOW_KEY;
  const siteUrl = env.PUBLIC_SITE_URL;
  if (!key || !siteUrl) {
    // Local, preview, staging and demo. The buffer is never written on those
    // either (the promote hook is gated on the same pair), so this is a genuinely
    // empty no-op rather than a backlog going unserved.
    return { ok: false, reason: 'no_creds' };
  }
  try {
    const host = new URL(siteUrl).host;
    return { ok: true, host, key, keyLocation: `${siteUrl.replace(/\/+$/, '')}/${key}.txt` };
  } catch {
    return { ok: false, reason: 'invalid_public_site_url' };
  }
}

interface DrainDepsBase {
  db: Db;
  log: IndexNowDrainLogSink;
  now?: () => Date;
}

/**
 * Sweep expired rows, in their own batch with their own summary audit row.
 * Returns how many were dropped. `0` writes nothing at all — the "no change, no
 * row" rule §26.1 pins for `retention.pruned` and the connector sync alike.
 */
async function expireStale(db: Db, now: Date): Promise<number> {
  const cutoff = staleCutoffIso(now);
  const expired = await countStaleIndexNowUrls(db, cutoff);
  if (expired === 0) return 0;
  const stmts: BatchStmt[] = [
    deleteStaleIndexNowUrls(db, cutoff),
    // AECI-1184: an expired URL's causes go with it. They were never submitted.
    sweepOrphanCauses(db, 'indexnow'),
    auditInsert(db, {
      actorType: 'system',
      action: INDEXNOW_DRAINED_ACTION,
      entityType: 'indexnow_queue',
      metadata: { table: 'indexnow_queue', cutoff, rowsDeleted: expired, reason: 'expired' },
    }),
  ];
  await db.batch(stmts as BatchTuple);
  return expired;
}

/**
 * Delete drained rows and record the deletion, atomically.
 *
 * §26.1's scheduled-deletion exception: any *scheduled* `DELETE` emits exactly one
 * summary `audit_log` row per run, in the same batch as the delete. The drain's
 * delete is queue consumption rather than data retention, but the rule is written
 * without that distinction and following it is one statement — and it is genuinely
 * wanted here, because a bug in this delete silently drops URLs out of the only
 * automated discovery channel we have.
 *
 * Since AECI-1183 the batch opens with the `recrawl_submissions` copy of the sent
 * rows, when there are any. Order is the contract: log rows, then the deletes,
 * then the audit row carrying `batchId`. The copy reads the queue rows, so it must
 * come first. The retired path passes no `submissions`, because nothing was sent,
 * and records `reason: 'retired'` (AECI-1476: retired rows are consumed by the
 * batch route, the sent rows by the result route, so they are two audit rows that
 * share one `batchId`).
 *
 * Since AECI-1184 two more statements ride along. The cause copy follows the log
 * rows, because it joins them by `batchId`. The orphan sweep follows the deletes,
 * because it removes every cause whose URL is no longer queued. A retired URL's
 * causes are swept without being copied: it was never sent.
 */
async function commitDrain(
  db: Db,
  rows: readonly Pick<PendingIndexNowUrl, 'id'>[],
  status: number,
  byTier: Record<number, number>,
  batchId: string,
  reason: 'submitted' | 'retired',
  submissions?: { ids: readonly number[]; fields: SubmissionLogFields },
): Promise<void> {
  const stmts: BatchStmt[] = [
    // The log copy reads the queue rows, so it must precede their delete.
    ...(submissions ? insertSubmissionsFromQueue(db, submissions.ids, submissions.fields) : []),
    // The cause copy joins the log rows above, so it must follow them (AECI-1184).
    ...(submissions ? [copyCausesToSubmissions(db, 'indexnow', batchId)] : []),
    ...deleteDrainedIndexNowUrls(
      db,
      rows.map((r) => r.id),
    ),
    // After the deletes, so it sees the queue as this run leaves it.
    sweepOrphanCauses(db, 'indexnow'),
    auditInsert(db, {
      actorType: 'system',
      action: INDEXNOW_DRAINED_ACTION,
      entityType: 'indexnow_queue',
      metadata: {
        table: 'indexnow_queue',
        rowsDeleted: rows.length,
        byTier,
        status,
        reason,
        batchId,
      },
    }),
  ];
  await db.batch(stmts as BatchTuple);
}

/** Count rows per tier. Keys are the tier numbers present, nothing else. */
function countByTier(
  rows: readonly Pick<PendingIndexNowUrl, 'priority'>[],
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of rows) out[r.priority] = (out[r.priority] ?? 0) + 1;
  return out;
}

/**
 * Read up to `total` rows in drain order, a page at a time.
 *
 * Pages are keyset-chained on `(priority, queued_at, id)`, so a promote that
 * buffers mid-read can never make a row appear in two pages. The loop stops on
 * a short page, which is how an exhausted buffer shows itself.
 */
async function readDrainSet(
  db: Db,
  total: number,
  resendCutoff: string,
): Promise<PendingIndexNowUrl[]> {
  const rows: PendingIndexNowUrl[] = [];
  let after: PendingIndexNowUrl | undefined;
  while (rows.length < total) {
    const limit = Math.min(INDEXNOW_DRAIN_BATCH_SIZE, total - rows.length);
    const page = await readPendingIndexNowUrls(db, resendCutoff, limit, after);
    rows.push(...page);
    if (page.length < limit) break;
    after = page[page.length - 1];
  }
  return rows;
}

// ─── 1. The cron: expiry and gauges ─────────────────────────────────────────────

/**
 * The 00:05 UTC housekeeping run (AECI-1476 R3). Expires stale rows and reads the
 * buffer depth. It never reads a drain set and never calls IndexNow: the runner
 * does the send at 00:20 through the two internal routes.
 *
 * Pure over its injected deps, and exported separately from the `scheduled.ts`
 * job wrapper so it is unit-testable without a `ScheduledController`. A D1 error
 * propagates (see the module header).
 */
export async function runIndexNowHousekeeping(
  deps: DrainDepsBase & {
    env: Pick<Env, 'INDEXNOW_KEY' | 'PUBLIC_SITE_URL'>;
    metrics: IndexNowDrainMetricSink;
  },
): Promise<IndexNowHousekeepingResult> {
  const { db, env, metrics, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const empty: IndexNowHousekeepingResult = { ok: true, expired: 0, pending: 0, deferred: 0 };

  const target = resolveIndexNowTarget(env);
  if (!target.ok) return { ...empty, ok: false, reason: target.reason };

  const expired = await expireStale(db, now);
  if (expired > 0) {
    metrics.count(INDEXNOW_EXPIRED_METRIC, expired, ['trigger:cron']);
    log({
      level: 'warn',
      message: 'aeci.indexnow.expired',
      reason: `dropped ${expired} URL(s) buffered longer than the max age`,
      urls_count: expired,
    });
  }

  const pending = await countPendingIndexNowUrls(db);
  const deferred = await countDeferredIndexNowUrls(
    db,
    staleCutoffIso(now, INDEXNOW_RESEND_MIN_DAYS),
  );
  metrics.gauge(INDEXNOW_DEFERRED_METRIC, deferred, ['trigger:cron']);
  return { ok: true, expired, pending, deferred };
}

// ─── 2. The batch route: read, filter, mint ─────────────────────────────────────

/** What `POST /api/internal/indexnow/batch` hands the runner. */
export type IndexNowBatchPlan =
  /** No `INDEXNOW_KEY` / `PUBLIC_SITE_URL`: staging, demo, local (R7). */
  | { kind: 'skipped'; reason: 'no_creds' }
  /** `PUBLIC_SITE_URL` does not parse. A local fault, never transient. */
  | { kind: 'failed'; reason: 'invalid_public_site_url' }
  /** Nothing sendable. `retired` rows, if any, were consumed under `batchId`. */
  | { kind: 'empty'; retired: number; batchId?: string }
  /** Send `urls` in one request; post the result under `batchId`. */
  | ({
      kind: 'ready';
      batchId: string;
      ids: number[];
      urls: string[];
      retired: number;
    } & IndexNowTarget);

/**
 * Read the day's drain set and hand it to the runner (AECI-1476).
 *
 * Retired-slug rows are filtered here, as the last gate before the wire, and
 * consumed here: their delete and `indexnow.drained` audit row (`reason: 'retired'`)
 * commit in one batch under this call's `batchId` (R5). They never reach the runner.
 * Nothing else is written. The sendable rows stay queued until the result route
 * hears how IndexNow answered.
 */
export async function prepareIndexNowBatch(
  deps: DrainDepsBase & { env: Pick<Env, 'INDEXNOW_KEY' | 'PUBLIC_SITE_URL'> },
): Promise<IndexNowBatchPlan> {
  const { db, env, log } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const target = resolveIndexNowTarget(env);
  if (!target.ok) {
    return target.reason === 'no_creds'
      ? { kind: 'skipped', reason: 'no_creds' }
      : { kind: 'failed', reason: 'invalid_public_site_url' };
  }

  // AECI-1130: a URL accepted after this is held back, not sent.
  const resendCutoff = staleCutoffIso(now, INDEXNOW_RESEND_MIN_DAYS);
  const rows = await readDrainSet(db, INDEXNOW_MAX_URLS, resendCutoff);
  if (rows.length === 0) return { kind: 'empty', retired: 0 };

  // One id per batch (AECI-1183). Every log row and audit row of this batch carry it.
  const batchId = crypto.randomUUID();

  // AECI-978 — drop any buffered URL whose slug has since retired. This is the last
  // gate before the wire and the only one that covers every producer: a URL can be
  // buffered by a promote minutes before an operator seeds the `slug_redirects` row,
  // so filtering at enqueue time would miss exactly the case that matters. Asking an
  // engine to crawl a 301 wastes one of a strictly limited number of submissions and
  // teaches it a URL we are retiring.
  const retiredPaths = retiredSlugPaths(await listSlugRedirects(db));
  const retiredRows =
    retiredPaths.size === 0 ? [] : rows.filter((r) => isRetiredSlugUrl(r.url, retiredPaths));
  const retiredIds = new Set(retiredRows.map((r) => r.id));
  const sendable = retiredIds.size === 0 ? rows : rows.filter((r) => !retiredIds.has(r.id));

  if (retiredRows.length > 0) {
    log({
      level: 'info',
      message: 'aeci.indexnow.retired_skipped',
      reason: `dropped ${retiredRows.length} URL(s) whose slug now redirects`,
      urls_count: retiredRows.length,
      batchId,
    });
    // The rows are CONSUMED, not left buffered: leaving them would make the same
    // filter run again every day forever. No log rows: a retired URL is never sent.
    await commitDrain(db, retiredRows, 0, {}, batchId, 'retired');
  }

  if (sendable.length === 0) {
    return {
      kind: 'empty',
      retired: retiredRows.length,
      ...(retiredRows.length ? { batchId } : {}),
    };
  }

  return {
    kind: 'ready',
    batchId,
    host: target.host,
    key: target.key,
    keyLocation: target.keyLocation,
    ids: sendable.map((r) => r.id),
    urls: sendable.map((r) => r.url),
    retired: retiredRows.length,
  };
}

// ─── 3. The result route: log, delete, audit ────────────────────────────────────

/** What the runner reports after its one IndexNow request. */
export interface IndexNowRunnerReport {
  batchId: string;
  /** The ids the batch route handed out and the runner sent. */
  ids: readonly number[];
  /** HTTP status IndexNow returned, `0` when no response arrived. */
  status: number;
  /** Transport attempts (`callIndexNow`). `0` means nothing went on the wire. */
  attempts: number;
  /** IndexNow's message, or the transport error. */
  message: string;
  /** When the runner sent the request, ISO 8601. */
  submittedAt: string;
}

/** What the result route did. */
export type IndexNowResultOutcome =
  /** The batch already has log rows. Nothing was written (R4). */
  | { replayed: true; batchId: string }
  | {
      replayed: false;
      batchId: string;
      outcome: RecrawlSubmissionOutcome;
      /** Posted ids still queued, and so logged (and deleted on success). */
      logged: number;
      /** Rows deleted. Equals `logged` on success, `0` otherwise. */
      deleted: number;
      /** Posted ids no longer queued, ignored (R6). */
      ignored: number;
      /** How many of the logged URLs were in each tier, keyed `1`..`4`. */
      byTier: Record<number, number>;
      pending: number;
      deferred: number;
    };

/**
 * Record what IndexNow said about one batch (AECI-1476).
 *
 * Idempotent on `batchId` (R4): if any `recrawl_submissions` row already carries it,
 * this writes nothing and emits nothing. The posted ids are re-read from
 * `indexnow_queue` (R6); an id no longer queued is ignored, and the tiers come from
 * the re-read rows, never from the caller.
 *
 * A report with `attempts === 0` means nothing went on the wire, so there is
 * nothing to log. The submit metric still counts it as `failed`, exactly as the
 * in-Worker drain did.
 */
export async function recordIndexNowResult(
  deps: DrainDepsBase & { metrics: IndexNowDrainMetricSink },
  report: IndexNowRunnerReport,
): Promise<IndexNowResultOutcome> {
  const { db, metrics, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { batchId, status, attempts } = report;

  if (await hasSubmissionBatch(db, batchId)) return { replayed: true, batchId };

  const accepted = status >= 200 && status < 300;
  metrics.count(INDEXNOW_SUBMIT_METRIC, 1, [
    INDEXNOW_SUBMIT_SOURCE,
    `outcome:${accepted ? 'ok' : 'failed'}`,
  ]);

  const rows = await readQueuedIndexNowUrlsByIds(db, report.ids);
  const sentIds = rows.map((r) => r.id);
  const ignored = new Set(report.ids).size - rows.length;
  const byTier = countByTier(rows);
  const fields: SubmissionLogFields = {
    batchId,
    submittedAt: report.submittedAt,
    ...submissionOutcome(status),
  };

  let logged = 0;
  let deleted = 0;
  if (accepted) {
    if (rows.length > 0) {
      await commitDrain(db, rows, status, byTier, batchId, 'submitted', {
        ids: sentIds,
        fields,
      });
      logged = rows.length;
      deleted = rows.length;
      for (const [tier, n] of Object.entries(byTier)) {
        metrics.count(INDEXNOW_SUBMITTED_URLS_METRIC, n, [INDEXNOW_SUBMIT_SOURCE, `tier:${tier}`]);
      }
    }
  } else {
    // Leave every row where it is. Tomorrow's run is the backoff — re-sending now
    // is what produced the 429 storm in the first place.
    //
    // Log the attempt anyway (AECI-1183). A refusal is evidence too, and a vendor
    // asking "did you send my page" deserves "yes, and Bing said no". No audit row:
    // nothing was deleted. `attempts === 0` means nothing went on the wire, so
    // there is nothing to log.
    if (attempts > 0 && rows.length > 0) {
      const stmts = [
        ...insertSubmissionsFromQueue(db, sentIds, fields),
        // The causes are copied onto the refused attempt too (AECI-1184). No sweep:
        // the URLs stay queued, so their causes stay for tomorrow's attempt.
        copyCausesToSubmissions(db, 'indexnow', batchId),
      ];
      // Best-effort, unlike the success path. A D1 error here must not turn a
      // soft refusal into a 500: the runner would go red for a write that only
      // records the refusal, and the refusal would vanish from the warn below.
      // The success-path batch (log + delete + audit) still throws, because
      // there the log is atomic with the delete.
      try {
        await db.batch(stmts as BatchTuple);
        logged = rows.length;
      } catch (err) {
        log({
          level: 'warn',
          message: 'aeci.indexnow.submission_log_failed',
          reason: 'refusal log batch failed; refusal still reported',
          batchId,
          urls_count: rows.length,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Counted rather than assumed zero. Two things legitimately leave rows behind:
  // a promote that buffered after the batch read, and a buffer deeper than one
  // day's `INDEXNOW_MAX_URLS`. Reporting a hard 0 here would make the one gauge
  // that detects a stuck channel incapable of ever showing one.
  const pending = await countPendingIndexNowUrls(db);
  const deferred = await countDeferredIndexNowUrls(
    db,
    staleCutoffIso(now, INDEXNOW_RESEND_MIN_DAYS),
  );
  metrics.gauge(INDEXNOW_PENDING_METRIC, pending, ['trigger:runner']);
  metrics.gauge(INDEXNOW_DEFERRED_METRIC, deferred, ['trigger:runner']);

  if (!accepted) {
    log({
      level: 'warn',
      message: 'aeci.indexnow.submit_failed',
      reason: `indexnow_${status}: ${report.message}`,
      urls_count: rows.length,
      status,
      attempts,
      pending,
      batchId,
    });
  }

  return {
    replayed: false,
    batchId,
    outcome: fields.outcome,
    logged,
    deleted,
    ignored,
    byTier,
    pending,
    deferred,
  };
}
