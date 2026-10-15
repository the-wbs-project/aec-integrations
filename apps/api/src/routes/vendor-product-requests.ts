/**
 * A vendor asks AECi to add the other product of an integration (AECI-1377,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6) — Drizzle/D1.
 *
 *   POST /api/vendor/product-requests — ask (201 `{ request }`).
 *   GET  /api/vendor/product-requests — the vendor's requests, newest first, ≤ 50.
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Rules of this
 * module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` on the POST, the §4.7.1 create's gate.
 * No capability, no plan check. The GET is never rate-limited.
 *
 * ── 2. THE CONTEXT PRODUCT IS THE CALLER'S ──────────────────────────────────
 * `context_product_id` must be a promoted product the caller's vendor holds through
 * `product_vendors`. A miss is the same `404` as "no such id", as on the create.
 *
 * ── 3. ONE OPEN REQUEST PER NAME ────────────────────────────────────────────
 * An open request of the same vendor whose name matches, trimmed and case-insensitive,
 * is `409 PRODUCT_REQUEST_EXISTS` with its id. A decided request does not block a new
 * one. The read is backed by an in-batch sentinel, so two concurrent asks for the same
 * name cannot both commit: the second rolls back and answers the same `409`.
 *
 * ── 4. ONE BATCH, NOTHING PUBLIC ────────────────────────────────────────────
 * The INSERT and its `product_request.created` audit row (ADR 0022: a request is
 * domain state). The metadata holds `context_product_id` and `has_website`, never the
 * typed name, maker, website or note: those are on the row, and the forward leaves
 * the Worker. After commit: the forward and the `product-request-alert` email. No
 * cache purge, no Algolia sync, no IndexNow: nothing public changes.
 */

import {
  ApiErrorCode,
  CreateProductRequestResponseSchema,
  CreateProductRequestSchema,
  ListVendorProductRequestsResponseSchema,
  VENDOR_PRODUCT_REQUEST_LIST_LIMIT,
  type CreateProductRequestResponse,
  type ListVendorProductRequestsResponse,
  type ProductRequestStatus,
  type VendorProductRequest,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { productRequests, products, productVendors, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { sendProductRequestAlert } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import {
  findOpenDuplicate,
  isProductRequestRaceError,
  PRODUCT_REQUEST_CREATED_ACTION,
  PRODUCT_REQUEST_ENTITY_TYPE,
  productRequestAlertKey,
  productRequestNameMatches,
} from '../lib/product-requests';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

type RequestRow = typeof productRequests.$inferSelect;

type ResolvedRef = { id: string; slug: string; name: string; logoUrl: string | null } | null;

/** The vendor's wire shape. `resolved_product` only on `added` and `already_listed`. */
export function toVendorProductRequest(
  row: RequestRow,
  resolved: ResolvedRef,
): VendorProductRequest {
  const status = row.status as ProductRequestStatus;
  const linked = status === 'added' || status === 'already_listed';
  return {
    id: row.id,
    status,
    context_product_id: row.contextProductId,
    name: row.name,
    maker: row.maker,
    website: row.website,
    body: row.body,
    created_at: row.createdAt,
    resolved_at: row.resolvedAt,
    decline_reason: status === 'declined' ? row.declineReason : null,
    resolved_product:
      linked && resolved
        ? { id: resolved.id, slug: resolved.slug, name: resolved.name, logo_url: resolved.logoUrl }
        : null,
  };
}

/** The caller's promoted product, with the name the alert shows, or `undefined`. */
async function ownPromotedProduct(
  db: Db,
  productId: string,
  vendorId: string,
): Promise<{ id: string; name: string } | undefined> {
  const [hit] = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .innerJoin(
      productVendors,
      and(eq(productVendors.productId, products.id), eq(productVendors.vendorId, vendorId)),
    )
    .where(and(eq(products.id, productId), eq(products.promotionStatus, 'promoted')))
    .limit(1);
  return hit;
}

/**
 * Aborts the create batch when the INSERT before it left this vendor with more than
 * one OPEN request of the same name: a concurrent ask committed between the duplicate
 * read and this batch. Same `json()` abort as `contestStillOpenSentinel`.
 */
function openDuplicateSentinel(db: Db, vendorId: string, name: string) {
  return db
    .select({
      guard: sql`CASE WHEN (SELECT count(*) FROM ${productRequests}
          WHERE ${productRequests.vendorId} = ${vendorId}
            AND ${productRequests.status} = 'open'
            AND ${productRequestNameMatches(name)}) > 1
        THEN json('product-request-exists') END`,
    })
    .from(ONE_ROW);
}

function requestExists(name: string, id: string | undefined): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PRODUCT_REQUEST_EXISTS,
    `You already asked us to add ${name}.`,
    { details: { request_id: id ?? null } },
  );
}

