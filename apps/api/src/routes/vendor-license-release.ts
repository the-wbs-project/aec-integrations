/**
 * An owner seat asks AECi to take a license off its product early (AECI-1373, E4.4;
 * `VENDOR_SIGNUP_PROCESS.md` §2 decision 11 and §3 step 8) — Drizzle/D1.
 *
 *   POST /api/vendor/licenses/:id/release-request — ask (201 `{ request }`).
 *
 * Decision 11: a license stays on its product until renewal. Taking it off earlier is
 * an exception AECi approves, on `/admin/requests` (`ADMIN_PANEL_SPEC.md` §5.17). The
 * portal button is E5's; this is the endpoint it calls.
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration. Then
 * `requireSeatOwner()` here: buying and freeing licenses is an owner's act
 * (decision 10), so a member seat gets `403`. The vendor id comes from the session.
 *
 *   - The license is not on the caller's billing account, or does not exist: `404`,
 *     the same answer for both, so an id on another vendor reveals nothing.
 *   - Ended, or on no product: `409 LICENSE_NOT_ASSIGNED`. There is nothing to free.
 *   - An open request for it exists: `409 RELEASE_REQUEST_OPEN`, `details.request_id`.
 *     The partial unique index `license_release_requests_open_license_key` is the race
 *     guard: a concurrent ask that wins answers the loser the same `409`.
 *
 * ── ONE BATCH ────────────────────────────────────────────────────────────────
 * The INSERT and its `license.release_requested` audit row, filed under the billing
 * account (`entity_type = 'billing_account'`, `metadata.license_id`, the license
 * module's rule). The metadata never holds the typed reason: it is on the row, and the
 * forward leaves the Worker. Nothing about the license changes yet, so no purge.
 * After commit: the forward, and the `license-release-request-alert` email to
 * `SUPPORT_EMAIL`, reply-to the seat.
 */

import {
  ApiErrorCode,
  CreateLicenseReleaseRequestResponseSchema,
  CreateLicenseReleaseRequestSchema,
  type CreateLicenseReleaseRequestResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { billingAccounts, licenseReleaseRequests, licenses, products, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { sendLicenseReleaseRequestAlert } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { LICENSE_ENTITY_TYPE } from '../lib/license';
import {
  isOpenReleaseRequestConflict,
  LICENSE_RELEASE_ACTION,
  licenseReleaseAlertKey,
} from '../lib/license-release-requests';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

type RequestRow = typeof licenseReleaseRequests.$inferSelect;

/** The open request for a license, or `undefined`. */
async function findOpenRequest(db: Db, licenseId: string) {
  const [hit] = await db
    .select({ id: licenseReleaseRequests.id })
    .from(licenseReleaseRequests)
    .where(
      and(
        eq(licenseReleaseRequests.licenseId, licenseId),
        eq(licenseReleaseRequests.status, 'open'),
      ),
    )
    .limit(1);
  return hit;
}

function requestOpen(id: string | undefined): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.RELEASE_REQUEST_OPEN,
    'You already asked us to free this license. We will reply to that request.',
    { details: { request_id: id ?? null } },
  );
}

/** `POST /api/vendor/licenses/:id/release-request`. */
export function createVendorLicenseReleaseRequestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const licenseId = c.req.param('id');
    if (!licenseId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing license id', {
        field: 'id',
      });
    }
    const { db } = writeDb(c, dbFor);

    // 1. Owner seats only (decision 10).
    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can ask to free a license',
    );

    // 2. Shape: 400 for a missing or blank reason, or an unknown key.
    const payload = await parseJsonBody(c, CreateLicenseReleaseRequestSchema);

    // 3. The license is on the caller's billing account. Same 404 for every miss.
    const [found] = await db
      .select({
        id: licenses.id,
        billingAccountId: licenses.billingAccountId,
        source: licenses.source,
        endsAt: licenses.endsAt,
        endedAt: licenses.endedAt,
        assignedProductId: licenses.assignedProductId,
        productName: products.name,
        vendorName: vendors.companyName,
      })
      .from(licenses)
      .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
      .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId))
      .leftJoin(products, eq(products.id, licenses.assignedProductId))
      .where(and(eq(licenses.id, licenseId), eq(billingAccounts.vendorId, vendorId)))
      .limit(1);
    if (!found) throw notFoundError('license', { id: licenseId });

    // 4. Live and on a product, or there is nothing to free.
    if (found.endedAt !== null || found.assignedProductId === null) {
      throw new ApiError(
        409,
        ApiErrorCode.LICENSE_NOT_ASSIGNED,
        'This license is not on a product, so there is nothing to free.',
      );
    }

    // 5. One open request per license.
    const existing = await findOpenRequest(db, licenseId);
    if (existing) throw requestOpen(existing.id);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row: RequestRow = {
      id,
      licenseId,
      vendorId,
      billingAccountId: found.billingAccountId,
      productId: found.assignedProductId,
      requestedBy: session.userId,
      reason: payload.reason,
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: now,
      updatedAt: now,
    };

    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: LICENSE_RELEASE_ACTION.requested,
      entityType: LICENSE_ENTITY_TYPE,
      entityId: found.billingAccountId,
      productId: found.assignedProductId,
      metadata: { source: AUDIT_SOURCE, license_id: licenseId, request_id: id },
    };

    const stmts: BatchStmt[] = [
      db.insert(licenseReleaseRequests).values(row),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isOpenReleaseRequestConflict(error)) throw error;
      const winner = await findOpenRequest(db, licenseId);
      throw requestOpen(winner?.id);
    }

    // No tags: nothing public changed yet. The tail still forwards the audit row.
    afterVendorWrite(c, [], audit);

    c.executionCtx.waitUntil(
      sendLicenseReleaseRequestAlert(c, {
        request: {
          requestId: id,
          licenseId,
          vendorName: found.vendorName,
          productName: found.productName ?? found.assignedProductId,
          licenseSource: found.source,
          endsAt: found.endsAt,
          reason: payload.reason,
          requesterEmail: session.email ?? null,
        },
        dedupeKey: licenseReleaseAlertKey(id),
        entity: { type: LICENSE_ENTITY_TYPE, id: found.billingAccountId },
      }).then(() => undefined),
    );

    const body: CreateLicenseReleaseRequestResponse = {
      request: {
        id,
        license_id: licenseId,
        product_id: row.productId,
        status: 'open',
        reason: row.reason,
        created_at: now,
        decided_at: null,
        decision_note: null,
      },
    };
    validateResponseInDev(c.env, () => CreateLicenseReleaseRequestResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}
