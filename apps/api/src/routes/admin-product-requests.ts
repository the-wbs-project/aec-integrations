/**
 * Admin product request queue (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6),
 * behind `requireAdmin()`:
 *
 *   GET   /api/admin/product-requests     — the queue, by status, newest first, paginated.
 *   PATCH /api/admin/product-requests/:id — decide an open request.
 *
 * A product request is a seated vendor asking AECi to add the other product of an
 * integration (`routes/vendor-product-requests.ts`). Rendered on `/admin/requests`
 * (`ADMIN_PANEL_SPEC.md` §5.16).
 *
 * ── THREE OUTCOMES ──────────────────────────────────────────────────────────
 * `added` (we created the product, then promoted it) and `already_listed` (it was in
 * the catalog under another name) both link a PROMOTED product, else
 * `422 PRODUCT_NOT_PROMOTED`. The order for `added` is create, promote, then decide.
 * `declined` carries a reason, which the vendor is shown (ruled 2026-10-15).
 *
 * ── ONE BATCH, AND A LOST RACE ROLLS BACK ───────────────────────────────────
 * The UPDATE guarded on `status = 'open'`, then `productRequestStillOpenSentinel`,
 * then the `product_request.{outcome}` audit row and the vendor's
 * `portal-product-request-decided` `notification.sent` row. **This departs from the
 * listing-request precedent on purpose.** That route lets the losing side of a
 * two-admin race commit its audit row. Here the batch also writes the vendor's portal
 * row, so a lost race would put two decisions in the vendor's feed. A lost race
 * answers `422 INVALID_STATE_TRANSITION` and writes nothing.
 *
 * After commit: the forward, and the `product-request-decided` email to the seat that
 * asked, unless that seat is gone (`lib/product-requests.ts`). No cache purge: nothing
 * public changes.
 */

