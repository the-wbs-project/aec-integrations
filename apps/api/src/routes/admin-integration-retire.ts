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
 * Six rules of its own. Everything else is the owner retire's batch, shared through
 * `integration-retire-write.ts`.
 *
 * 1. **Admin only, rate-limited after the guard.** `requireAdmin()` then
 *    `rateLimit('write')` at registration. A required `reason` (1 to 1000 characters)
 *    goes into the audit row. It is not shown to any vendor.
 * 2. **Vendor-held rows only.** An AECi-held row answers
 *    `409 INTEGRATION_NOT_VENDOR_HELD`: promote, the review app and the retraction
 *    tools own it, and retiring it here would hide a row the next promote still writes.
 *    Connector-powered rows are not refused: an admin needs no such fence.
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
 * 6. **Both anchor tables (AECI-1091, ruling D).** The `:id` may name a
 *    `connector_evidenced_pairs` row. The same five rules hold there: vendor-held
 *    only (`claimed_at` or `origin = 'vendor'` on the pair), the same cross-refusal,
 *    a soft retire of `retired_at` / `retired_by` and never a delete, because the
 *    table cascades into `claims` and on into `attestations`
 *    (`buildPairRetireBatch`). The pair's audit rows use entity type
 *    `connector_evidenced_pair`, the recount covers the connector too, and the
 *    connector's `product:` tag is purged.
 */

import {
  AdminRetireIntegrationBodySchema,
  AdminVendorIntegrationsQuerySchema,
  AdminVendorIntegrationsResponseSchema,
  ApiErrorCode,
  effectiveRetiredBy,
  RetireIntegrationResponseSchema,
  type AdminVendorIntegrationRow,
  type AdminVendorIntegrationsResponse,
  type RetireIntegrationResponse,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, isNotNull, or } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { connectorEvidencedPairs, integrations, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isVendorHeld } from '../lib/integration-claims';
import { pairPathFor } from '../lib/integration-contests';
import { vendorHeldEvidencedPairWhere, vendorHeldIntegrationWhere } from '../lib/integration-twins';
import { isRetireRaceError, openContestsOn } from '../lib/integration-retire';
import { integrationRetiredError, isLiveIntegration } from '../lib/live-integration';
import {
  endpointVendorIds,
  locateRetireTarget,
  relocateRetireTarget,
  retireSlugs,
  retireTargetOf,
  type RetireTarget,
} from '../lib/retire-target';
import {
  afterRetireCommit,
  buildPairRetireBatch,
  buildRetireBatch,
  type RetireBatch,
  type RetireMode,
} from './integration-retire-write';
import { parseJsonBody, type VendorContext } from './vendor-shared';

/** `metadata.source` on the audit rows and the PostHog forward, as every admin write tags it. */
export const ADMIN_RETIRE_AUDIT_SOURCE = 'admin-moderation';

/**
 * Why an admin cannot retire or restore this row, or `null` when it can. Shared by
 * the pre-check and the lost-race re-read. One ladder for both anchor tables.
 */
