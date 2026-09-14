/**
 * The `gsc_recrawl_queue` worklist — read and write helpers (AECI-945 / §20.2).
 *
 * The sibling of `indexnow-queue.ts`, and deliberately shaped like it so the two
 * read as a pair. The differences are the whole point, and there are three:
 *
 *   1. **A person drains this one.** There is no cron. `POST /api/promote` and the
 *      vendor-portal writes APPEND; the `/admin/reindex` screen (AECI-946) READS,
 *      and its Done button DELETES one row. Google has no API that accepts our
 *      content types (AECI-747), so Search Console → URL Inspection → Request
 *      Indexing, run by hand, is the only channel.
 *   2. **Conflicts RAISE priority.** `indexnow_queue` can use `DO NOTHING`
 *      because every buffered URL is equal to every other. Here they are ranked,
 *      so a second event on an already-queued URL has to be able to promote it.
 *      See {@link enqueueGscRecrawl}.
 *   3. **Nothing ages out.** `indexnow_queue` has a seven-day staleness sweep
 *      because a missed ping is recoverable — the sitemap covers the URL anyway.
 *      A row dropped from *this* table is work no human ever saw. There is no
 *      `deleteStale*` here and there must not be one.
 *
 * See `db/schema.ts` → `gscRecrawlQueue` for the full rationale on why this is a
 * separate table rather than a column on `indexnow_queue`.
 */

import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { gscRecrawlQueue } from '../db/schema';

import type { BatchStmt } from './audit';
import {
  dedupeByBestPriority,
  gscRecrawlPriority,
  type GscRecrawlEntry,
  type GscRecrawlReason,
} from './gsc-recrawl-priority';

/**
 * Rows per INSERT statement.
 *
 * **D1 caps a query at 100 bound parameters**, and this is that cap divided by
 * the number of bound columns per row. Five are bound here — `url`, `priority`,
 * `reason`, `source`, `queued_at` — so 20 rows is 100 parameters exactly and one
 * more row is a rejected statement.
 *
 * **This is NOT `INDEXNOW_INSERT_ROWS_PER_STATEMENT` (33).** That constant is the
 * same cap divided by *three* columns, because `indexnow_queue` has no `priority`
 * and no `reason`. Copying 33 across would bind 165 parameters and fail — and it
 * would fail *only in production*, because better-sqlite3's ceiling in the
 * in-memory spec harness is 32,766, so an unchunked insert of any realistic size
 * passes every test in this repo. The specs therefore assert the emitted
 * parameter count per statement, not just that the rows landed.
 */
export const GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT = 20;

/**
 * Ceiling on one worklist read.
 *
 * Sized for a screen a human works down, not for a machine drain. Two hundred
 * rows is far more than a day's Request Indexing quota, so the operator can never
 * exhaust a page; anything below the cut is by definition tier-4 work that was
 * not going to be reached today anyway. It also keeps the response inside D1's
 * ~1 MB cap with three orders of magnitude to spare.
 */
export const GSC_RECRAWL_PAGE_SIZE = 200;

/** One worklist row, as the admin screen reads it. */
export interface PendingGscRecrawl {
  id: number;
  url: string;
  priority: number;
  reason: string;
  source: string;
  queuedAt: string;
}

function insertChunk(db: Db, chunk: readonly GscRecrawlEntry[], queuedAt: string, source: string) {
  return db
    .insert(gscRecrawlQueue)
    .values(
      chunk.map((entry) => ({
        url: entry.url,
        priority: gscRecrawlPriority(entry.reason),
        reason: entry.reason,
        source,
        queuedAt,
      })),
    )
    .onConflictDoUpdate({
      target: gscRecrawlQueue.url,
      set: {
        // RAISE ONLY. `MIN(existing, incoming)` because 1 is the most important
        // tier — a page that had a logo swap (4) and is then renamed (2) must
        // rise to 2, while a renamed page (2) that then has its logo swapped
        // (4) must NOT fall back to 4. Under `DO NOTHING` the first case would
        // leave the page buried at the bottom of a list the operator never
        // reaches, which is indistinguishable from never having queued it.
        priority: sql`min(${gscRecrawlQueue.priority}, excluded.priority)`,
        // The reason follows the priority, so the screen's "why" column
        // explains the tier the row is actually sorted at rather than a
        // less-important event that happened later.
        reason: sql`case when excluded.priority < ${gscRecrawlQueue.priority} then excluded.reason else ${gscRecrawlQueue.reason} end`,
        source: sql`case when excluded.priority < ${gscRecrawlQueue.priority} then excluded.source else ${gscRecrawlQueue.source} end`,
        // `queued_at` is deliberately ABSENT from this set, so the original
        // survives. Ordering inside a tier is oldest-first; refreshing the
        // timestamp would let a page someone keeps editing starve an older one
        // indefinitely.
      },
    })
    .returning({ id: gscRecrawlQueue.id });
}

/**
 * The INSERT statements {@link enqueueGscRecrawl} will run, chunked to
 * {@link GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT}.
 *
 * Exported so a spec can assert the **bound-parameter count per statement**,
 * which is the only assertion that actually guards D1's limit — see that
 * constant's note for why a behavioural test cannot.
 */
export function gscRecrawlInsertStatements(
  db: Db,
  entries: readonly GscRecrawlEntry[],
  queuedAt: string,
  source: string,
): ReturnType<typeof insertChunk>[] {
  const stmts: ReturnType<typeof insertChunk>[] = [];
  for (let i = 0; i < entries.length; i += GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT) {
    stmts.push(
      insertChunk(
        db,
        entries.slice(i, i + GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT),
        queuedAt,
        source,
      ),
    );
  }
  return stmts;
}

