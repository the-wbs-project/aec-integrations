/**
 * Admin listing request queue (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.5),
 * behind `requireAdmin()`:
 *
 *   GET   /api/admin/listing-requests     — the queue, by status, newest first, paginated.
 *   PATCH /api/admin/listing-requests/:id — resolve / reject an open request.
 *
 * Rendered as the second section of `/admin/requests`, under the corrections. A
 * listing request is a product or company a visitor typed into the claim dialog
 * because the catalog does not list it (`routes/listing-requests.ts`).
 *
 * The moderation mirrors `PATCH /api/admin/requests/:id`: a preload gate on status,
 * then one atomic `db.batch` with the guarded `UPDATE … WHERE status = 'open'` and its
 * `listing_request.resolved` / `listing_request.rejected` audit row (ADR 0022). A two-admin
 * race is a no-op update that still writes its audit, the same lean relaxation as
 * `admin-requests.ts`. No workflow rows: `listing_requests` has none (its schema comment).
 *
 * Resolving does not create the listing. The operator adds it upstream (the review
 * app, then promote) and emails the submitter to claim it. No cache purge: the rows
 * render on no public page.
 */

import {
  ApiErrorCode,
  AdminListingRequestSchema,
  ListListingRequestsQuerySchema,
  ListListingRequestsResponseSchema,
  ModerateRequestSchema,
  type AdminListingRequest,
  type ListListingRequestsResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { listingRequests } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

type ListingRow = typeof listingRequests.$inferSelect;

function toAdminListingRequest(row: ListingRow): AdminListingRequest {
  return {
    id: row.id,
    status: row.status as AdminListingRequest['status'],
    listing_name: row.listingName,
    website: row.website,
    submitter_email: row.submitterEmail,
    submitter_name: row.submitterName,
    submitter_role: row.submitterRole,
    submitter_linkedin_url: row.submitterLinkedinUrl,
    body: row.body,
    created_at: row.createdAt,
    resolved_at: row.resolvedAt,
    resolved_by: row.resolvedById,
  };
}

/** `GET /api/admin/listing-requests`. */
export function createAdminListingRequestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListListingRequestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = eq(listingRequests.status, query.status);
    // Newest first. `id` tiebreaks a `created_at` collision so pages are stable.
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(listingRequests)
        .where(where)
        .orderBy(desc(listingRequests.createdAt), asc(listingRequests.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(listingRequests).where(where),
    ]);

    const body: ListListingRequestsResponse = {
      data: rows.map(toAdminListingRequest),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => {
      ListListingRequestsResponseSchema.parse(body);
    });
    return json(body);
  };
}

/** `PATCH /api/admin/listing-requests/:id` — resolve or reject an open request. */
export function createModerateListingRequestHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing request id', { field: 'id' });
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }
    const payload = ModerateRequestSchema.parse(raw);
    const { db } = writeDb(c, dbFor);

    const [existing] = await db
      .select()
      .from(listingRequests)
      .where(eq(listingRequests.id, id))
      .limit(1);
    if (!existing) throw notFoundError('listing_request', { id });
    if (existing.status !== 'open') {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Request is ${existing.status}; only open requests can be moderated.`,
      );
    }

    const newStatus: 'resolved' | 'rejected' =
      payload.action === 'resolve' ? 'resolved' : 'rejected';
    const reason = payload.reason?.trim() ? payload.reason.trim() : null;
    const resolvedAt = new Date().toISOString();
    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action:
        payload.action === 'resolve' ? 'listing_request.resolved' : 'listing_request.rejected',
      entityType: 'listing_request',
      entityId: id,
      beforeState: { status: existing.status },
      afterState: { status: newStatus },
      metadata: { source: 'admin-moderation', ...(reason ? { reason } : {}) },
    };

    const stmts: BatchStmt[] = [
      db
        .update(listingRequests)
        .set({ status: newStatus, resolvedAt, resolvedById: userId })
        .where(and(eq(listingRequests.id, id), eq(listingRequests.status, 'open'))),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);

    forwardAuditBatch(c, [auditEntry], []);

    const body = toAdminListingRequest({
      ...existing,
      status: newStatus,
      resolvedAt,
      resolvedById: userId,
    });
    validateResponseInDev(c.env, () => {
      AdminListingRequestSchema.parse(body);
    });
    return json(body);
  };
}
