/**
 * Recrawl cause linkage (AECI-1184, `DATABASE_SCHEMA.md` §9.6b).
 *
 * The two re-crawl queues dedupe on `url`, so a queue row cannot say WHY a URL is
 * queued: two vendor edits to one product before the daily drain leave one row.
 * The causes live beside the queues instead, one row per (producer write, URL,
 * queue), in the transient `recrawl_queue_causes`. When a URL is submitted, its
 * causes are copied into the permanent `recrawl_submission_causes`, pointing at
 * the `recrawl_submissions` row, in the same batch as the submission itself.
 *
 * Three builders, one per lifecycle step:
 *
 *   - {@link enqueueRecrawlCauses}: a producer writes causes after its queue
 *     upsert. Post-commit and best-effort, like the upsert.
 *   - {@link copyCausesToSubmissions}: the drain (and, in AECI-1185, the admin
 *     worklist clear) copies causes onto the submission rows of one batch.
 *   - {@link sweepOrphanCauses}: every path that removes queue rows deletes the
 *     causes whose URL is no longer queued.
 *
 * **Joined by `(channel, url)`, never by queue id.** The queue upsert keeps the
 * first row's id, and a cause for a URL that was already queued must still
 * attach. URLs are byte-equal because both writes take them from the same list.
 *
 * **Known limit.** A cause written between the drain's read and its commit, for a
 * URL in the drain set, is copied onto that run's submission and then swept. Its
 * queue upsert hit the row the drain was about to delete, so that edit's URL is
 * not re-sent either. The cause record says "submitted" a few seconds before the
 * edit landed, which is the same thing the queue already does.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { recrawlQueueCauses, recrawlSubmissionCauses, recrawlSubmissions } from '../db/schema';

import type { BatchStmt, BatchTuple } from './audit';

/** Which queue a cause belongs to. `indexnow` is `indexnow_queue`, `gsc` is
 *  `gsc_recrawl_queue`. Mirrors the `recrawl_queue_causes.channel` CHECK. */
export type RecrawlCauseChannel = 'indexnow' | 'gsc';

/** Who caused the queueing. Mirrors the `recrawl_queue_causes.source` CHECK. */
export type RecrawlCauseSource = 'vendor' | 'promote' | 'admin';

/** One producer write's cause, shared by every URL it queued. */
export interface RecrawlCause {
  source: RecrawlCauseSource;
  /** The write's first `audit_log.id`. NULL for promote. */
  auditLogId: string | null;
  /** The session vendor. NULL for admin-origin and promote writes. */
  vendorId: string | null;
  /** The session vendor's own product the write touched. NULL when none. */
  productId: string | null;
  /** The promote Workflow's job id. NULL for vendor and admin writes. */
  promoteJobId: string | null;
}

/**
 * Cause rows per INSERT statement.
 *
 * Each row binds eight values (`channel`, `url`, `source`, `audit_log_id`,
 * `vendor_id`, `product_id`, `promote_job_id`, `queued_at`). D1 caps a statement
 * at 100 bound parameters, so 12 rows is 96. The in-memory harness binds far
 * more, so only a parameter-count assert guards this.
 */
export const RECRAWL_CAUSE_ROWS_PER_STATEMENT = 12;

/** The queue table each channel's causes sweep against. Static SQL: no binds. */
const QUEUE_TABLE: Record<RecrawlCauseChannel, string> = {
  indexnow: 'indexnow_queue',
  gsc: 'gsc_recrawl_queue',
};

/**
 * The INSERT statements {@link enqueueRecrawlCauses} runs, chunked to
 * {@link RECRAWL_CAUSE_ROWS_PER_STATEMENT}. Duplicate URLs collapse to one row:
 * one write is one cause per URL. Exported so a spec can assert the bound
 * parameter count per statement.
 */