/**
 * Append `entries` to the worklist, raising the priority of any already queued.
 *
 * Duplicates *within* `entries` are collapsed first by
 * {@link dedupeByBestPriority}: a single promote can reach the same URL under two
 * reasons, and emitting both would make the statement's own `DO UPDATE`
 * arbitrate something the caller already knows the answer to.
 *
 * Run in sequence rather than in a `db.batch`, matching `enqueueIndexNowUrls` and
 * for the same two reasons: these INSERTs are ADR 0022 log-class and idempotent,
 * so a chunk set that stops half way leaves rows a later write will merge against
 * rather than duplicate — there is nothing for atomicity to protect. And
 * `RETURNING` rows do not survive `db.batch` in the in-memory harness, which
 * would make the returned count silently wrong in every spec.
 *
 * A failing chunk throws to the caller, whose fail-open catch logs it (§20.2).
 *
 * Returns how many rows the statements touched, counted from `RETURNING` rather
 * than `meta.changes`, which D1 does not report usefully. Note this counts
 * inserts **and** priority-raising updates together — unlike the IndexNow
 * buffer's return value, it is not a dedupe-miss signal.
 */
export async function enqueueGscRecrawl(
  db: Db,
  entries: readonly GscRecrawlEntry[],
  source: string,
  now: () => Date = () => new Date(),
): Promise<number> {
  const deduped = dedupeByBestPriority(entries);
  if (deduped.length === 0) return 0;
  const queuedAt = now().toISOString();
  let touched = 0;
  for (const stmt of gscRecrawlInsertStatements(db, deduped, queuedAt, source)) {
    touched += (await stmt).length;
  }
  return touched;
}

/**
 * The worklist, most important first.
 *
 * `ORDER BY priority ASC, queued_at ASC, id ASC` — exactly the composite index on
 * the table, plus the AECI-825 unique trailing term. `id` is not decoration: two
 * rows written by the same promote share a `queued_at` to the millisecond, and a
 * paginated list whose ordering is not total can drop or duplicate a row across
 * pages.
 */
export async function readPendingGscRecrawl(
  db: Db,
  limit: number = GSC_RECRAWL_PAGE_SIZE,
): Promise<PendingGscRecrawl[]> {
  return db
    .select({
      id: gscRecrawlQueue.id,
      url: gscRecrawlQueue.url,
      priority: gscRecrawlQueue.priority,
      reason: gscRecrawlQueue.reason,
      source: gscRecrawlQueue.source,
      queuedAt: gscRecrawlQueue.queuedAt,
    })
    .from(gscRecrawlQueue)
    .orderBy(asc(gscRecrawlQueue.priority), asc(gscRecrawlQueue.queuedAt), asc(gscRecrawlQueue.id))
    .limit(limit);
}

/** How many rows are waiting. Feeds the admin nav count (§5.0c). */
export async function countPendingGscRecrawl(db: Db): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(gscRecrawlQueue);
  return Number(row?.count ?? 0);
}

/**
 * Read one row by id — the Done button's pre-read.
 *
 * The handler needs the URL before it deletes, because the `audit_log` row has to
 * record *what* was cleared and the row is gone immediately afterwards. D1 does
 * not return deleted rows, and the audit statement has to be built before the
 * batch runs.
 */
export async function readGscRecrawlRow(
  db: Db,
  id: number,
): Promise<PendingGscRecrawl | undefined> {
  const [row] = await db
    .select({
      id: gscRecrawlQueue.id,
      url: gscRecrawlQueue.url,
      priority: gscRecrawlQueue.priority,
      reason: gscRecrawlQueue.reason,
      source: gscRecrawlQueue.source,
      queuedAt: gscRecrawlQueue.queuedAt,
    })
    .from(gscRecrawlQueue)
    .where(eq(gscRecrawlQueue.id, id))
    .limit(1);
  return row;
}

/**
 * Delete one row — the Done button, returned as a `BatchStmt` so it commits in
 * the SAME `db.batch` as its `audit_log` entry (§26.1).
 *
 * **By `id` alone, and a concurrency guard was considered and rejected.** The
 * worry is the obvious one: the operator reads the list, something changes, they
 * click Done and clear work they never saw. Both ways that can happen turn out to
 * be safe.
 *
 * A row that was cleared by someone else is **gone**, and `id` is `AUTOINCREMENT`
 * so SQLite never reuses it. A re-queue of the same URL therefore mints a new id,
 * and the stale click 404s rather than hitting the new row.
 *
 * A row that was *re-prioritised* by a second event — the `DO UPDATE` path — keeps
 * its id and its `queued_at`, and clearing it is **correct**. It is the same URL.
 * The operator pasted that URL into Search Console and asked Google to re-fetch
 * the page, which satisfies the first event and the second one equally: Google
 * fetches the page as it is now, not as it was when the row was queued. Scoping
 * the delete on `queued_at` would leave a row behind demanding a second,
 * identical submission against a capped quota.
 */
export function deleteGscRecrawlRow(db: Db, id: number): BatchStmt {
  return db.delete(gscRecrawlQueue).where(eq(gscRecrawlQueue.id, id));
}

/** Re-export so a caller needs one import rather than two. */
export type { GscRecrawlEntry, GscRecrawlReason };
