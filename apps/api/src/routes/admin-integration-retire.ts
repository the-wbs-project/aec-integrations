/**
 * Admin retire and restore of a vendor-held integration (AECI-1046 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6.4, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   POST /api/admin/integrations/:id/retire  — AECi withdraws the row (200).
 *   POST /api/admin/integrations/:id/restore — AECi brings back its own retire (200).
 *
 * Why it exists: every AECi removal tool refuses a vendor-held row (claimed, or
 * `origin = 'vendor'`) with no override, so before this the only way to act on
 * abusive or false vendor content was unaudited SQL. This is the audited path.
 *
 * Five rules of its own. Everything else is the owner retire's batch, shared through
 * `integration-retire-write.ts`.
 *
 * 1. **Admin only, rate-limited after the guard.** `requireAdmin()` then
 *    `rateLimit('write')` at registration. A required `reason` (1 to 1000 characters)
 *    goes into the audit row. It is not shown to any vendor.
 * 2. **Vendor-held rows only.** An AECi-held row answers
 *    `409 INTEGRATION_NOT_VENDOR_HELD`: promote, the review app and the retraction
 *    tools own it, and retiring it here would hide a row the next promote still writes.
 *    Connector-powered rows are not refused, because they are never vendor-held in v1
 *    (decision 9 keeps the claim off them) and an admin needs no such fence.
 * 3. **Only an admin restores an admin retire, and only that** (ruled 2026-09-22).
 *    Retire writes `retired_by = 'aeci'`. Restoring a row the owner retired answers
 *    `409 INTEGRATION_RETIRED_BY_OWNER`: the owner controls its own retire. The owner
 *    restore refuses an admin retire with `403 INTEGRATION_RETIRED_BY_AECI`.
 * 4. **Everyone on the row is told.** A `notification.sent` row
 *    (`kind: 'integration_retire'`, `retiredBy: 'aeci'`) goes to the owner vendor and
 *    to every vendor of either endpoint, in the same batch. The owner is told because,
 *    unlike an owner retire, it did not do this itself.
 * 5. **Not a delete.** Claims, attestations, links and contests are kept. A retire
 *    closes the row's open contests as withdrawn, exactly as the owner retire does.
 *    Restore reopens none.
 */

import {
  AdminRetireIntegrationBodySchema,
  AdminVendorIntegrationsQuerySchema,
  AdminVendorIntegrationsResponseSchema,
  ApiErrorCode,
  effectiveRetiredBy,
  RetireIntegrationResponseSchema,
  type AdminVendorIntegrationsResponse,
  type RetireIntegrationResponse,
} from '@aeci/shared';
import { and, asc, count, eq, isNotNull, or } from 'drizzle-orm';

import { getDb } from '../db/client';
import { integrations, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { vendorsForIntegrationSlots } from '../lib/attestation-authority';
import { type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { textAsc } from '../lib/collation';
import { isVendorHeld } from '../lib/integration-claims';
import { pairPathFor } from '../lib/integration-contests';
import { vendorHeldIntegrationWhere } from '../lib/integration-twins';
import { isRetireRaceError, openContestsOn } from '../lib/integration-retire';
import { integrationRetiredError, isLiveIntegration } from '../lib/live-integration';
import { afterRetireCommit, buildRetireBatch, type RetireMode } from './integration-retire-write';
import { endpointSlugs } from './vendor-contests';
import { parseJsonBody, type VendorContext } from './vendor-shared';

/** `metadata.source` on the audit rows and the PostHog forward, as every admin write tags it. */
export const ADMIN_RETIRE_AUDIT_SOURCE = 'admin-moderation';

type IntegrationRow = typeof integrations.$inferSelect;

/**
 * Why an admin cannot retire or restore this row, or `null` when it can. Shared by
 * the pre-check and the lost-race re-read.
 */
export function adminRetireRefusal(row: IntegrationRow, mode: RetireMode): ApiError | null {
  if (!isVendorHeld(row)) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_VENDOR_HELD,
      'AEC Integrations maintains this integration, so it is changed or removed through the review app and promote, not here.',
    );
  }
  const live = isLiveIntegration(row);
  if (mode === 'retire' && !live) return integrationRetiredError();
  if (mode === 'restore' && live) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_RETIRED,
      'This integration is not retired, so there is nothing to restore.',
    );
  }
  if (mode === 'restore' && row.retiredBy !== 'aeci') {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_RETIRED_BY_OWNER,
      'The owner retired this integration, so only the owner can restore it.',
    );
  }
  return null;
}

export function createAdminRetireIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor('retire', dbFor);
}

export function createAdminRestoreIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor('restore', dbFor);
}

