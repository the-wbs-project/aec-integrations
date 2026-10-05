/**
 * The `indexnow_queue` buffer — read and write helpers (AECI-826 / §20.2).
 *
 * Two kinds of caller, deliberately kept apart:
 *   - the promote's post-commit hook (`routes/promote.ts`) and the vendor-portal
 *     writes (`routes/vendor-shared.ts`) APPEND, and
 *   - the daily drain cron (`lib/indexnow-drain.ts`) READS and DELETES, and
 *     copies every URL it sends into the `recrawl_submissions` log (AECI-1183).
 *
 * They meet only here so the tiering, the dedupe rule, the delete shape and the
 * staleness window are stated once.
 *
 * ─── Tiered since AECI-1136 ───────────────────────────────────────────────────
 *
 * Each row carries a `priority`, 1 (most important) … 4 (least), from the SAME
 * reason → tier map the Google re-crawl worklist uses (`GSC_RECRAWL_PRIORITY`).
 * The tables stay separate (ADR 0031 §1); only the map and its pure helpers are
 * shared. The drain reads `priority ASC, queued_at ASC, id ASC`, so a new product
 * page goes out ahead of a pair-page edit, and tier 4 is last.
 */

import { inArray, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { indexnowQueue, recrawlSubmissions } from '../db/schema';

import type { BatchStmt } from './audit';
import {
  dedupeByBestPriority,
  GSC_RECRAWL_MAX_PRIORITY,
  gscRecrawlPriority,
  type GscRecrawlEntry,
} from './gsc-recrawl-priority';

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
 * Rows per D1 READ, not per submission.
 *
 * Since AECI-1136 the drain runs once a day and sends up to IndexNow's own
 * 10,000-URL limit (`INDEXNOW_MAX_URLS`) in ONE request. It reaches that by reading
 * in pages of this size. The page size is set by **D1's ~1 MB response cap**:
 * 10,000 rows of `(id, url, priority, queued_at)` in one read would land within a
 * rounding error of it, and the day a buffer is that deep is the day something is
 * already wrong. 2,000 rows is ~200 KB, comfortably clear.
 *
 * So the two limits stay separate on purpose: this one protects the read, and
 * `INDEXNOW_MAX_URLS` in the transport caps the submission.
 */
export const INDEXNOW_DRAIN_BATCH_SIZE = 2_000;

/**
 * Ids per DELETE statement.
 *
 * The drain deletes exactly the rows it sent, by id. D1 caps a query at 100 bound
 * parameters, and each id is one, so a 10,000-row day is 100 statements, all in
 * the one `db.batch` that also carries the audit row. See
 * {@link deleteDrainedIndexNowUrls} for why this is no longer an `id <= maxId`
 * range.
 */
export const INDEXNOW_DELETE_IDS_PER_STATEMENT = 100;

/**
 * URLs per INSERT statement.
 *
 * **D1 caps a query at 100 bound parameters**
 * (developers.cloudflare.com/d1/platform/limits/), the same ceiling
 * `asn-registry.ts` sizes `UPSERT_ROWS_PER_STATEMENT` off. Each buffered row binds
 * four values — `url`, `queued_at`, `source`, `priority` — so 25 rows is 100
 * parameters and one more row is a rejected statement. It was 33 while the row
 * bound three; AECI-1136 added `priority`. The conflict clause binds nothing.
 *
 * This has to be sized off the documented limit rather than measured locally,
 * because **better-sqlite3's ceiling is 32,766**: a single unchunked INSERT of 107
 * URLs passes every spec in this repo and fails in production. The set is
 * genuinely unbounded — `affectedUrlsForPromote` emits one URL per integration in
 * the payload — and the largest submission production has made carried 107, so
 * this is not a theoretical edge.
 */
export const INDEXNOW_INSERT_ROWS_PER_STATEMENT = 25;

/** One buffered URL, as the drain reads it. `priority` and `queuedAt` are read
 *  because they are the keyset cursor for the next page. */
export interface PendingIndexNowUrl {
  id: number;
  url: string;
  priority: number;
  queuedAt: string;
}

/** One URL to buffer, with its tier. */
export interface IndexNowEntry {
  url: string;
  priority: number;
}

/**
 * What a producer hands {@link enqueueIndexNowUrls}. A bare string is a URL the
 * tier map does not rank, and it is buffered at tier 4. Production callers go
 * through {@link indexNowEntriesByTier}, which applies that rule explicitly.
 */
export type IndexNowEnqueueInput = string | IndexNowEntry;

/**
 * Tier the IndexNow URL set by the Google re-crawl entries for the same write.
 *
 * Both producers already derive two lists from one write: the IndexNow URL set
 * (every page the write touched, hubs included) and the ranked GSC entries
 * (entity detail pages only, each with the reason that tiers it). This takes the
 * tier for each IndexNow URL from the GSC entry for the same URL, so the reason →
 * tier map has exactly one home (`GSC_RECRAWL_PRIORITY`). A URL with no GSC entry
 * is a hub or facet page (`/products`, `/categories/...`, `/`) and gets tier 4.
 *
 * The IndexNow list decides MEMBERSHIP. A GSC entry whose URL is not in `urls`
 * adds nothing, so tiering can never widen what we submit.
 */
export function indexNowEntriesByTier(
  urls: readonly string[],
  ranked: readonly GscRecrawlEntry[],
): IndexNowEntry[] {
  const tierByUrl = new Map<string, number>();
  for (const entry of dedupeByBestPriority(ranked)) {
    tierByUrl.set(entry.url, gscRecrawlPriority(entry.reason));
  }
  return urls.map((url) => ({ url, priority: tierByUrl.get(url) ?? GSC_RECRAWL_MAX_PRIORITY }));
}

/** Normalise producer input and collapse duplicate URLs, keeping the best tier.
 *  A duplicate inside one INSERT would make the statement's own conflict clause
 *  arbitrate something the caller already knows. */
function normaliseEntries(input: readonly IndexNowEnqueueInput[]): IndexNowEntry[] {
  const best = new Map<string, number>();
  for (const item of input) {
    const entry =
      typeof item === 'string' ? { url: item, priority: GSC_RECRAWL_MAX_PRIORITY } : item;
    const existing = best.get(entry.url);
    if (existing === undefined || entry.priority < existing) best.set(entry.url, entry.priority);
  }
  return [...best].map(([url, priority]) => ({ url, priority }));
}

function insertChunk(db: Db, chunk: readonly IndexNowEntry[], queuedAt: string, source: string) {
  return db
    .insert(indexnowQueue)
    .values(chunk.map((e) => ({ url: e.url, queuedAt, source, priority: e.priority })))
    .onConflictDoUpdate({
      target: indexnowQueue.url,
      // IMPROVE ONLY, the rule `gsc_recrawl_queue` uses. 1 is the most important
      // tier, so `min(existing, incoming)`: a pair-page edit (4) followed by a new
      // product on the same URL (1) rises to 1, and the reverse stays at 1.
      set: { priority: sql`min(${indexnowQueue.priority}, excluded.priority)` },
      // Only touch the row when the tier actually improves. Without this every
      // re-buffer of a queued URL would be an UPDATE, and its RETURNING row would
      // count as "queued" and hide the dedupe rate.
      //
      // `queued_at` and `source` are deliberately absent from `set`. Keeping the
      // original `queued_at` keeps oldest-first ordering inside a tier honest, and
      // keeps the seven-day expiry measured from the first buffering.
      setWhere: sql`excluded.priority < ${indexnowQueue.priority}`,
    })
    .returning({ id: indexnowQueue.id, queuedAt: indexnowQueue.queuedAt });
}

/**
 * The INSERT statements `enqueueIndexNowUrls` will run, chunked to
 * {@link INDEXNOW_INSERT_ROWS_PER_STATEMENT}.
 *
 * Exported so a spec can assert the **bound-parameter count per statement**, which
 * is the only assertion that actually guards the limit — the in-memory harness
 * binds thousands of parameters happily, so a behavioural "did all the rows land"
 * test passes with or without the chunking.
 */
export function indexNowInsertStatements(
  db: Db,
  input: readonly IndexNowEnqueueInput[],
  queuedAt: string,
  source: string,
): ReturnType<typeof insertChunk>[] {
  const entries = normaliseEntries(input);
  const stmts: ReturnType<typeof insertChunk>[] = [];
  for (let i = 0; i < entries.length; i += INDEXNOW_INSERT_ROWS_PER_STATEMENT) {
    stmts.push(
      insertChunk(db, entries.slice(i, i + INDEXNOW_INSERT_ROWS_PER_STATEMENT), queuedAt, source),
    );
  }
  return stmts;
}

/**
 * Append `input` to the buffer. A URL already queued keeps its row, and its tier
 * improves if the new one is better (AECI-1136).
 *
 * The unique `url` index is the whole dedupe story: a product promoted three times
 * before the daily drain occupies one row and is submitted once. The conflict
 * clause is `DO UPDATE` rather than `DO NOTHING` only so the tier can rise; it
 * never lowers a tier and never refreshes `queued_at`.
 *
 * Written as one statement per {@link INDEXNOW_INSERT_ROWS_PER_STATEMENT} URLs,
 * run in sequence rather than in a `db.batch`. Two reasons, and neither is cost:
 * the buffer's INSERTs are ADR 0022 log-class and idempotent, so a chunk set that
 * stops half way leaves committed rows the drain will submit and a re-promote will
 * dedupe against — there is nothing for atomicity to protect. And `RETURNING`
 * rows do not survive `db.batch` in the in-memory harness (its shim reads rows
 * only for statements beginning `select`/`with`), so batching would make the
 * inserted count silently wrong in every spec. A failing chunk throws to the
 * caller, whose fail-open catch logs it (§20.2).
 *
 * Returns how many rows were newly INSERTED, counted from `RETURNING` rather than
 * `meta.changes`, which D1 does not report usefully. A tier-raising update also
 * returns a row, but it keeps its original `queued_at`, so a returned row whose
 * `queued_at` is not this call's timestamp is an update and is not counted.
 * `urls.length - inserted` stays the dedupe hit rate.
 */
export async function enqueueIndexNowUrls(
  db: Db,
  input: readonly IndexNowEnqueueInput[],
  source = 'promote',
  now: () => Date = () => new Date(),
): Promise<number> {
  if (input.length === 0) return 0;
  const queuedAt = now().toISOString();
  let inserted = 0;
  for (const stmt of indexNowInsertStatements(db, input, queuedAt, source)) {
    inserted += (await stmt).filter((row) => row.queuedAt === queuedAt).length;
  }
  return inserted;
}

/** Where the previous page ended. The next page starts strictly after it. */
export type IndexNowReadCursor = Pick<PendingIndexNowUrl, 'priority' | 'queuedAt' | 'id'>;

/**
 * One page of buffered URLs in drain order: `priority ASC, queued_at ASC, id ASC`.
 *
 * Tier 1 first, tier 4 last, oldest first inside a tier, and `id` as the
 * tiebreaker because two rows written in the same millisecond share a
 * `queued_at`. Oldest-first inside a tier means a wedged tail cannot starve:
 * whatever failed yesterday is read first today.
 *
 * Paged by a keyset `after` cursor rather than `OFFSET`, so a promote that buffers
 * between two page reads can never shift a row into a page twice. A row inserted
 * or re-tiered to a position BEFORE the cursor is simply not read this run and
 * goes out tomorrow.
 */
export async function readPendingIndexNowUrls(
  db: Db,
  limit: number = INDEXNOW_DRAIN_BATCH_SIZE,
  after?: IndexNowReadCursor,
): Promise<PendingIndexNowUrl[]> {
  const base = db
    .select({
      id: indexnowQueue.id,
      url: indexnowQueue.url,
      priority: indexnowQueue.priority,
      queuedAt: indexnowQueue.queuedAt,
    })
    .from(indexnowQueue);
  const filtered = after
    ? base.where(
        sql`(${indexnowQueue.priority}, ${indexnowQueue.queuedAt}, ${indexnowQueue.id}) > (${after.priority}, ${after.queuedAt}, ${after.id})`,
      )
    : base;
  return filtered
    .orderBy(indexnowQueue.priority, indexnowQueue.queuedAt, indexnowQueue.id)
    .limit(limit);
}

/** How many rows are still buffered. Emitted as `aeci.indexnow.pending` — a
 *  channel that has stopped draining shows up here as a number that climbs. */
export async function countPendingIndexNowUrls(db: Db): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(indexnowQueue);
  return Number(row?.count ?? 0);
}

