/**
 * `GET /api/admin/reindex` + `DELETE /api/admin/reindex/:id` (AECI-946 / §20.2) —
 * the Google re-crawl worklist and its Done button. Source of truth:
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
  type ListReindexQueueResponse,
  type ReindexQueueRow,
} from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { asc, count, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { gscRecrawlQueue } from '../db/schema';
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
