/**
 * The IndexNow drain (AECI-826 / §20.2) — the job behind the twenty-minute
 * `INDEXNOW_DRAIN_CRON`.
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
 * now writes to `indexnow_queue` and this job turns any number of buffered
 * promotes into ONE request per tick — the AECI-666 lesson on a different
 * transport: batching beats bounding, bounding beats nothing.
 *
 * ─── Order of operations, and why it is this order ────────────────────────────
 *
 *   1. **Expire** rows older than `INDEXNOW_QUEUE_MAX_AGE_DAYS`, in their own
 *      batch, BEFORE reading. Sharing a batch with step 4 would let the two delete
 *      predicates overlap on the same rows, counting a stale row once as expired
 *      and once as submitted.
 *   2. **Read** the oldest `INDEXNOW_DRAIN_BATCH_SIZE` URLs, FIFO by `id`. That cap
 *      is set by D1's response limit, not IndexNow's — see the constant.
 *   3. **Submit** them in one `callIndexNow` call.
 *   4. **Delete** `id <= maxId` and write the §26.1 summary `audit_log` row in the
 *      SAME `db.batch`. On any failure this step does not run, so the rows stay
 *      buffered and the next tick retries them.
 *
 * ─── Fail-open, and never a throw ─────────────────────────────────────────────
 *
 * §20.2 requires the submission to be best-effort and never to block a write. The
 * write is long committed by the time this runs, but the same posture holds for
 * the cron: a missing key, an unparseable `PUBLIC_SITE_URL` and an IndexNow outage
 * all resolve to a `skipped`/`failed` job report rather than an exception. A **D1**
 * error is the one exception and is deliberately left to propagate, exactly as the
 * other cron impls leave theirs: `withJobRun` records the `failed` `job_runs` row
 * and rethrows, which is what keeps a broken database visible rather than reported
 * as a quiet no-op. The job is queue-less (`queueForJob` returns `undefined`)
 * **on purpose rather than for cost**: a queue retry re-submits inside the same
 * rate-limit window, which is the burst behaviour this whole job exists to remove.
 * The next tick is the backoff.
 */

import type { Db } from '../db/client';
import type { Env } from '../env';

import type { BatchStmt, BatchTuple } from './audit';
import { auditInsert } from './audit';
import { callIndexNow } from './indexnow';
import {
  countPendingIndexNowUrls,
  countStaleIndexNowUrls,
  deleteDrainedIndexNowUrls,
  deleteStaleIndexNowUrls,
  readPendingIndexNowUrls,
  staleCutoffIso,
  type PendingIndexNowUrl,
} from './indexnow-queue';

/** One count per outbound IndexNow submission ATTEMPT. Same name and meaning it
 *  has carried since AECI-236; only the `source` tag changed, `promote` → `cron`,
 *  because the promote no longer submits. */
export const INDEXNOW_SUBMIT_METRIC = 'aeci.indexnow.submit';

/** One count per drain run, ALWAYS emitted — including the empty and skipped
 *  cases. This is the cron-liveness heartbeat the CI sweep reads
 *  (`observability/posthog/project-config.json`), which is why it cannot be folded
 *  into the submit metric: a tick with an empty buffer makes no submission and
 *  must still prove the job is alive. */
export const INDEXNOW_DRAIN_METRIC = 'aeci.indexnow.drain';

/** Buffer depth AFTER the run. A channel that has stopped draining shows up here
 *  as a number that climbs, which is the signal that was missing when every
 *  submission was failing and the only evidence was a warn log. */
export const INDEXNOW_PENDING_METRIC = 'aeci.indexnow.pending';

/** URLs dropped by the staleness sweep. Non-zero is always a finding — it means
 *  the channel was down for a week. */
export const INDEXNOW_EXPIRED_METRIC = 'aeci.indexnow.expired';

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
}) => void;

export interface IndexNowDrainResult {
  /** URLs read from the buffer and handed to the transport. */
  submitted: number;
  /** Rows deleted after a successful submission. Equals `submitted` on success. */
  deleted: number;
  /** Rows dropped by the staleness sweep before the read. */
  expired: number;
  /** Buffer depth after the run, counted rather than inferred. `0` on a clean
   *  full drain; non-zero when a promote buffered mid-run or the buffer was
   *  deeper than one batch. */
  pending: number;
  /** HTTP status of the submission, or `0` when none was attempted. */
  status: number;
  /** How many transport attempts the submission took (retries included). */
  attempts: number;
  ok: boolean;
  reason?: string;
}

/** The §26.1 action for the drain's scheduled delete. `audit_log.action` carries
 *  no CHECK (following the `job_runs.job` precedent), so this costs no migration. */
export const INDEXNOW_DRAINED_ACTION = 'indexnow.drained';