/**
 * Delete exactly the rows the drain read — the "these are submitted, let them go"
 * statements, returned as `BatchStmt`s so they commit in the SAME `db.batch` as
 * the `audit_log` summary row (§26.1's scheduled-deletion exception).
 *
 * **By id list, chunked to {@link INDEXNOW_DELETE_IDS_PER_STATEMENT}.** Until
 * AECI-1136 this was one `id <= maxId` statement, which was only correct because
 * the drain read in `id` order. It now reads in tier order, so the rows it sent
 * are not a contiguous id range. A tier/`queued_at`/`id` watermark was considered
 * and rejected: a promote that buffers a tier-1 URL during the request sorts
 * BEFORE the watermark, and a watermark delete would drop it unsent. An id list
 * deletes only what went on the wire. A row whose tier improved after the read
 * keeps its id and is deleted, which is right: its URL was just sent.
 *
 * A 10,000-row day is 100 statements. D1 counts each toward the per-invocation
 * query limit (1,000 on Workers Paid), which leaves ample headroom.
 */
export function deleteDrainedIndexNowUrls(db: Db, ids: readonly number[]): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  for (let i = 0; i < ids.length; i += INDEXNOW_DELETE_IDS_PER_STATEMENT) {
    const chunk = ids.slice(i, i + INDEXNOW_DELETE_IDS_PER_STATEMENT);
    stmts.push(db.delete(indexnowQueue).where(inArray(indexnowQueue.id, chunk)));
  }
  return stmts;
}

