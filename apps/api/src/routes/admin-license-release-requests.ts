/**
 * Admin early-unassign queue (AECI-1373, E4.4; `VENDOR_SIGNUP_PROCESS.md` §2 decision
 * 11, §3 step 8; `ADMIN_PANEL_SPEC.md` §5.17), behind `requireAdmin()`:
 *
 *   GET   /api/admin/license-release-requests     — the queue, by status, newest first.
 *   PATCH /api/admin/license-release-requests/:id — approve or decline an open one.
 *
 * The GET is a read: no audit row, never rate-limited. The PATCH is registered behind
 * `rateLimit('write')`.
 *
 * ── APPROVE: THE LICENSE STAYS LIVE ─────────────────────────────────────────
 * `unassignLicenseStatements` (`lib/license.ts`, the one license writer) with its
 * audit action overridden to `license.release_approved`. The license goes back to the
 * vendor's pool unassigned, still live, with its term dates unchanged and
 * `release_at_renewal` cleared. It is NOT ended (`endLicensesStatements` is the
 * revoke). The product drops to Free, so the handler purges `product:{slug}`,
 * `index:products` and `vendor:{slug}` after commit.
 *
 * The license must still be live and on the product the owner asked about. If it
 * ended, was unassigned, or moved to another product since the ask, the approve
 * answers `409 LICENSE_NOT_ASSIGNED` and writes nothing. The operator then declines
 * the request.
 *
 * ── ONE BATCH, AND A LOST RACE ROLLS BACK ───────────────────────────────────
 *   approve: request UPDATE guarded on `status = 'open'`, its sentinel, the license
 *            UPDATE (guarded by the builder on the product and `ended_at IS NULL`),
 *            a second sentinel, the `license.release_approved` row, the mirror
 *            reconcile, and the vendor's `portal-license-release-approved-by-aeci` row.
 *   decline: request UPDATE, its sentinel, the `license.release_declined` row, and the
 *            vendor's `portal-license-release-declined-by-aeci` row with the reason.
 *
 * A sentinel aborts the whole batch when the UPDATE before it matched no row, the
 * `admin-product-requests.ts` pattern, so a lost race writes no audit row and no portal
 * row. The handler re-reads and answers `409 RELEASE_REQUEST_NOT_OPEN` (another admin
 * decided it) or `409 LICENSE_NOT_ASSIGNED` (the license moved under the approve).
 *
 * Audit rows file under the billing account (`entity_type = 'billing_account'`,
 * `metadata.license_id`), with the vendor and the request-time product stamped and the
 * plan before the write from the license pre-read.
 */

import {
  AdminLicenseReleaseRequestSchema,
  ApiErrorCode,
  DecideLicenseReleaseRequestSchema,
  ListLicenseReleaseRequestsQuerySchema,
  ListLicenseReleaseRequestsResponseSchema,
  type ListLicenseReleaseRequestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { licenseReleaseRequests, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  LICENSE_ENTITY_TYPE,
  loadVendorLicenses,
  toIsoTimestamp,
  unassignLicenseStatements,
} from '../lib/license';
import {
  changedOneRowSentinel,
  isReleaseRaceError,
  LICENSE_RELEASE_ACTION,
  LICENSE_RELEASE_ADMIN_SOURCE,
  releaseRequestSelect,
  toAdminLicenseReleaseRequest,
} from '../lib/license-release-requests';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { purgeTags } from './vendor-shared';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `GET /api/admin/license-release-requests`. */
export function createAdminLicenseReleaseRequestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListLicenseReleaseRequestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = eq(licenseReleaseRequests.status, query.status);
    // Newest first. `id` tiebreaks a `created_at` collision so pages are stable.
    const [rows, totals] = await Promise.all([
      releaseRequestSelect(db)
        .where(where)
        .orderBy(desc(licenseReleaseRequests.createdAt), asc(licenseReleaseRequests.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(licenseReleaseRequests).where(where),
    ]);

    const body: ListLicenseReleaseRequestsResponse = {
      data: rows.map(toAdminLicenseReleaseRequest),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListLicenseReleaseRequestsResponseSchema.parse(body));
    return json(body);
  };
}

function notOpen(status: string): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.RELEASE_REQUEST_NOT_OPEN,
    `Request is ${status}; only open requests can be decided.`,
  );
}

function licenseMoved(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LICENSE_NOT_ASSIGNED,
    'The license is no longer on the product the vendor asked about. Decline the request instead.',
  );
}

