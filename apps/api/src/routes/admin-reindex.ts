/**
 * `GET /api/admin/reindex` + `DELETE /api/admin/reindex/:id` (AECI-946 / §20.2) —
 * the Google re-crawl worklist and its Done button. Plus
 * `GET /api/admin/reindex/submissions` (AECI-1188), the read-only history of
 * what we sent to search engines and why. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.11/§6, `docs/API_CONTRACTS.md` §6.10.
 *
 * ─── Why a hand-worked queue exists at all ────────────────────────────────────
 *
 * Bing and Yandex are fed automatically: the promote and vendor writes buffer
 * URLs into `indexnow_queue` and a daily cron (00:05 UTC, AECI-1136) submits
 * them in one request, highest tier first.
 * Google cannot be fed that way. Its Indexing API accepts `JobPosting` and
 * `BroadcastEvent` only, which is why AECI-747 deleted the ping we used to make,
 * and nothing has replaced it because nothing can. Search Console → URL
 * Inspection → Request Indexing is a browser action against an unpublished daily
 * quota.
 *
 * So the automation stops at *knowing what needs doing*. `gsc_recrawl_queue`
 * holds that list, this endpoint serves it in the order the quota should be
 * spent, and the operator does the last step by hand.
 *
 * ─── Admin writes are NOT rate-limited, deliberately ──────────────────────────
 *
 * The DELETE carries no `rateLimit()`, matching every other `requireAdmin()`
 * write on this surface. `docs/waf-rate-limits.md` §6.2 states the rule and the
 * reason: the admin role is hand-granted with no anonymous path to it, and every
 * write emits an `audit_log` row in the same batch, so a limiter would add no
 * protection while risking a 429 partway through exactly the workload this
 * screen exists for — clearing thirty rows in a sitting.
 */

import {
  ClearReindexRowQuerySchema,
  ListReindexQueueQuerySchema,
  ListReindexQueueResponseSchema,
  ListReindexSubmissionsQuerySchema,
  ListReindexSubmissionsResponseSchema,
  type ListReindexQueueResponse,
  type ListReindexSubmissionsQuery,
  type ListReindexSubmissionsResponse,
  type ReindexQueueRow,
  type ReindexSubmissionCause,
  type ReindexSubmissionRow,
} from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { and, asc, count, desc, eq, exists, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  auditLog,
  gscRecrawlQueue,
  products,
  recrawlSubmissionCauses,
  recrawlSubmissions,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json, noContent } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  deleteGscRecrawlRow,
  insertGscManualSubmission,
  readGscRecrawlRow,
} from '../lib/gsc-recrawl-queue';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { copyCausesToSubmissions, sweepOrphanCauses } from '../lib/recrawl-causes';
import { logToPosthog } from '../posthog';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `metadata.source` on the audit row, matching the other admin-console writes. */
const AUDIT_SOURCE = 'admin-panel';

/** `audit_log.action` for a cleared row. Dot-separated `entity.action` per the
 *  §26.1 convention. `audit_log.action` carries no CHECK, so this costs no
 *  migration — but it does need a label in
 *  `apps/web/src/app/admin/audit/audit-action-labels.ts`, or the trail renders a
 *  humanized slug. */
export const REINDEX_CLEARED_ACTION = 'reindex.cleared';

function makeForwarder(c: AdminContext): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: AUDIT_SOURCE,
    });
  };
}

/**
 * The worklist, most important first.
 *
 * Ordering is `priority ASC, queued_at ASC, id ASC` and is **not** client-
 * selectable. A worklist whose order the operator can change is a worklist whose
 * top row is no longer reliably the right next action, and the whole value of
 * this screen is that working top-down spends a capped quota well.
 *
 * The `id ASC` third term is the AECI-825 rule rather than decoration: two rows
 * written by the same promote share a `queued_at` to the millisecond, and a
 * paginated list without a unique trailing term can drop or duplicate a row
 * across page boundaries.
 */
