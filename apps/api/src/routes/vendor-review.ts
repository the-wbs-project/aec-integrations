/**
 * "Looks right" (AECI-1216 / `STAGE_2_PAID_TIERS_SPEC.md` §13.8 and §13.9) — Drizzle/D1.
 *
 *   POST /api/vendor/profile/review                    — confirm company details.
 *   POST /api/vendor/products/:id/review               — confirm one owned product.
 *   POST /api/vendor/products/:id/integrations/review  — confirm its integration list.
 *
 * Each records "checked, nothing to change". The two edit schemas refuse an empty
 * save, so without these routes a vendor whose record is already right has no way to
 * say so, and the public marker and the checklist both keep reading "never checked".
 *
 * ── Gates ──────────────────────────────────────────────────────────────────────
 * Seat-only, on every plan (§13.1 decision 7). Registered `requireVendor()` →
 * `rateLimit('write')` in `index.ts`. No `requireCapability`: a review is not an
 * edit, so no plan is needed. The two product routes prove ownership FIRST, before
 * the body is even read, and a foreign product is a flat 404, as on every other
 * product route (`requireOwnedProduct`).
 *
 * ── What each one writes ──────────────────────────────────────────────────────
 * Company and product: the AECI-981 maintenance transfer, exactly as an edit does
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9). `maintained_by = 'vendor'` and a fresh
 * `last_reviewed_at`, on that one row, never transitively.
 *
 * Integration list (§13.9): `products.integrations_reviewed_at`, plus
 * `last_reviewed_at` on the rows touching this product that the caller ALREADY
 * maintains. {@link ownedMaintainedIntegrationsWhere} is that rule. It never stamps
 * an AECi-maintained row or another vendor's row, and it never writes
 * `maintained_by`, so maintenance cannot move through this route.
 *
 * Every write and its one `audit_log` row ride one `db.batch` (§26.1). The tail is
 * `afterVendorWrite`: the PostHog forward and the Cache-Tag purge. No `recrawl`
 * argument, on purpose. No content changed, so there is nothing for a crawler to
 * re-fetch (§13.8). That also keeps these routes out of AECI-1186.
 */

import {
  ReviewVendorProductIntegrationsResponseSchema,
  ReviewVendorProductResponseSchema,
  ReviewVendorProfileResponseSchema,
  ReviewVendorRecordSchema,
  type ReviewVendorProductIntegrationsResponse,
  type ReviewVendorProductResponse,
  type ReviewVendorProfileResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { liveEvidencedPairOn, liveIntegrationOn } from '../lib/live-integration';
import { NO_TAXONOMY, productEditTags } from './vendor';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  isMaintenanceTransfer,
  maintenanceTransferColumns,
  productMaintenanceTransfer,
  requireOwnedProduct,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** `metadata.reason` on every "Looks right" audit row, so one grep finds them all. */
export const LOOKS_RIGHT_REASON = 'looks-right';

/** The three audit actions, named by §13.8. */
export const VENDOR_REVIEWED_ACTION = 'vendor.reviewed';
export const PRODUCT_REVIEWED_ACTION = 'product.reviewed';
export const PRODUCT_INTEGRATIONS_REVIEWED_ACTION = 'product.integrations_reviewed';

/**
 * Read the body: an empty JSON object, or no body at all.
 *
 * A missing body is accepted because the call carries no information. Requiring a
 * `{}` would only make a bare `fetch(url, { method: 'POST' })` a 400. Anything that
 * is not the empty object is refused by `ReviewVendorRecordSchema`'s `.strict()`.
 */
async function parseReviewBody(c: VendorContext): Promise<void> {
  const text = await c.req.text();
  if (text.trim() === '') return;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  ReviewVendorRecordSchema.parse(raw);
}

/** The route's product id, or a 400 when the router somehow delivered none. */
function productIdParam(c: VendorContext): string {
  const productId = c.req.param('id');
  if (!productId) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
  }
  return productId;
}

// ─── POST /api/vendor/profile/review ─────────────────────────────────────────