/** What a submission log row records about the request (AECI-1183). */
export type RecrawlSubmissionOutcome = 'accepted' | 'refused' | 'failed';

/** The per-run constants every log row of one drain shares. */
export interface SubmissionLogFields {
  batchId: string;
  /** The HTTP status IndexNow returned, or `null` when no response arrived. */
  httpStatus: number | null;
  outcome: RecrawlSubmissionOutcome;
  submittedAt: string;
}

/**
 * Ids per submission-log INSERT … SELECT statement (AECI-1183).
 *
 * The statement binds the four per-run constants (`outcome`, `http_status`,
 * `batch_id`, `submitted_at`) plus one parameter per id. The channel is a SQL
 * literal. 95 ids is therefore 99 bound parameters, one under D1's cap of 100.
 */
export const RECRAWL_SUBMISSION_IDS_PER_STATEMENT = 95;

/**
 * The statements that copy the sent queue rows into `recrawl_submissions`, one
 * row per id, chunked to {@link RECRAWL_SUBMISSION_IDS_PER_STATEMENT}.
 *
 * `INSERT … SELECT … FROM indexnow_queue WHERE id IN (…)`, so the URL and tier
 * come from the queue row itself rather than being re-bound per row. That is
 * what keeps the parameter count at one per id. It also means the statements
 * must run BEFORE the queue delete in the same batch, which `commitDrain` does.
 *
 * `id` is selected as `NULL` only because Drizzle's insert-select names every
 * table column. SQLite assigns the autoincrement value for a NULL rowid.
 *
 * Returned as `BatchStmt`s, never run here. On success they share the drain's
 * delete-and-audit batch. On a refusal they are a batch of their own. A later
 * writer (AECI-1184's cause copy) can follow them in the same batch, keyed by
 * `batchId`, without changing this builder.
 */
