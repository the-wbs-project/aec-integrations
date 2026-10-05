/**
 * The IndexNow drain (AECI-826 / §20.2) — the job behind the daily
 * `INDEXNOW_DRAIN_CRON` (00:05 UTC since AECI-1136).
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
 * promotes into ONE submission per run — the AECI-666 lesson on a different
 * transport: batching beats bounding, bounding beats nothing.
 *
 * ─── Once a day, tiered (AECI-1136) ───────────────────────────────────────────
 *
 * AECI-826 ran this every 20 minutes. Production PostHog for 2026-09-22..28 showed
 * that Bing refused almost every one of those ticks with a 429, about 60-70 a day,
 * and that the only accepted submissions were the first tick after 00:00 UTC. A
 * 1,287-URL request was accepted, so the limit is on request frequency, not size.
 * So the drain now runs once a day just after midnight UTC and sends everything,
 * up to IndexNow's 10,000-URL cap, in one request. It sends highest tier first
 * (`indexnow_queue.priority`), so if a day ever exceeds 10,000 URLs the part left
 * for tomorrow is tier 4. The cost is latency: a URL now waits up to a day.
 *
 * One submission is one request under a rate limit, because `callIndexNow` does
 * not retry a bare 429 (AECI-833). It was up to three until that gate landed,
 * which made the channel's documented 72-a-day ceiling really 216 — and every one
 * of the extra requests was spent against the limiter this job is waiting on.
 *
 * ─── Order of operations, and why it is this order ────────────────────────────
 *
 *   1. **Expire** rows older than `INDEXNOW_QUEUE_MAX_AGE_DAYS`, in their own
 *      batch, BEFORE reading. Sharing a batch with step 4 would let the two delete
 *      predicates overlap on the same rows, counting a stale row once as expired
 *      and once as submitted.
 *   2. **Read** up to `INDEXNOW_MAX_URLS` (10,000) URLs in drain order —
 *      `priority ASC, queued_at ASC, id ASC` — in keyset pages of
 *      `INDEXNOW_DRAIN_BATCH_SIZE`. The page size is set by D1's response limit,
 *      the total by IndexNow's.
 *   3. **Submit** them in one `callIndexNow` call.
 *   4. **Log, delete, audit**, in the SAME `db.batch`: one `recrawl_submissions`
 *      row per sent URL (AECI-1183), then the delete of exactly the ids that were
 *      read, then the §26.1 summary `audit_log` row. The log rows and the audit
 *      row share one `batchId`. On a refusal or a transport failure the delete and
 *      the audit row do not run, so the rows stay buffered and tomorrow's run
 *      retries them. The log rows are still written, in a batch of their own,
 *      with outcome `refused` or `failed`. A URL retried tomorrow gets a second
 *      log row.
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
 * Tomorrow's run is the backoff.
 */

import type { Db } from '../db/client';
import type { Env } from '../env';

import type { BatchStmt, BatchTuple } from './audit';
import { auditInsert } from './audit';
import { callIndexNow, INDEXNOW_MAX_URLS } from './indexnow';
import { isRetiredSlugUrl, listSlugRedirects, retiredSlugPaths } from './slug-redirect';
import {
  countPendingIndexNowUrls,
  countStaleIndexNowUrls,
  deleteDrainedIndexNowUrls,
  deleteStaleIndexNowUrls,
  INDEXNOW_DRAIN_BATCH_SIZE,
  insertSubmissionsFromQueue,
  readPendingIndexNowUrls,
  staleCutoffIso,
  type PendingIndexNowUrl,
  type RecrawlSubmissionOutcome,
  type SubmissionLogFields,
} from './indexnow-queue';
import { copyCausesToSubmissions, sweepOrphanCauses } from './recrawl-causes';

/** One count per outbound IndexNow submission ATTEMPT. Same name and meaning it
 *  has carried since AECI-236; only the `source` tag changed, `promote` → `cron`,
 *  because the promote no longer submits. Since AECI-1136 a successful run also
 *  emits one {@link INDEXNOW_SUBMITTED_URLS_METRIC} count per tier, tagged
 *  `tier:1` … `tier:4`, so the per-tier split is visible without a second request. */
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

