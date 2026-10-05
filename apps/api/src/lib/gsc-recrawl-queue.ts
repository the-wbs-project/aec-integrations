/**
 * The `gsc_recrawl_queue` worklist — read and write helpers (AECI-945 / §20.2).
 *
 * The sibling of `indexnow-queue.ts`, and deliberately shaped like it so the two
 * read as a pair. Since AECI-1136 both are tiered by the same map
 * (`GSC_RECRAWL_PRIORITY`) and both let a conflict RAISE a row's tier, never
 * lower it. The differences that remain are the whole point, and there are two:
 *
 *   1. **A person drains this one.** No cron submits it. `POST /api/promote` and
 *      the vendor-portal writes APPEND; the `/admin/reindex` screen (AECI-946)
 *      READS, and its Done button DELETES one row. Google has no API that accepts
 *      our content types (AECI-747), so Search Console → Request Indexing, run by
 *      hand, is the only channel. A daily cron does *inspect* it (AECI-1236,
 *      `lib/gsc-inspect-job.ts`): it closes rows Google has already re-crawled
 *      since `last_changed_at` and tags the rest, so the person only sees rows
 *      that need them. See {@link enqueueGscRecrawl} for the conflict rule,
 *      which also carries `reason` and `source` along with the tier because an
 *      operator reads them.
 *   2. **Nothing ages out.** `indexnow_queue` has a seven-day staleness sweep
 *      because a missed ping is recoverable — the sitemap covers the URL anyway.
 *      A row dropped from *this* table is work no human ever saw. There is no
 *      `deleteStale*` here and there must not be one.
 *
 * See `db/schema.ts` → `gscRecrawlQueue` for the full rationale on why this is a
 * separate table rather than a column on `indexnow_queue`.
 */

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { gscRecrawlQueue, recrawlSubmissions } from '../db/schema';
import { isRetiredSlugUrl, listSlugRedirects, retiredSlugPaths } from './slug-redirect';

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
 * the number of bound columns per row. Six are bound here — `url`, `priority`,
 * `reason`, `source`, `queued_at`, `last_changed_at` (AECI-1236) — so 16 rows is
 * 96 parameters and a 17th row (102) is a rejected statement. It was 20 while
 * five columns were bound.
 *
 * **This is NOT `INDEXNOW_INSERT_ROWS_PER_STATEMENT` (25).** That constant is the
 * same cap divided by *four* columns, because `indexnow_queue` has a `priority`
 * (AECI-1136) but no `reason`. Copying 25 across would bind 125 parameters and fail — and it
 * would fail *only in production*, because better-sqlite3's ceiling in the
 * in-memory spec harness is 32,766, so an unchunked insert of any realistic size
 * passes every test in this repo. The specs therefore assert the emitted
 * parameter count per statement, not just that the rows landed.
 */
export const GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT = 16;

/**
 * One worklist row, as the admin screen reads it.
 *
 * The paged LIST read is deliberately NOT in this module. `GET /api/admin/reindex`
 * (`routes/admin-reindex.ts`) builds its own `select()`, because it needs the page,
 * the `?priority=` filter and the matching `COUNT(*)` in **one** `db.batch`, and a
 * helper returning rows alone cannot carry the total. Page size is the caller's
 * (`PageQuerySchema`, default 24, hard max 100). A second read helper here would be
 * a second `ORDER BY` to keep in step with that handler's.
 */
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
        lastChangedAt: queuedAt,
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
        //
        // `last_changed_at` IS refreshed (AECI-1236). The inspection run closes a
        // row only when Google crawled after this time, so it must be the newest
        // change, not the first one. And the last inspection no longer describes
        // the page, so its tags are cleared and the row goes back to the front
        // of the inspection order. `last_crawl_at` and `coverage_state` are kept:
        // they are still what Google last said, and the screen shows them.
        lastChangedAt: sql`excluded.last_changed_at`,
        inspectedAt: sql`null`,
        inspectReason: sql`null`,
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
  return (await enqueueGscRecrawlUrls(db, entries, source, now)).touched;
}

/**
 * {@link enqueueGscRecrawl}, also returning the URLs it actually wrote (AECI-1184):
 * deduped, minus the retired slugs it refuses. The recrawl cause linkage records
 * a cause for exactly these, so a cause row never describes a URL the worklist
 * did not take.
 */
export async function enqueueGscRecrawlUrls(
  db: Db,
  entries: readonly GscRecrawlEntry[],
  source: string,
  now: () => Date = () => new Date(),
): Promise<{ touched: number; urls: string[] }> {
  const deduped = dedupeByBestPriority(entries);
  if (deduped.length === 0) return { touched: 0, urls: [] };

  // AECI-978 — never queue a URL that only redirects. Google's Request Indexing
  // quota is the tightest channel we have, and this list is what an operator works
  // by hand, so a retired URL here costs a submission AND the operator's attention.
  // The sitemap and the IndexNow drain apply the same rule on their own surfaces.
  //
  // Filtered at ENQUEUE rather than at the operator's read, unlike IndexNow's:
  // this queue is drained by hand and its rows persist until cleared, so hiding a
  // row at read time would leave it in the table disagreeing with the `/admin`
  // count badge. Bounded residual: a URL queued BEFORE its mapping was seeded stays
  // on the list. The operator sees the URL and can clear it, which is the whole
  // interaction model of this queue.
  const retired = retiredSlugPaths(await listSlugRedirects(db));
  const sendable =
    retired.size === 0 ? deduped : deduped.filter((e) => !isRetiredSlugUrl(e.url, retired));
  if (sendable.length === 0) return { touched: 0, urls: [] };
  const queuedAt = now().toISOString();
  let touched = 0;
  for (const stmt of gscRecrawlInsertStatements(db, sendable, queuedAt, source)) {
    touched += (await stmt).length;
  }
  return { touched, urls: sendable.map((e) => e.url) };
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

/**
 * Log one worklist row as a manual Google request (AECI-1185) — the Done
 * button's `requested` outcome, returned as a `BatchStmt` for the clear's batch.
 *
 * `INSERT … SELECT … FROM gsc_recrawl_queue WHERE id = ?`, so the URL and tier
 * come from the row itself. It must therefore run BEFORE
 * {@link deleteGscRecrawlRow} in the same batch, and the cause copy
 * (`copyCausesToSubmissions(db, 'gsc', batchId)`) must follow it, because that
 * copy joins on the row this writes.
 *
 * `outcome` is `requested` and `http_status` is NULL: the operator asked Google
 * by hand, and nothing tells us whether Google accepted or acted on it.
 */
export function insertGscManualSubmission(
  db: Db,
  id: number,
  fields: { batchId: string; submittedAt: string },
): BatchStmt {
  return db.insert(recrawlSubmissions).select(
    db
      .select({
        id: sql<number>`NULL`.as('id'),
        url: gscRecrawlQueue.url,
        channel: sql<string>`'gsc_manual'`.as('channel'),
        outcome: sql<string>`'requested'`.as('outcome'),
        httpStatus: sql<number | null>`NULL`.as('http_status'),
        batchId: sql<string>`${fields.batchId}`.as('batch_id'),
        priority: gscRecrawlQueue.priority,
        submittedAt: sql<string>`${fields.submittedAt}`.as('submitted_at'),
      })
      .from(gscRecrawlQueue)
      .where(eq(gscRecrawlQueue.id, id)),
  );
}

/** Re-export so a caller needs one import rather than two. */
export type { GscRecrawlEntry, GscRecrawlReason };