/** `PATCH /api/admin/license-release-requests/:id`. */
export function createDecideLicenseReleaseRequestHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing request id', {
        field: 'id',
      });
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const payload = DecideLicenseReleaseRequestSchema.parse(raw);
    const { db } = writeDb(c, dbFor);

    const [found] = await releaseRequestSelect(db)
      .where(eq(licenseReleaseRequests.id, id))
      .limit(1);
    if (!found) throw notFoundError('license_release_request', { id });
    const row = found.request;
    if (row.status !== 'open') throw notOpen(row.status);

    // The pre-read every license builder takes, and the plan the audit rows record.
    const [vendor, vendorLicenses] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, verified: true },
        where: eq(vendors.id, row.vendorId),
      }),
      loadVendorLicenses(db, row.vendorId),
    ]);

    const now = toIsoTimestamp(new Date());
    const actor = { actorId: userId, actorType: auditActorType(session) };
    const product =
      row.productId !== null && found.productSlug !== null && found.productName !== null
        ? { id: row.productId, slug: found.productSlug, name: found.productName }
        : null;
    const status = payload.action === 'approve' ? 'approved' : 'declined';
    const decisionNote = payload.action === 'decline' ? payload.reason : null;

    const requestUpdate = db
      .update(licenseReleaseRequests)
      .set({ status, decidedBy: userId, decidedAt: now, decisionNote, updatedAt: now })
      .where(and(eq(licenseReleaseRequests.id, id), eq(licenseReleaseRequests.status, 'open')));

    let stmts: BatchStmt[];
    let audits: AuditLogEntry[];
    let tags: string[] = [];

    if (payload.action === 'approve') {
      const license = vendorLicenses.find((l) => l.id === row.licenseId);
      if (
        !vendor ||
        !license ||
        license.endedAt !== null ||
        license.assignedProductId === null ||
        license.assignedProductId !== row.productId
      ) {
        throw licenseMoved();
      }
      const batch = unassignLicenseStatements(db, {
        vendorId: row.vendorId,
        now,
        actorId: actor.actorId,
        actorType: actor.actorType,
        vendorLicenses,
        vendorWasVerified: vendor.verified,
        action: LICENSE_RELEASE_ACTION.approved,
        source: LICENSE_RELEASE_ADMIN_SOURCE,
        extraMetadata: { request_id: id },
        licenseId: row.licenseId,
      });
      // The pre-read proved the license live and assigned, so the builder is never a
      // no-op here. Its batch is [license UPDATE, audit row, mirror reconcile].
      const [licenseUpdate, ...rest] = batch.stmts;
      const notice = aeciOverrideNotificationAudit(
        'portal-license-release-approved-by-aeci',
        actor,
        {
          event: 'license_release_approved',
          vendorId: row.vendorId,
          // The approve takes no reason: the notice echoes the owner's own.
          reason: row.reason,
          requestId: id,
          licenseId: row.licenseId,
          billingAccountId: row.billingAccountId,
          product,
        },
      );
      stmts = [
        requestUpdate,
        changedOneRowSentinel(db),
        licenseUpdate!,
        changedOneRowSentinel(db),
        ...rest,
        auditInsert(db, notice),
      ];
      audits = [...batch.auditEntries, notice];
      if (product) tags = [`product:${product.slug}`, 'index:products', `vendor:${vendor.slug}`];
    } else {
      const decline: AuditLogEntry = {
        ...actor,
        action: LICENSE_RELEASE_ACTION.declined,
        entityType: LICENSE_ENTITY_TYPE,
        entityId: row.billingAccountId,
        vendorId: row.vendorId,
        productId: row.productId,
        vendorPlan: licensePlanSnapshot(vendorLicenses, now),
        beforeState: { status: row.status },
        afterState: { status, decision_note: decisionNote },
        metadata: {
          source: LICENSE_RELEASE_ADMIN_SOURCE,
          license_id: row.licenseId,
          request_id: id,
        },
      };
      const notice = aeciOverrideNotificationAudit(
        'portal-license-release-declined-by-aeci',
        actor,
        {
          event: 'license_release_declined',
          vendorId: row.vendorId,
          reason: payload.reason,
          requestId: id,
          licenseId: row.licenseId,
          billingAccountId: row.billingAccountId,
          product,
        },
      );
      stmts = [
        requestUpdate,
        changedOneRowSentinel(db),
        auditInsert(db, decline),
        auditInsert(db, notice),
      ];
      audits = [decline, notice];
    }

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isReleaseRaceError(error)) throw error;
      // Which guard tripped: the request (another admin decided it) or the license.
      const [current] = await db
        .select({ status: licenseReleaseRequests.status })
        .from(licenseReleaseRequests)
        .where(eq(licenseReleaseRequests.id, id))
        .limit(1);
      if (current?.status !== 'open') throw notOpen(current?.status ?? 'gone');
      throw licenseMoved();
    }

    forwardAuditBatch(c, audits, [], LICENSE_RELEASE_ADMIN_SOURCE);
    if (tags.length > 0) c.executionCtx.waitUntil(purgeTags(c, tags, 'moderation'));

    // The response re-reads the row, so `license` shows the unassignment.
    const [after] = await releaseRequestSelect(db)
      .where(eq(licenseReleaseRequests.id, id))
      .limit(1);
    const body = toAdminLicenseReleaseRequest(after!);
    validateResponseInDev(c.env, () => AdminLicenseReleaseRequestSchema.parse(body));
    return json(body);
  };
}