export function createAdminReindexListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListReindexQueueQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);

    const where = query.priority ? eq(gscRecrawlQueue.priority, query.priority) : undefined;

    const [rows, totals] = await db.batch([
      db
        .select({
          id: gscRecrawlQueue.id,
          url: gscRecrawlQueue.url,
          priority: gscRecrawlQueue.priority,
          reason: gscRecrawlQueue.reason,
          source: gscRecrawlQueue.source,
          queued_at: gscRecrawlQueue.queuedAt,
        })
        .from(gscRecrawlQueue)
        .where(where)
        .orderBy(
          asc(gscRecrawlQueue.priority),
          asc(gscRecrawlQueue.queuedAt),
          asc(gscRecrawlQueue.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(gscRecrawlQueue).where(where),
    ]);

    const body: ListReindexQueueResponse = {
      data: rows as ReindexQueueRow[],
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListReindexQueueResponseSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * Mark one URL done and drop it, recording whether the operator asked Google.
 *
 * **`?outcome=` is required (AECI-1185).** `requested` means the operator ran
 * Request Indexing in Search Console. The batch then also writes one
 * `gsc_manual` row to `recrawl_submissions` and copies the row's causes onto
 * it. `not_requested` means they cleared it without asking, and no submission
 * row is written. Either way it is a record of what the operator did, never of
 * what Google did: nothing here says the page was indexed.
 *
 * **Done deletes rather than flagging**, and that is the design rather than a
 * shortcut. A `requested_at` column would mean an empty-looking screen could
 * still hold rows, so the nav badge would have to distinguish "pending" from
 * "pending and not yet dismissed" and the operator would have to trust that
 * distinction. Deleting makes an empty list mean exactly one thing. Nothing is
 * lost: a later edit to the same page inserts a fresh row.
 *
 * **No concurrency guard, deliberately.** A row someone else already cleared is
 * gone and its `AUTOINCREMENT` id is never reused, so a stale click 404s rather
 * than hitting a re-queued row. A row that was merely re-prioritised is the same
 * URL, and asking Google to re-fetch that URL satisfies both events — Google
 * fetches the page as it is now. See `deleteGscRecrawlRow`.
 *
 * **The `audit_log` row rides the SAME `db.batch` as the delete** (§26.1). This
 * is an operator action on an admin screen, so unlike the IndexNow drain's
 * scheduled delete it audits **per row** and is attributed to the admin rather
 * than to `'system'` — the drain's summary-row exception is for scheduled
 * deletions and does not reach here.
 */
export function createClearReindexRowHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const raw = c.req.param('id');
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid worklist row id', { field: 'id' });
    }

    // Validate before the pre-read, so a bad call touches nothing.
    const { outcome } = ClearReindexRowQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = writeDb(c, dbFor);

    // Pre-read, because the audit row has to record WHAT was cleared and D1 does
    // not return deleted rows. The audit statement must also be built before the
    // batch runs, so there is no way to defer this.
    const row = await readGscRecrawlRow(db, id);
    if (!row) throw notFoundError('reindex_queue_row', { id: raw });

    // One UUID per `requested` clear. It ties the submission row to this audit
    // row (`metadata.batchId`), the same join the IndexNow drain uses.
    const batchId = outcome === 'requested' ? crypto.randomUUID() : undefined;

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: REINDEX_CLEARED_ACTION,
      entityType: 'gsc_recrawl_queue',
      entityId: String(row.id),
      beforeState: {
        url: row.url,
        priority: row.priority,
        reason: row.reason,
        source: row.source,
        queued_at: row.queuedAt,
      },
      metadata: { source: AUDIT_SOURCE, outcome, ...(batchId ? { batchId } : {}) },
    };

    // Order is load-bearing. The submission insert reads the queue row, so it
    // runs before the delete. The cause copy joins on the submission row, so it
    // follows the insert. The sweep runs after the delete so it sees the URL
    // gone, and removes the transient causes the copy just made permanent.
    const stmts: BatchStmt[] = [
      ...(batchId
        ? [
            insertGscManualSubmission(db, row.id, {
              batchId,
              submittedAt: new Date().toISOString(),
            }),
            copyCausesToSubmissions(db, 'gsc', batchId),
          ]
        : []),
      deleteGscRecrawlRow(db, row.id),
      sweepOrphanCauses(db, 'gsc'),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);

    c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));

    return noContent();
  };
}

// ─── Submission history (AECI-1188) ───────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The first instant of a UTC day, as `submitted_at` stores it. */
function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** The first instant of the next UTC day, so `to` is inclusive. */
function dayAfter(day: string): string {
  return new Date(Date.parse(dayStart(day)) + DAY_MS).toISOString();
}

/**
 * The page predicate, on `recrawl_submissions`. Exported so the spec can pin its
 * shape and its bound parameters.
 *
 * The vendor filter is an `EXISTS` over the cause rows, not a join: a submission
 * with two causes from the same vendor must still be ONE row, and the count must
 * count submissions. The `(vendor_id, submission_id)` index serves it.
 */