/** `POST /api/vendor/product-requests`. */
export function createVendorProductRequestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Shape: 400 for an unknown key or a field out of range.
    const payload = await parseJsonBody(c, CreateProductRequestSchema);

    // 2. The context product is the caller's, promoted. Same 404 for every miss.
    const [context, vendor] = await Promise.all([
      ownPromotedProduct(db, payload.context_product_id, vendorId),
      db.query.vendors.findFirst({
        columns: { id: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
    ]);
    if (!context) throw notFoundError('product', { id: payload.context_product_id });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    // 3. One open request per name.
    const existing = await findOpenDuplicate(db, vendorId, payload.name);
    if (existing) throw requestExists(payload.name, existing.id);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row: RequestRow = {
      id,
      vendorId,
      requestedBy: session.userId,
      contextProductId: context.id,
      name: payload.name,
      maker: payload.maker,
      // `''` is "not supplied": NULL for the website, `''` for the note.
      website: payload.website ? payload.website : null,
      body: payload.body ?? '',
      status: 'open',
      resolvedProductId: null,
      declineReason: null,
      createdAt,
      resolvedAt: null,
      resolvedById: null,
    };

    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: PRODUCT_REQUEST_CREATED_ACTION,
      entityType: PRODUCT_REQUEST_ENTITY_TYPE,
      entityId: id,
      productId: context.id,
      metadata: {
        source: AUDIT_SOURCE,
        context_product_id: context.id,
        has_website: row.website !== null,
      },
    };

    const stmts: BatchStmt[] = [
      db.insert(productRequests).values(row),
      openDuplicateSentinel(db, vendorId, payload.name),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isProductRequestRaceError(error)) throw error;
      const winner = await findOpenDuplicate(db, vendorId, payload.name);
      throw requestExists(payload.name, winner?.id);
    }

    // No tags: nothing public changed. The tail still forwards the audit row.
    afterVendorWrite(c, [], audit);

    c.executionCtx.waitUntil(
      sendProductRequestAlert(c, {
        request: {
          requestId: id,
          name: row.name,
          maker: row.maker,
          website: row.website,
          body: row.body,
          vendorName: vendor.companyName,
          contextProductName: context.name,
          requesterEmail: session.email ?? null,
        },
        dedupeKey: productRequestAlertKey(id),
        entity: { type: PRODUCT_REQUEST_ENTITY_TYPE, id },
      }).then(() => undefined),
    );

    const body: CreateProductRequestResponse = { request: toVendorProductRequest(row, null) };
    validateResponseInDev(c.env, () => CreateProductRequestResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

/** `GET /api/vendor/product-requests`. Every seat of the vendor sees every request. */
export function createListVendorProductRequestsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    const rows = await db
      .select({
        request: productRequests,
        resolvedId: products.id,
        resolvedSlug: products.slug,
        resolvedName: products.name,
        resolvedLogo: products.logoUrl,
      })
      .from(productRequests)
      .leftJoin(products, eq(products.id, productRequests.resolvedProductId))
      .where(eq(productRequests.vendorId, vendorId))
      // Newest first. `id` tiebreaks a `created_at` collision so the list is stable.
      .orderBy(desc(productRequests.createdAt), asc(productRequests.id))
      .limit(VENDOR_PRODUCT_REQUEST_LIST_LIMIT);

    const body: ListVendorProductRequestsResponse = {
      requests: rows.map((r) =>
        toVendorProductRequest(
          r.request,
          r.resolvedId && r.resolvedSlug && r.resolvedName
            ? {
                id: r.resolvedId,
                slug: r.resolvedSlug,
                name: r.resolvedName,
                logoUrl: r.resolvedLogo,
              }
            : null,
        ),
      ),
    };
    validateResponseInDev(c.env, () => ListVendorProductRequestsResponseSchema.parse(body));
    return json(body);
  };
}