interface DrainDeps {
  db: Db;
  env: Env;
  metrics: IndexNowDrainMetricSink;
  log: IndexNowDrainLogSink;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Injected into the transport's retry backoff. Real `setTimeout` in
   *  production; instant in specs, which would otherwise wait out the full 1 s +
   *  4 s schedule on every throttled case and blow the default test timeout. */
  sleep?: (ms: number) => Promise<void>;
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
 * Delete the submitted rows and record the deletion, atomically.
 *
 * §26.1's scheduled-deletion exception: any *scheduled* `DELETE` emits exactly one
 * summary `audit_log` row per run, in the same batch as the delete. The drain's
 * delete is queue consumption rather than data retention, but the rule is written
 * without that distinction and following it is one statement — and it is genuinely
 * wanted here, because a bug in this delete silently drops URLs out of the only
 * automated discovery channel we have.
 */
async function commitDrain(db: Db, rows: PendingIndexNowUrl[], status: number): Promise<void> {
  const maxId = rows[rows.length - 1]!.id;
  const stmts: BatchStmt[] = [
    deleteDrainedIndexNowUrls(db, maxId),
    auditInsert(db, {
      actorType: 'system',
      action: INDEXNOW_DRAINED_ACTION,
      entityType: 'indexnow_queue',
      metadata: {
        table: 'indexnow_queue',
        cursor: maxId,
        rowsDeleted: rows.length,
        status,
        reason: 'submitted',
      },
    }),
  ];
  await db.batch(stmts as BatchTuple);
}

/**
 * Run one drain. Pure over its injected deps. Never throws on a transport failure
 * — an IndexNow outage, a missing key or an unparseable `PUBLIC_SITE_URL` all come
 * back as a `{ ok: false, reason }` result. A **D1** failure does propagate; see
 * the module header for why that one is left alone.
 *
 * Exported separately from the `scheduled.ts` job wrapper so the whole decision
 * tree is unit-testable without a `ScheduledController`, an `ExecutionContext` or
 * a real metric transport — the same split `runRetentionPrune` uses.
 */
export async function drainIndexNowQueue(deps: DrainDeps): Promise<IndexNowDrainResult> {
  const { db, env, metrics, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date()))();

  const empty: IndexNowDrainResult = {
    submitted: 0,
    deleted: 0,
    expired: 0,
    pending: 0,
    status: 0,
    attempts: 0,
    ok: true,
  };

  const key = env.INDEXNOW_KEY;
  const siteUrl = env.PUBLIC_SITE_URL;
  if (!key || !siteUrl) {
    // Local, preview and any tier before launch. The buffer is never written on
    // those either (the promote hook is gated on the same pair), so this is a
    // genuinely empty no-op rather than a backlog going unserved.
    return { ...empty, ok: false, reason: 'no_creds' };
  }

  let host: string;
  let keyLocation: string;
  try {
    host = new URL(siteUrl).host;
    keyLocation = `${siteUrl.replace(/\/+$/, '')}/${key}.txt`;
  } catch {
    return { ...empty, ok: false, reason: 'invalid_public_site_url' };
  }

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

  const rows = await readPendingIndexNowUrls(db);
  if (rows.length === 0) {
    return { ...empty, expired, pending: 0 };
  }

  const outcome = await callIndexNow(fetchImpl, {
    host,
    key,
    keyLocation,
    urlList: rows.map((r) => r.url),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  metrics.count(INDEXNOW_SUBMIT_METRIC, 1, [
    'source:cron',
    `outcome:${outcome.ok ? 'ok' : 'failed'}`,
  ]);

  if (!outcome.ok) {
    // Leave every row where it is. The next tick is the backoff — re-sending now
    // is what produced the 429 storm in the first place.
    const pending = await countPendingIndexNowUrls(db);
    log({
      level: 'warn',
      message: 'aeci.indexnow.submit_failed',
      reason: `indexnow_${outcome.status}: ${outcome.message}`,
      urls_count: rows.length,
      status: outcome.status,
      attempts: outcome.attempts,
      pending,
    });
    return {
      submitted: rows.length,
      deleted: 0,
      expired,
      pending,
      status: outcome.status,
      attempts: outcome.attempts,
      ok: false,
      reason: `indexnow_${outcome.status}: ${outcome.message}`,
    };
  }

  await commitDrain(db, rows, outcome.status);
  // Counted rather than assumed zero. Two things legitimately leave rows behind:
  // a promote that buffered while this ran (its `id > maxId`), and a buffer deeper
  // than `INDEXNOW_DRAIN_BATCH_SIZE`. Reporting a hard 0 here would make the one
  // gauge that detects a stuck channel incapable of ever showing one.
  const pending = await countPendingIndexNowUrls(db);
  return {
    submitted: rows.length,
    deleted: rows.length,
    expired,
    pending,
    status: outcome.status,
    attempts: outcome.attempts,
    ok: true,
  };
}