export function adminReindexSubmissionsWhere(
  query: Omit<ListReindexSubmissionsQuery, 'page' | 'perPage'>,
  db: Pick<Db, 'select'>,
): SQL | undefined {
  const parts: SQL[] = [];
  if (query.channel) parts.push(eq(recrawlSubmissions.channel, query.channel));
  if (query.outcome) parts.push(eq(recrawlSubmissions.outcome, query.outcome));
  if (query.from) parts.push(gte(recrawlSubmissions.submittedAt, dayStart(query.from)));
  if (query.to) parts.push(lt(recrawlSubmissions.submittedAt, dayAfter(query.to)));
  if (query.vendorId) {
    parts.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(recrawlSubmissionCauses)
          .where(
            and(
              eq(recrawlSubmissionCauses.submissionId, recrawlSubmissions.id),
              eq(recrawlSubmissionCauses.vendorId, query.vendorId),
            ),
          ),
      ),
    );
  }
  return parts.length ? and(...parts) : undefined;
}

/**
 * The submission history: one row per submission, newest first, each with ALL
 * its causes.
 *
 * Two reads. The page of submissions and its total run in one `db.batch`. The
 * causes then load in a second query bounded by that page's submission ids, so
 * a page of N rows binds at most N parameters (`perPage` caps at 100, under
 * D1's bound-parameter limit). A cause query is skipped on an empty page.
 *
 * `audit_log`, `vendors` and `products` are LEFT joins: a promote cause has no
 * audit id and no vendor, and a vendor or product may have been deleted since.
 * The cause keeps its ids either way, so the row still renders.
 *
 * Order is `submitted_at DESC, id DESC`. One drain run shares one
 * `submitted_at`, so the id term keeps page boundaries stable. Causes come back
 * in `queued_at ASC, id ASC` order. All are timestamp or integer orderings, so
 * they stay BINARY (`API_CONTRACTS.md` §3.2).
 *
 * A read: no `audit_log` row, no `rateLimit()` (ADR 0026, reads are never
 * limited).
 */
export function createAdminReindexSubmissionsHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListReindexSubmissionsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = adminReindexSubmissionsWhere(query, db);

    const [rows, totals] = await db.batch([
      db
        .select({
          id: recrawlSubmissions.id,
          url: recrawlSubmissions.url,
          channel: recrawlSubmissions.channel,
          outcome: recrawlSubmissions.outcome,
          httpStatus: recrawlSubmissions.httpStatus,
          priority: recrawlSubmissions.priority,
          submittedAt: recrawlSubmissions.submittedAt,
        })
        .from(recrawlSubmissions)
        .where(where)
        .orderBy(desc(recrawlSubmissions.submittedAt), desc(recrawlSubmissions.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(recrawlSubmissions).where(where),
    ]);

    const causesBySubmission = new Map<number, ReindexSubmissionCause[]>();
    if (rows.length > 0) {
      const causeRows = await db
        .select({
          submissionId: recrawlSubmissionCauses.submissionId,
          source: recrawlSubmissionCauses.source,
          auditLogId: recrawlSubmissionCauses.auditLogId,
          action: auditLog.action,
          vendorId: recrawlSubmissionCauses.vendorId,
          vendorSlug: vendors.slug,
          vendorName: vendors.companyName,
          productId: recrawlSubmissionCauses.productId,
          productSlug: products.slug,
          productName: products.name,
          promoteJobId: recrawlSubmissionCauses.promoteJobId,
          queuedAt: recrawlSubmissionCauses.queuedAt,
        })
        .from(recrawlSubmissionCauses)
        .leftJoin(auditLog, eq(auditLog.id, recrawlSubmissionCauses.auditLogId))
        .leftJoin(vendors, eq(vendors.id, recrawlSubmissionCauses.vendorId))
        .leftJoin(products, eq(products.id, recrawlSubmissionCauses.productId))
        .where(
          inArray(
            recrawlSubmissionCauses.submissionId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(recrawlSubmissionCauses.queuedAt), asc(recrawlSubmissionCauses.id));

      for (const r of causeRows) {
        const list = causesBySubmission.get(r.submissionId) ?? [];
        list.push({
          source: r.source,
          audit_log_id: r.auditLogId,
          action: r.action,
          vendor: r.vendorId ? { id: r.vendorId, slug: r.vendorSlug, name: r.vendorName } : null,
          product: r.productId
            ? { id: r.productId, slug: r.productSlug, name: r.productName }
            : null,
          promote_job_id: r.promoteJobId,
          queued_at: r.queuedAt,
        });
        causesBySubmission.set(r.submissionId, list);
      }
    }

    const body: ListReindexSubmissionsResponse = {
      data: rows.map(
        (r): ReindexSubmissionRow => ({
          id: r.id,
          url: r.url,
          channel: r.channel as ReindexSubmissionRow['channel'],
          outcome: r.outcome as ReindexSubmissionRow['outcome'],
          http_status: r.httpStatus,
          priority: r.priority,
          submitted_at: r.submittedAt,
          causes: causesBySubmission.get(r.id) ?? [],
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => ListReindexSubmissionsResponseSchema.parse(body));
    return json(body);
  };
}