import {
  AdminProductRequestSchema,
  ApiErrorCode,
  DecideProductRequestSchema,
  ListProductRequestsQuerySchema,
  ListProductRequestsResponseSchema,
  type AdminProductRequest,
  type ListProductRequestsResponse,
  type ProductRequestStatus,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { productRequests, products, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { sendProductRequestDecidedEmail, type ProductRequestDecision } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  emailProductRequestDecision,
  isProductRequestRaceError,
  PRODUCT_REQUEST_DECISION_ACTION,
  PRODUCT_REQUEST_ENTITY_TYPE,
  productRequestDecisionNotification,
  productRequestStillOpenSentinel,
  type SendProductRequestDecided,
} from '../lib/product-requests';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import type { FetchSeatEmails } from '../lib/vendor-seat-recipients';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

type RequestRow = typeof productRequests.$inferSelect;

const contextProducts = alias(products, 'context_products');
const resolvedProducts = alias(products, 'resolved_products');

type Ref = { id: string; slug: string; name: string };

interface JoinedRow {
  request: RequestRow;
  vendor: Ref | null;
  context: Ref | null;
  resolved: (Ref & { logoUrl: string | null }) | null;
}

function toAdminProductRequest(r: JoinedRow): AdminProductRequest {
  const row = r.request;
  const status = row.status as ProductRequestStatus;
  const linked = status === 'added' || status === 'already_listed';
  return {
    id: row.id,
    status,
    vendor_id: row.vendorId,
    vendor: r.vendor,
    requested_by: row.requestedBy,
    context_product_id: row.contextProductId,
    context_product: r.context,
    name: row.name,
    maker: row.maker,
    website: row.website,
    body: row.body,
    created_at: row.createdAt,
    resolved_at: row.resolvedAt,
    resolved_by: row.resolvedById,
    decline_reason: status === 'declined' ? row.declineReason : null,
    resolved_product:
      linked && r.resolved
        ? {
            id: r.resolved.id,
            slug: r.resolved.slug,
            name: r.resolved.name,
            logo_url: r.resolved.logoUrl,
          }
        : null,
  };
}

/** The joined select both handlers read through. */
function joinedSelect(db: Db) {
  return db
    .select({
      request: productRequests,
      vendorId: vendors.id,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      contextId: contextProducts.id,
      contextSlug: contextProducts.slug,
      contextName: contextProducts.name,
      resolvedId: resolvedProducts.id,
      resolvedSlug: resolvedProducts.slug,
      resolvedName: resolvedProducts.name,
      resolvedLogo: resolvedProducts.logoUrl,
    })
    .from(productRequests)
    .leftJoin(vendors, eq(vendors.id, productRequests.vendorId))
    .leftJoin(contextProducts, eq(contextProducts.id, productRequests.contextProductId))
    .leftJoin(resolvedProducts, eq(resolvedProducts.id, productRequests.resolvedProductId));
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof joinedSelect>['where']>>[number];

function toJoined(r: SelectedRow): JoinedRow {
  return {
    request: r.request,
    vendor:
      r.vendorId && r.vendorSlug && r.vendorName
        ? { id: r.vendorId, slug: r.vendorSlug, name: r.vendorName }
        : null,
    context:
      r.contextId && r.contextSlug && r.contextName
        ? { id: r.contextId, slug: r.contextSlug, name: r.contextName }
        : null,
    resolved:
      r.resolvedId && r.resolvedSlug && r.resolvedName
        ? { id: r.resolvedId, slug: r.resolvedSlug, name: r.resolvedName, logoUrl: r.resolvedLogo }
        : null,
  };
}

/** `GET /api/admin/product-requests`. */
export function createAdminProductRequestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListProductRequestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = eq(productRequests.status, query.status);
    // Newest first. `id` tiebreaks a `created_at` collision so pages are stable.
    const [rows, totals] = await Promise.all([
      joinedSelect(db)
        .where(where)
        .orderBy(desc(productRequests.createdAt), asc(productRequests.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(productRequests).where(where),
    ]);

    const body: ListProductRequestsResponse = {
      data: rows.map((r) => toAdminProductRequest(toJoined(r))),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => {
      ListProductRequestsResponseSchema.parse(body);
    });
    return json(body);
  };
}

function notOpen(status: string): ApiError {
  return new ApiError(
    422,
    ApiErrorCode.INVALID_STATE_TRANSITION,
    `Request is ${status}; only open requests can be decided.`,
  );
}

/** `PATCH /api/admin/product-requests/:id` — decide an open request. */
export function createDecideProductRequestHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendDecided: SendProductRequestDecided = sendProductRequestDecidedEmail,
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
    const payload = DecideProductRequestSchema.parse(raw);
    const { db } = writeDb(c, dbFor);

    const [found] = await joinedSelect(db).where(eq(productRequests.id, id)).limit(1);
    if (!found) throw notFoundError('product_request', { id });
    const existing = toJoined(found);
    const row = existing.request;
    if (row.status !== 'open') throw notOpen(row.status);

    // The linked product, for `added` and `already_listed`: promoted, or 422.
    let linked: (Ref & { logoUrl: string | null }) | null = null;
    if (payload.outcome !== 'declined') {
      const product = await db.query.products.findFirst({
        columns: { id: true, slug: true, name: true, logoUrl: true, promotionStatus: true },
        where: eq(products.id, payload.product_id),
      });
      if (!product || product.promotionStatus !== 'promoted') {
        throw new ApiError(
          422,
          ApiErrorCode.PRODUCT_NOT_PROMOTED,
          'Choose a product that has been promoted to the catalog.',
          { field: 'product_id' },
        );
      }
      linked = { id: product.id, slug: product.slug, name: product.name, logoUrl: product.logoUrl };
    }

    const status = payload.outcome;
    const reason = payload.outcome === 'declined' ? payload.reason : null;
    const resolvedAt = new Date().toISOString();
    const actor = { actorId: userId, actorType: auditActorType(session) };

    const audit: AuditLogEntry = {
      ...actor,
      action: PRODUCT_REQUEST_DECISION_ACTION[status],
      entityType: PRODUCT_REQUEST_ENTITY_TYPE,
      entityId: id,
      // AECI-1192: the row is about the requesting vendor and its product.
      vendorId: row.vendorId,
      productId: row.contextProductId,
      beforeState: { status: row.status },
      afterState: {
        status,
        resolved_product_id: linked?.id ?? null,
        decline_reason: reason,
      },
      metadata: { source: 'admin-moderation' },
    };
    const notification = productRequestDecisionNotification(
      'portal-product-request-decided',
      actor,
      {
        requestId: id,
        vendorId: row.vendorId,
        event: status,
        requestName: row.name,
        product: linked ? { slug: linked.slug, name: linked.name } : null,
        contextProduct: existing.context
          ? { slug: existing.context.slug, name: existing.context.name }
          : null,
        reason,
      },
    );

    const stmts: BatchStmt[] = [
      db
        .update(productRequests)
        .set({
          status,
          resolvedProductId: linked?.id ?? null,
          declineReason: reason,
          resolvedAt,
          resolvedById: userId,
        })
        .where(and(eq(productRequests.id, id), eq(productRequests.status, 'open'))),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here,
      // before the audit row and the vendor's portal row.
      productRequestStillOpenSentinel(db),
      auditInsert(db, audit),
      auditInsert(db, notification),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isProductRequestRaceError(error)) throw error;
      const [now] = await db
        .select({ status: productRequests.status })
        .from(productRequests)
        .where(eq(productRequests.id, id))
        .limit(1);
      throw notOpen(now?.status ?? 'gone');
    }

    forwardAuditBatch(c, [audit, notification], []);

    const decision: ProductRequestDecision =
      payload.outcome === 'declined'
        ? { outcome: 'declined', reason: payload.reason }
        : { outcome: payload.outcome, productName: linked!.name, productSlug: linked!.slug };
    c.executionCtx.waitUntil(
      emailProductRequestDecision(
        c,
        db,
        {
          requestId: id,
          requestName: row.name,
          vendorId: row.vendorId,
          vendorSlug: existing.vendor?.slug ?? null,
          requestedBy: row.requestedBy,
          contextProductSlug: existing.context?.slug ?? null,
          decision,
        },
        fetchSeatEmails,
        sendDecided,
      ),
    );

    const body = toAdminProductRequest({
      ...existing,
      request: {
        ...row,
        status,
        resolvedProductId: linked?.id ?? null,
        declineReason: reason,
        resolvedAt,
        resolvedById: userId,
      },
      resolved: linked,
    });
    validateResponseInDev(c.env, () => {
      AdminProductRequestSchema.parse(body);
    });
    return json(body);
  };
}