function handlerFor(mode: RetireMode, dbFor: DbFactory): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const integrationId = c.req.param('id');
    if (!integrationId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    }
    const { reason } = await parseJsonBody(c, AdminRetireIntegrationBodySchema);
    const { db } = writeDb(c, dbFor);

    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, integrationId),
    });
    if (!row) throw notFoundError('integration', { id: integrationId });
    const refusal = adminRetireRefusal(row, mode);
    if (refusal) throw refusal;

    const [owner, slotVendors, pairSlugs, contests] = await Promise.all([
      row.builtByVendorId
        ? db.query.vendors.findFirst({
            columns: { id: true, slug: true, companyName: true },
            where: eq(vendors.id, row.builtByVendorId),
          })
        : Promise.resolve(undefined),
      vendorsForIntegrationSlots(db, [integrationId]),
      endpointSlugs(db, row.sourceProductId, row.targetProductId),
      mode === 'retire' ? openContestsOn(db, integrationId) : Promise.resolve([]),
    ]);

    // The owner and every vendor of either endpoint. The owner did not act, so it is
    // told too.
    const slots = slotVendors.get(integrationId)?.slots;
    const recipients = [
      ...new Set([
        ...(owner ? [owner.id] : []),
        ...(slots?.vendor_a ?? []),
        ...(slots?.vendor_b ?? []),
      ]),
    ].sort();

    const now = new Date().toISOString();
    const batch = buildRetireBatch(db, {
      mode,
      row,
      now,
      actor: { actorId: session.userId, actorType: auditActorType(session) },
      retiredBy: 'aeci',
      source: ADMIN_RETIRE_AUDIT_SOURCE,
      metadata: { reason },
      guard: and(
        or(isNotNull(integrations.claimedAt), eq(integrations.origin, 'vendor')),
        mode === 'restore' ? eq(integrations.retiredBy, 'aeci') : undefined,
      )!,
      contests,
      actingVendorId: null,
      recipients,
      owner: { id: owner?.id ?? null, name: owner?.companyName ?? null },
      pairSlugs,
    });

    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (!isRetireRaceError(error)) throw error;
      const current = await db.query.integrations.findFirst({
        where: eq(integrations.id, integrationId),
      });
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        adminRetireRefusal(current, mode) ??
        new ApiError(
          409,
          ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
          'This integration changed while you were saving. Reload and try again.',
        )
      );
    }

    afterRetireCommit(c, db, {
      mode,
      integrationId,
      productIds: batch.productIds,
      owner: owner ? { id: owner.id, slug: owner.slug } : null,
      pairSlugs,
      audits: batch.audits,
      hookPrefix: 'admin',
      syncFailureMessage: 'aeci.api.admin.retire_algolia_sync_failed',
      origin: { auditSource: ADMIN_RETIRE_AUDIT_SOURCE, purgeSource: 'moderation' },
    });

    const body: RetireIntegrationResponse = {
      integration: {
        id: integrationId,
        retired_at: batch.retiredAt,
        retired_by: batch.retiredBy,
        updated_at: now,
      },
      withdrawn_contest_ids: batch.withdrawnContestIds,
    };
    validateResponseInDev(c.env, () => RetireIntegrationResponseSchema.parse(body));
    return json(body);
  };
}

// ─── GET /api/admin/vendors/:id/integrations ─────────────────────────────────

/**
 * The vendor-held integrations a vendor owns, live and retired: the list the admin
 * retire and restore act from. Read-only, no audit row (§9.3).
 */
export function createAdminVendorIntegrationsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = c.req.param('id');
    if (!vendorId) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const query = AdminVendorIntegrationsQuerySchema.parse(c.req.query());
    const { db } = dbFor(c.env);

    const exists = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, vendorId),
    });
    if (!exists) throw notFoundError('vendor', { id: vendorId });

    const where = and(eq(integrations.builtByVendorId, vendorId), vendorHeldIntegrationWhere);
    const endpoint = { columns: { id: true, slug: true, name: true } } as const;
    const [rows, totals] = await Promise.all([
      db.query.integrations.findMany({
        columns: {
          id: true,
          name: true,
          origin: true,
          claimedAt: true,
          retiredAt: true,
          retiredBy: true,
          updatedAt: true,
        },
        with: { sourceProduct: endpoint, targetProduct: endpoint },
        where,
        // Name case-insensitively, then id: names repeat, and the id keeps paging stable.
        orderBy: [textAsc(integrations.name), asc(integrations.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(integrations).where(where),
    ]);

    const body: AdminVendorIntegrationsResponse = {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        source: row.sourceProduct,
        target: row.targetProduct,
        origin: row.origin === 'vendor' ? 'vendor' : 'aeci',
        claimed_at: row.claimedAt,
        retired_at: row.retiredAt,
        retired_by: effectiveRetiredBy({ retired_at: row.retiredAt, retired_by: row.retiredBy }),
        pair_path: pairPathFor([row.sourceProduct.slug, row.targetProduct.slug]),
        updated_at: row.updatedAt,
      })),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => AdminVendorIntegrationsResponseSchema.parse(body));
    return json(body);
  };
}