export function recrawlCauseInsertStatements(
  db: Db,
  channel: RecrawlCauseChannel,
  urls: readonly string[],
  cause: RecrawlCause,
  queuedAt: string,
): BatchStmt[] {
  const unique = [...new Set(urls)];
  const stmts: BatchStmt[] = [];
  for (let i = 0; i < unique.length; i += RECRAWL_CAUSE_ROWS_PER_STATEMENT) {
    const chunk = unique.slice(i, i + RECRAWL_CAUSE_ROWS_PER_STATEMENT);
    stmts.push(
      db.insert(recrawlQueueCauses).values(
        chunk.map((url) => ({
          channel,
          url,
          source: cause.source,
          auditLogId: cause.auditLogId,
          vendorId: cause.vendorId,
          productId: cause.productId,
          promoteJobId: cause.promoteJobId,
          queuedAt,
        })),
      ),
    );
  }
  return stmts;
}

/**
 * Record why `urls` were queued on `channel`. Call it AFTER the queue upsert, with
 * exactly the URLs that upsert wrote, inside the producer's best-effort catch.
 *
 * One `db.batch`, so a write's causes land together or not at all. A throw goes
 * to the caller's catch: a lost cause costs attribution, never the write that
 * caused it, which is long committed. Returns the number of cause rows written.
 */
export async function enqueueRecrawlCauses(
  db: Db,
  channel: RecrawlCauseChannel,
  urls: readonly string[],
  cause: RecrawlCause,
  now: () => Date = () => new Date(),
): Promise<number> {
  const stmts = recrawlCauseInsertStatements(db, channel, urls, cause, now().toISOString());
  if (stmts.length === 0) return 0;
  await db.batch(stmts as BatchTuple);
  return new Set(urls).size;
}

/**
 * Copy every queued cause on `channel` onto the submission rows of `batchId`.
 *
 * `INSERT … SELECT … FROM recrawl_submissions JOIN recrawl_queue_causes`, so it
 * binds two parameters (`channel`, `batch_id`) at any run size. It must follow
 * the submission inserts in the same batch, because it reads them. A submission
 * whose URL has no cause gets no row. A URL with two causes gets two.
 *
 * The transient causes are NOT removed here. On success the caller follows with
 * {@link sweepOrphanCauses} after its queue delete. On a refusal the URLs stay
 * queued and so do their causes, which are copied again onto tomorrow's attempt.
 */
export function copyCausesToSubmissions(
  db: Db,
  channel: RecrawlCauseChannel,
  batchId: string,
): BatchStmt {
  return db.insert(recrawlSubmissionCauses).select(
    db
      .select({
        id: sql<number>`NULL`.as('id'),
        submissionId: recrawlSubmissions.id,
        source: recrawlQueueCauses.source,
        auditLogId: recrawlQueueCauses.auditLogId,
        vendorId: recrawlQueueCauses.vendorId,
        productId: recrawlQueueCauses.productId,
        promoteJobId: recrawlQueueCauses.promoteJobId,
        queuedAt: recrawlQueueCauses.queuedAt,
      })
      .from(recrawlSubmissions)
      .innerJoin(
        recrawlQueueCauses,
        and(
          eq(recrawlQueueCauses.channel, channel),
          eq(recrawlQueueCauses.url, recrawlSubmissions.url),
        ),
      )
      .where(eq(recrawlSubmissions.batchId, batchId)),
  );
}

/**
 * Delete every cause on `channel` whose URL is no longer in that channel's queue.
 *
 * Run after any delete of queue rows, in the same batch: the drain's success
 * commit, its all-retired commit and its 7-day expiry, and the admin worklist
 * clear. Sweeping by absence rather than by the deleted ids also removes a cause
 * that landed just after a drain deleted its URL's queue row. Binds one
 * parameter.
 */
export function sweepOrphanCauses(db: Db, channel: RecrawlCauseChannel): BatchStmt {
  const queue = sql.raw(`"${QUEUE_TABLE[channel]}"`);
  return db
    .delete(recrawlQueueCauses)
    .where(
      and(
        eq(recrawlQueueCauses.channel, channel),
        sql`not exists (select 1 from ${queue} q where q."url" = "recrawl_queue_causes"."url")`,
      ),
    );
}