export function adminRetireRefusal(
  row: Pick<RetireTarget, 'claimedAt' | 'origin' | 'retiredAt' | 'retiredBy'>,
  mode: RetireMode,
): ApiError | null {
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

    // Either table (AECI-1091): `integrations` first, then the pair table.
    const located = await locateRetireTarget(db, integrationId);
    if (!located) throw notFoundError('integration', { id: integrationId });
    const target = retireTargetOf(located);
    const refusal = adminRetireRefusal(target, mode);
    if (refusal) throw refusal;

    const [owner, endpointVendors, slugs, contests] = await Promise.all([
      target.builtByVendorId
        ? db.query.vendors.findFirst({
            columns: { id: true, slug: true, companyName: true },
            where: eq(vendors.id, target.builtByVendorId),
          })
        : Promise.resolve(undefined),
      endpointVendorIds(db, located),
      retireSlugs(db, located),
      // Either anchor: a pair's contests sit on `evidenced_pair_id` (AECI-1092).
      mode === 'retire'
        ? openContestsOn(db, { kind: located.anchor, id: integrationId })
        : Promise.resolve([]),
    ]);

    // The owner and every vendor of either endpoint. The owner did not act, so it is
    // told too.
    const recipients = [...new Set([...(owner ? [owner.id] : []), ...endpointVendors])].sort();

    const now = new Date().toISOString();
    const common = {
      mode,
      now,
      actor: { actorId: session.userId, actorType: auditActorType(session) },
      retiredBy: 'aeci' as const,
      source: ADMIN_RETIRE_AUDIT_SOURCE,
      metadata: { reason },
      actingVendorId: null,
      recipients,
      owner: { id: owner?.id ?? null, name: owner?.companyName ?? null },
      pairSlugs: slugs.pairSlugs,
    };
    const batch: RetireBatch =
      located.anchor === 'integration'
        ? buildRetireBatch(db, {
            ...common,
            row: located.row,
            guard: and(
              or(isNotNull(integrations.claimedAt), eq(integrations.origin, 'vendor')),
              mode === 'restore' ? eq(integrations.retiredBy, 'aeci') : undefined,
            )!,
            contests,
          })
        : buildPairRetireBatch(db, {
            ...common,
            pair: located.pair,
            contests,
            guard: and(
              vendorHeldEvidencedPairWhere,
              mode === 'restore' ? eq(connectorEvidencedPairs.retiredBy, 'aeci') : undefined,
            )!,
          });

    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (!isRetireRaceError(error)) throw error;
      const current = await relocateRetireTarget(db, located);
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        adminRetireRefusal(retireTargetOf(current), mode) ??
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
      pairSlugs: slugs.pairSlugs,
      connectorSlug: slugs.connectorSlug,
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

/** Vendor-held rows one vendor owns, across both tables, before paging. */
async function loadVendorHeldRows(db: Db, vendorId: string): Promise<AdminVendorIntegrationRow[]> {
  const endpoint = { columns: { id: true, slug: true, name: true } } as const;
  const rowColumns = {
    id: true,
    name: true,
    origin: true,
    claimedAt: true,
    retiredAt: true,
    retiredBy: true,
    updatedAt: true,
  } as const;
  const [rows, pairs] = await Promise.all([
    db.query.integrations.findMany({
      columns: rowColumns,
      with: { sourceProduct: endpoint, targetProduct: endpoint },
      where: and(eq(integrations.builtByVendorId, vendorId), vendorHeldIntegrationWhere),
    }),
    db.query.connectorEvidencedPairs.findMany({
      columns: rowColumns,
      with: { productA: endpoint, productB: endpoint, connectorProduct: endpoint },
      where: and(
        eq(connectorEvidencedPairs.builtByVendorId, vendorId),
        vendorHeldEvidencedPairWhere,
      ),
    }),
  ]);
  const common = (row: (typeof rows)[number] | (typeof pairs)[number]) => ({
    id: row.id,
    name: row.name,
    origin: row.origin === 'vendor' ? ('vendor' as const) : ('aeci' as const),
    claimed_at: row.claimedAt,
    retired_at: row.retiredAt,
    retired_by: effectiveRetiredBy({ retired_at: row.retiredAt, retired_by: row.retiredBy }),
    updated_at: row.updatedAt,
  });
  return [
    ...rows.map(
      (row): AdminVendorIntegrationRow => ({
        ...common(row),
        anchor: 'integration',
        source: row.sourceProduct,
        target: row.targetProduct,
        connector: null,
        pair_path: pairPathFor([row.sourceProduct.slug, row.targetProduct.slug]),
      }),
    ),
    ...pairs.map(
      (pair): AdminVendorIntegrationRow => ({
        ...common(pair),
        anchor: 'evidenced_pair',
        source: pair.productA,
        target: pair.productB,
        connector: pair.connectorProduct,
        pair_path: pairPathFor([pair.productA.slug, pair.productB.slug]),
      }),
    ),
  ];
}

/** The sort key: the row's name, with an unnamed row first, as the SQL
 *  `textAsc(name)` this replaced put a NULL first. */
function sortName(row: AdminVendorIntegrationRow): string {
  return row.name ?? '';
}

/**
 * The vendor-held integrations a vendor owns, live and retired, in BOTH anchor
 * tables since AECI-1091: the list the admin retire and restore act from. Read-only,
 * no audit row (§9.3).
 *
 * Paged in memory. The two tables cannot share one SQL `ORDER BY` without a
 * compound select, and the set is small: a vendor's own vendor-held rows (34 owners
 * across both tables held 126 rows in production on 2026-09-23). The order is name
 * case-insensitively (`compareText`, never a bare sort), then id (BINARY), so paging
 * stays stable and case never decides it.
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

    const all = (await loadVendorHeldRows(db, vendorId)).sort(
      (a, b) => compareText(sortName(a), sortName(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const start = (query.page - 1) * query.perPage;

    const body: AdminVendorIntegrationsResponse = {
      data: all.slice(start, start + query.perPage),
      page: query.page,
      perPage: query.perPage,
      total: all.length,
    };
    validateResponseInDev(c.env, () => AdminVendorIntegrationsResponseSchema.parse(body));
    return json(body);
  };
}
