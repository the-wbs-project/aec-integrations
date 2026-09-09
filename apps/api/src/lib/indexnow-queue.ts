/**
 * The `indexnow_queue` buffer — read and write helpers (AECI-826 / §20.2).
 *
 * Two callers, deliberately kept apart from both of them:
 *   - the promote's post-commit hook (`routes/promote.ts`) APPENDS, and
 *   - the twenty-minute drain cron (`lib/indexnow-drain.ts`) READS and DELETES.
 *
 * They meet only here so the delete cursor, the dedupe rule and the staleness
 * window are stated once. See `db/schema.ts` → `indexnowQueue` for why the table
 * carries an `id` at all when `url` is already unique.
 */

import { lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { indexnowQueue } from '../db/schema';

import type { BatchStmt } from './audit';

/**
 * How long a buffered URL may wait before the drain drops it instead of
 * submitting it.
 *
 * Seven days is not a freshness judgement, it is a containment one. If IndexNow
 * stays hostile the buffer would otherwise grow without limit, and an unbounded
 * D1 table is a worse failure than a missed ping — the sitemap has covered the URL
 * for six days by then, and `<lastmod>` is the discovery path that does not depend
 * on an upstream accepting us. Dropped rows are counted and emitted
 * (`aeci.indexnow.expired`) rather than silently discarded, because a non-zero
 * expiry count is itself the finding.
 */
export const INDEXNOW_QUEUE_MAX_AGE_DAYS = 7;

/**
 * Ceiling on one drain's read.
 *
 * **Deliberately far below IndexNow's own 10,000-URL limit.** The binding
 * constraint is not the aggregator, it is **D1's ~1 MB response cap**: 10,000 rows
 * of `(id, url)` at ~60 bytes each lands within a rounding error of it, and the
 * one scenario that could produce a buffer that deep is exactly the scenario this
 * cap exists for — a week-long outage during heavy curation. A read that fails at
 * the depth that only occurs when something is already wrong is the worst possible
 * place to discover a limit.
 *
 * 2,000 URLs is ~150 KB, twenty times the largest submission production has ever
 * made (107), and a run that hits it simply leaves the remainder for the next tick
 * twenty minutes later. `INDEXNOW_MAX_URLS` in the transport stays at IndexNow's
 * real 10,000 so the two constraints are not conflated.
 */
export const INDEXNOW_DRAIN_BATCH_SIZE = 2_000;

/** One buffered URL, as the drain reads it. */
export interface PendingIndexNowUrl {
  id: number;
  url: string;
}

/**
 * Append `urls` to the buffer, ignoring any already queued.
 *
 * `ON CONFLICT DO NOTHING` on the unique `url` index is the whole dedupe story: a
 * product promoted three times inside one drain window occupies one row and is
 * submitted once. The pre-AECI-826 design could not dedupe at all — each promote
 * was its own request.
 *
 * Returns how many rows were actually inserted, counted from `RETURNING` rather
 * than from `meta.changes` — D1 does not report `changes` usefully (the same
 * constraint `retention-prune.ts` works around, and the reason AECI-581 could not
 * count its upserts). `RETURNING` gives an exact number with no second read, and
 * `urls.length - inserted` is the dedupe hit rate.
 */
export async function enqueueIndexNowUrls(
  db: Db,
  urls: readonly string[],
  source = 'promote',
  now: () => Date = () => new Date(),
): Promise<number> {
  if (urls.length === 0) return 0;
  const queuedAt = now().toISOString();
  const inserted = await db
    .insert(indexnowQueue)
    .values(urls.map((url) => ({ url, queuedAt, source })))
    .onConflictDoNothing({ target: indexnowQueue.url })
    .returning({ id: indexnowQueue.id });
  return inserted.length;
}

/**
 * The oldest `limit` buffered URLs, in insertion order.
 *
 * Ordered by `id` rather than `queued_at` because `id` is what the delete cursors
 * on, and two rows written in the same millisecond share a `queued_at`. FIFO also
 * means a wedged tail cannot starve: whatever failed last tick is read first this
 * tick.
 */
export async function readPendingIndexNowUrls(
  db: Db,
  limit: number = INDEXNOW_DRAIN_BATCH_SIZE,
): Promise<PendingIndexNowUrl[]> {
  return db
    .select({ id: indexnowQueue.id, url: indexnowQueue.url })
    .from(indexnowQueue)
    .orderBy(indexnowQueue.id)
    .limit(limit);
}

/** How many rows are still buffered. Emitted as `aeci.indexnow.pending` — a
 *  channel that has stopped draining shows up here as a number that climbs. */
export async function countPendingIndexNowUrls(db: Db): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(indexnowQueue);
  return Number(row?.count ?? 0);
}

/**
 * Delete every row up to and including `maxId` — the drain's "these are submitted,
 * let them go" statement, returned as a `BatchStmt` so it commits in the SAME
 * `db.batch` as its `audit_log` summary row (§26.1's scheduled-deletion
 * exception).
 *
 * `id <= maxId` is safe against concurrent appends because `id` is monotonic: a
 * promote that buffers a URL between the drain's SELECT and this DELETE always
 * lands above `maxId` and survives to the next tick.
 */
export function deleteDrainedIndexNowUrls(db: Db, maxId: number): BatchStmt {
  return db.delete(indexnowQueue).where(lte(indexnowQueue.id, maxId));
}

/**
 * Delete rows queued at or before `cutoffIso`. The staleness sweep — see
 * {@link INDEXNOW_QUEUE_MAX_AGE_DAYS}.
 *
 * The drain runs this BEFORE it reads, in its own batch, deliberately. Sharing a
 * batch with the drain's own `id <= maxId` delete would let the two predicates
 * overlap on the same rows — a stale row is by definition among the oldest, so it
 * would be counted once as expired and once as submitted. Sweeping first makes the
 * two sets disjoint by construction.
 */
export function deleteStaleIndexNowUrls(db: Db, cutoffIso: string): BatchStmt {
  return db.delete(indexnowQueue).where(lte(indexnowQueue.queuedAt, cutoffIso));
}

/** How many rows are older than `cutoff`. Read before the delete so the audit row
 *  and the metric can both state a real number — D1 does not reliably return
 *  `meta.changes` for a delete. */
export async function countStaleIndexNowUrls(db: Db, cutoffIso: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(indexnowQueue)
    .where(lte(indexnowQueue.queuedAt, cutoffIso));
  return Number(row?.count ?? 0);
}

/** The ISO timestamp `INDEXNOW_QUEUE_MAX_AGE_DAYS` before `now`. */
export function staleCutoffIso(now: Date, days = INDEXNOW_QUEUE_MAX_AGE_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}