/** URLs accepted by IndexNow in one run, one data point per tier, tagged
 *  `tier:1` … `tier:4` (AECI-1136). Emitted only on a successful submission, so
 *  it counts URLs that actually reached the engines. Four series at most. */
export const INDEXNOW_SUBMITTED_URLS_METRIC = 'aeci.indexnow.submitted_urls';

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
  /** How many of the submitted URLs were in each tier, keyed `1`..`4`. Empty
   *  when nothing was submitted. */
  byTier?: Record<number, number>;
  /** Rows deleted after a successful submission. Equals `submitted` on success. */
  deleted: number;
  /** Rows dropped by the staleness sweep before the read. */
  expired: number;
  /**
   * Rows read but NOT submitted because their URL now only redirects (AECI-978).
   * They are still deleted — the buffer entry is consumed either way — so this is
   * the only place the drop is visible. Non-zero is normal for a tick or two after
   * a retirement and suspicious if it persists.
   */
  retired: number;
  /** Buffer depth after the run, counted rather than inferred. `0` on a clean
   *  full drain; non-zero when a promote buffered mid-run or the buffer held more
   *  than one day's 10,000. */
  pending: number;
  /** HTTP status of the submission, or `0` when none was attempted. */
  status: number;
  /** How many transport attempts the submission took (retries included). */
  attempts: number;
  ok: boolean;
  reason?: string;
  /**
   * The run's UUID (AECI-1183). Shared by every `recrawl_submissions` row the run
   * wrote and by its `indexnow.drained` audit row (`metadata.batchId`). Set only
   * when the run wrote either. `scheduled.ts` copies it into `job_runs.detail`,
   * which is the only place a refused run's batch is named.
   */
  batchId?: string;
  /**
   * Set only when a submission was attempted and did not succeed: IndexNow
   * refused the batch (a 429 included) or the transport never reached it
   * (status `0`). Distinguishes an upstream refusal from a local fault such as an
   * unparseable `PUBLIC_SITE_URL`, which is the difference `drainMetricOutcome`
   * reports (AECI-864).
   */
  refused?: true;
}