export function createReviewVendorProfileHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    await parseReviewBody(c);

    const { db } = writeDb(c, dbFor);
    const before = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!before) throw notFoundError('vendor', { id: vendorId });

    // `updatedAt` is stamped explicitly, as the profile PATCH does. It is what moves
    // the `profile` cursor on `GET /api/vendor/updates`, so a second open tab sees
    // the review without a reload.
    const now = new Date().toISOString();
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: VENDOR_REVIEWED_ACTION,
      entityType: 'vendor',
      entityId: vendorId,
      // The maintenance pair IS the whole change, so unlike the PATCH it is the diff.
      beforeState: { maintained_by: before.maintainedBy, last_reviewed_at: before.lastReviewedAt },
      afterState: { maintained_by: 'vendor', last_reviewed_at: now },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        reason: LOOKS_RIGHT_REASON,
        // Present only on the save that changes hands, as on every other writer.
        ...(isMaintenanceTransfer(before) ? { maintenanceTransfer: true } : {}),
      },
    };

    await db.batch([
      db
        .update(vendors)
        .set({ ...maintenanceTransferColumns(now), updatedAt: now })
        .where(eq(vendors.id, vendorId)),
      auditInsert(db, audit),
    ] as BatchTuple);

    // `vendor:{slug}`, the profile PATCH's tag. Every page that shows the vendor
    // embeds it, and the marker renders on the vendor page header.
    afterVendorWrite(c, [`vendor:${before.slug}`], audit);

    const body: ReviewVendorProfileResponse = { last_reviewed_at: now };
    validateResponseInDev(c.env, () => ReviewVendorProfileResponseSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/vendor/products/:id/review ────────────────────────────────────

export function createReviewVendorProductHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const { db } = writeDb(c, dbFor);

    // Ownership first, in its own wave: a foreign product is a 404 before the body
    // is read, so a 400 can never confirm that someone else's product exists.
    const { product: before } = await requireOwnedProduct(db, vendorId, productId);
    await parseReviewBody(c);

    const now = new Date().toISOString();
    // The same statement the version handlers use for the transfer. It sets no
    // `updated_at`, and `$onUpdate` still restamps it, which moves the `products`
    // cursor (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9 consequence 4).
    const { stmt, audit } = productMaintenanceTransfer(
      db,
      session,
      auditActorType(session),
      before,
      now,
      { vendorId },
      { action: PRODUCT_REVIEWED_ACTION, reason: LOOKS_RIGHT_REASON },
    );
    await db.batch([stmt, auditInsert(db, audit)] as BatchTuple);

    // `productEditTags` with no facet change: `product:{slug}` and `index:products`.
    // No facet moved, so no browse page gains or loses the product, and each one
    // that lists it already carries `product:{slug}`. Passing the empty taxonomy on
    // both sides saves the four facet reads an edit needs.
    afterVendorWrite(c, productEditTags(before.slug, NO_TAXONOMY, NO_TAXONOMY), audit);

    const body: ReviewVendorProductResponse = { product_id: productId, last_reviewed_at: now };
    validateResponseInDev(c.env, () => ReviewVendorProductResponseSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/vendor/products/:id/integrations/review ───────────────────────

/**
 * The §13.9 row-selection rule on `integrations`: live rows touching `productId`
 * (as source, target, or the connector that powers them) that `vendorId` both
 * built and already maintains.
 *
 * Both halves of the ownership test are required. `built_by_vendor_id` alone would
 * stamp a row AECi maintains, which is a maintenance transfer this route must never
 * make. `maintained_by` alone would stamp a row another vendor maintains through an
 * attestation. Retired rows are left alone: they are off the public list, so there
 * is no list entry being confirmed.
 *
 * Exported so the spec can pin the rule directly, and so a future checklist read
 * (AECI-1217) can count the same set.
 */
export function ownedMaintainedIntegrationsWhere(vendorId: string, productId: string): SQL {
  return and(
    eq(integrations.builtByVendorId, vendorId),
    eq(integrations.maintainedBy, 'vendor'),
    liveIntegrationOn(integrations),
    or(
      eq(integrations.sourceProductId, productId),
      eq(integrations.targetProductId, productId),
      eq(integrations.poweredByProductId, productId),
    ),
  )!;
}

/** {@link ownedMaintainedIntegrationsWhere} on `connector_evidenced_pairs`. */
export function ownedMaintainedEvidencedPairsWhere(vendorId: string, productId: string): SQL {
  return and(
    eq(connectorEvidencedPairs.builtByVendorId, vendorId),
    eq(connectorEvidencedPairs.maintainedBy, 'vendor'),
    liveEvidencedPairOn(connectorEvidencedPairs),
    or(
      eq(connectorEvidencedPairs.productAId, productId),
      eq(connectorEvidencedPairs.productBId, productId),
      eq(connectorEvidencedPairs.connectorProductId, productId),
    ),
  )!;
}

/** The ids each table's stamp will touch, read before the batch for the audit row. */
async function loadStampIds(
  db: Db,
  vendorId: string,
  productId: string,
): Promise<{ integrationIds: string[]; evidencedPairIds: string[] }> {
  const [rows, pairs] = await Promise.all([
    db
      .select({ id: integrations.id })
      .from(integrations)
      .where(ownedMaintainedIntegrationsWhere(vendorId, productId)),
    db
      .select({ id: connectorEvidencedPairs.id })
      .from(connectorEvidencedPairs)
      .where(ownedMaintainedEvidencedPairsWhere(vendorId, productId)),
  ]);
  // Sorted so the audit metadata and the purge tag list are stable across runs.
  // Ids are UUIDs, so a binary sort is the right one here.
  return {
    integrationIds: rows.map((r) => r.id).sort(),
    evidencedPairIds: pairs.map((r) => r.id).sort(),
  };
}

export function createReviewVendorProductIntegrationsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const { db } = writeDb(c, dbFor);

    const { product: before } = await requireOwnedProduct(db, vendorId, productId);
    await parseReviewBody(c);

    // The audit row has to name the stamped ids, and it is built before the batch
    // runs, so the ids are read first. Each UPDATE then repeats the full rule AND
    // pins the ids it read. That keeps the stamped set a subset of the audited set:
    // a row that changed hands in between (a seat hand-back, say) is skipped, and a
    // row that newly qualified in between is not stamped unaudited.
    const { integrationIds, evidencedPairIds } = await loadStampIds(db, vendorId, productId);

    const now = new Date().toISOString();
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: PRODUCT_INTEGRATIONS_REVIEWED_ACTION,
      entityType: 'product',
      entityId: productId,
      beforeState: { integrations_reviewed_at: before.integrationsReviewedAt },
      afterState: { integrations_reviewed_at: now },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        reason: LOOKS_RIGHT_REASON,
        integrationIds,
        evidencedPairIds,
      },
    };

    // `products.updated_at` moves through `$onUpdate`, and the integration rows' own
    // `updated_at` likewise. Those move the `products` and `integrations` cursors.
    // `maintained_by` is in none of these `set`s: §13.9 forbids moving it here.
    const stmts: BatchStmt[] = [
      db.update(products).set({ integrationsReviewedAt: now }).where(eq(products.id, productId)),
    ];
    if (integrationIds.length > 0) {
      stmts.push(
        db
          .update(integrations)
          .set({ lastReviewedAt: now })
          .where(
            and(
              ownedMaintainedIntegrationsWhere(vendorId, productId),
              inArray(integrations.id, integrationIds),
            ),
          ),
      );
    }
    if (evidencedPairIds.length > 0) {
      stmts.push(
        db
          .update(connectorEvidencedPairs)
          .set({ lastReviewedAt: now })
          .where(
            and(
              ownedMaintainedEvidencedPairsWhere(vendorId, productId),
              inArray(connectorEvidencedPairs.id, evidencedPairIds),
            ),
          ),
      );
    }
    stmts.push(auditInsert(db, audit));
    await db.batch(stmts as BatchTuple);

    // `product:{slug}` plus each stamped row's `integration:{id}`. Every pair page
    // embeds both of its products, so `product:{slug}` reaches the pair pages too.
    // The `integration:` tags reach the OTHER products' pages, whose integration
    // lists embed each row they show (§13.8).
    const tags = [
      `product:${before.slug}`,
      ...[...integrationIds, ...evidencedPairIds].map((id) => `integration:${id}`),
    ];
    afterVendorWrite(c, tags, audit);

    const body: ReviewVendorProductIntegrationsResponse = {
      product_id: productId,
      integrations_reviewed_at: now,
      stamped_count: integrationIds.length + evidencedPairIds.length,
    };
    validateResponseInDev(c.env, () => ReviewVendorProductIntegrationsResponseSchema.parse(body));
    return json(body);
  };
}