export function insertSubmissionsFromQueue(
  db: Db,
  ids: readonly number[],
  fields: SubmissionLogFields,
): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  for (let i = 0; i < ids.length; i += RECRAWL_SUBMISSION_IDS_PER_STATEMENT) {
    const chunk = ids.slice(i, i + RECRAWL_SUBMISSION_IDS_PER_STATEMENT);
    stmts.push(
      db.insert(recrawlSubmissions).select(
        db
          .select({
            id: sql<number>`NULL`.as('id'),
            url: indexnowQueue.url,
            channel: sql<string>`'indexnow'`.as('channel'),
            outcome: sql<string>`${fields.outcome}`.as('outcome'),
            httpStatus: sql<number | null>`${fields.httpStatus}`.as('http_status'),
            batchId: sql<string>`${fields.batchId}`.as('batch_id'),
            priority: indexnowQueue.priority,
            submittedAt: sql<string>`${fields.submittedAt}`.as('submitted_at'),
          })
          .from(indexnowQueue)
          .where(inArray(indexnowQueue.id, chunk)),
      ),
    );
  }
  return stmts;
}

/**
 * Delete rows queued at or before `cutoffIso`. The staleness sweep — see
 * {@link INDEXNOW_QUEUE_MAX_AGE_DAYS}.
 *
 * The drain runs this BEFORE it reads, in its own batch, deliberately. The rows it
 * removes can then never be among the rows the drain reads, so a stale row cannot
 * be counted once as expired and once as submitted. Sweeping first makes the two
 * sets disjoint by construction.
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