/** The `outcome` tag on `aeci.indexnow.drain`. */
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
export function drainMetricOutcome(result: IndexNowDrainResult): IndexNowDrainOutcome {
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
 * Delete the submitted rows and record the deletion, atomically.
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
 * come first. The all-retired path passes no `submissions`, because nothing was
 * sent.
 *
 * Since AECI-1184 two more statements ride along. The cause copy follows the log
 * rows, because it joins them by `batchId`. The orphan sweep follows the deletes,
 * because it removes every cause whose URL is no longer queued. A retired URL's
 * causes are swept without being copied: it was never sent.
 */
async function commitDrain(
  db: Db,
  rows: PendingIndexNowUrl[],
  status: number,
  byTier: Record<number, number>,
  batchId: string,
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
        reason: 'submitted',
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
async function readDrainSet(db: Db, total: number): Promise<PendingIndexNowUrl[]> {
  const rows: PendingIndexNowUrl[] = [];
  let after: PendingIndexNowUrl | undefined;
  while (rows.length < total) {
    const limit = Math.min(INDEXNOW_DRAIN_BATCH_SIZE, total - rows.length);
    const page = await readPendingIndexNowUrls(db, limit, after);
    rows.push(...page);
    if (page.length < limit) break;
    after = page[page.length - 1];
  }
  return rows;
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
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  // One id per run (AECI-1183). Every log row and the audit row of this run carry it.
  const batchId = crypto.randomUUID();

  const empty: IndexNowDrainResult = {
    submitted: 0,
    deleted: 0,
    expired: 0,
    retired: 0,
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

  const rows = await readDrainSet(db, INDEXNOW_MAX_URLS);
  if (rows.length === 0) {
    return { ...empty, expired, pending: 0 };
  }

  // AECI-978 — drop any buffered URL whose slug has since retired. This is the last
  // gate before the wire and the only one that covers every producer: a URL can be
  // buffered by a promote minutes before an operator seeds the `slug_redirects` row,
  // so filtering at enqueue time would miss exactly the case that matters. Asking an
  // engine to crawl a 301 wastes one of a strictly limited number of submissions and
  // teaches it a URL we are retiring.
  const retiredPaths = retiredSlugPaths(await listSlugRedirects(db));
  const sendable =
    retiredPaths.size === 0 ? rows : rows.filter((r) => !isRetiredSlugUrl(r.url, retiredPaths));
  const retired = rows.length - sendable.length;
  if (retired > 0) {
    log({
      level: 'info',
      message: 'aeci.indexnow.retired_skipped',
      reason: `dropped ${retired} URL(s) whose slug now redirects`,
      urls_count: retired,
    });
  }

  // Everything in the batch was retired. The rows are still CONSUMED — leaving them
  // buffered would make the same filter run again every day forever — so this
  // takes the ordinary delete path with no submission behind it.
  if (sendable.length === 0) {
    // No submission, so no log rows: a retired URL was never sent.
    await commitDrain(db, rows, 0, {}, batchId);
    const pendingAfter = await countPendingIndexNowUrls(db);
    return { ...empty, expired, retired, deleted: rows.length, pending: pendingAfter, batchId };
  }

  const sentIds = sendable.map((r) => r.id);
  const submittedAt = clock().toISOString();
  const outcome = await callIndexNow(fetchImpl, {
    host,
    key,
    keyLocation,
    urlList: sendable.map((r) => r.url),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  metrics.count(INDEXNOW_SUBMIT_METRIC, 1, [
    'source:cron',
    `outcome:${outcome.ok ? 'ok' : 'failed'}`,
  ]);

  if (!outcome.ok) {
    // Leave every row where it is. Tomorrow's run is the backoff — re-sending now
    // is what produced the 429 storm in the first place.
    //
    // Log the attempt anyway (AECI-1183). A refusal is evidence too, and a vendor
    // asking "did you send my page" deserves "yes, and Bing said no". No audit row:
    // nothing was deleted. `attempts === 0` means nothing went on the wire, so
    // there is nothing to log.
    let loggedBatch: string | undefined;
    if (outcome.attempts > 0) {
      const stmts = [
        ...insertSubmissionsFromQueue(db, sentIds, {
          batchId,
          submittedAt,
          ...submissionOutcome(outcome.status),
        }),
        // The causes are copied onto the refused attempt too (AECI-1184). No sweep:
        // the URLs stay queued, so their causes stay for tomorrow's attempt.
        copyCausesToSubmissions(db, 'indexnow', batchId),
      ];
      await db.batch(stmts as BatchTuple);
      loggedBatch = batchId;
    }
    const pending = await countPendingIndexNowUrls(db);
    log({
      level: 'warn',
      message: 'aeci.indexnow.submit_failed',
      reason: `indexnow_${outcome.status}: ${outcome.message}`,
      urls_count: sendable.length,
      status: outcome.status,
      attempts: outcome.attempts,
      pending,
    });
    return {
      submitted: sendable.length,
      deleted: 0,
      expired,
      retired,
      pending,
      status: outcome.status,
      attempts: outcome.attempts,
      ok: false,
      reason: `indexnow_${outcome.status}: ${outcome.message}`,
      refused: true,
      ...(loggedBatch ? { batchId: loggedBatch } : {}),
    };
  }

  const byTier = countByTier(sendable);
  await commitDrain(db, rows, outcome.status, byTier, batchId, {
    ids: sentIds,
    fields: { batchId, submittedAt, ...submissionOutcome(outcome.status) },
  });
  for (const [tier, n] of Object.entries(byTier)) {
    metrics.count(INDEXNOW_SUBMITTED_URLS_METRIC, n, ['source:cron', `tier:${tier}`]);
  }
  // Counted rather than assumed zero. Two things legitimately leave rows behind:
  // a promote that buffered while this ran (its id was never read), and a buffer
  // deeper than one day's `INDEXNOW_MAX_URLS`. Reporting a hard 0 here would make
  // the one gauge that detects a stuck channel incapable of ever showing one.
  const pending = await countPendingIndexNowUrls(db);
  return {
    submitted: sendable.length,
    byTier,
    deleted: rows.length,
    expired,
    retired,
    pending,
    status: outcome.status,
    attempts: outcome.attempts,
    ok: true,
    batchId,
  };
}
