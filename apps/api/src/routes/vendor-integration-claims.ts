/**
 * Integration ownership claim, vendor side (AECI-1005 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations/:id/claim — the recorded owner claims the row (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules of
 * this module's own:
 *
 * ── 1. A SEAT IS THE GATE, EXCEPT ON A CONNECTOR-POWERED ROW ────────────────
 * `requireVendor()` then `rateLimit('write')`, and no `requireCapability` and no
 * Verified check (AECI-1003 decision 15). The same named exception to §6.14's
 * "writes are entitlement-gated" that contests took (§11b). Who gets a seat is the
 * commercial control, not a capability on the route. **One named exception to that
 * (AECI-1040 ruling 2, AECI-1089):** the owner of a connector-powered row also needs
 * an active entitlement, checked by `hasActiveEntitlement` after ownership settles.
 * It closes `STAGE_2_SPEC.md` §8.10(6): a free §8.9 catalogue seat has no
 * entitlement row, so it cannot take over a row it owns without paying.
 *
 * ── 2. THE OWNER IS `built_by_vendor_id`, AND THERE IS NO APPROVAL ──────────
 * AECI-1003 ruled that the column names the vendor that offers the integration.
 * When it names the caller's vendor, the claim goes straight through (decision 1).
 * An integration with no owner on file cannot be claimed here: that is an
 * owner-unknown claim, which AECi approves (decision 11).
 *
 * ── 3. A MISS IS A 404, EXCEPT WHERE THE ROW IS ALREADY VISIBLE ─────────────
 * A caller that is neither the owner nor a vendor of either endpoint gets the same
 * 404 an unknown id gets. A vendor of an endpoint can already see the row in its
 * portal, so it gets the specific answer: `403 INTEGRATION_NOT_OWNER` when someone
 * else owns it, `409 INTEGRATION_OWNER_UNKNOWN` when nobody is on file.
 *
 * ── 4. CONNECTOR-POWERED ROWS, IN EITHER TABLE (AECI-1089) ──────────────────
 * AECI-1040 carved decision 9 open for owners (`STAGE_2_SPEC.md` §8.10(8)). The
 * route finds the id the way promote's `locateEdge` does: `integrations` first, then
 * `connector_evidenced_pairs`. A row is connector-powered when
 * `isConnectorPoweredEdge` says so or when it sits in the evidenced table. That test
 * is unchanged. The carve-out is a relationship test on the caller: the owner may
 * claim such a row once it holds an active entitlement, and gets
 * `403 INTEGRATION_ENTITLEMENT_REQUIRED` without one. A non-owner still gets the
 * ownership answers first. On an evidenced pair "an endpoint vendor" means a vendor
 * of `product_a_id` or `product_b_id`. The connector product's vendor is neither.
 *
 * ── 5. ONE BATCH ────────────────────────────────────────────────────────────
 * The guarded `UPDATE … WHERE claimed_at IS NULL AND built_by_vendor_id = <caller>`
 * on whichever table holds the row, then `claimRaceSentinel` immediately after it,
 * then the `integration.claimed` audit row and one `notification.sent` row per other
 * endpoint vendor. A lost race writes nothing at all and answers 409. The UPDATE also
 * performs §13.9's maintenance transfer (`maintained_by = 'vendor'`, a fresh
 * `last_reviewed_at`), which changes the pair page's marker, so the pair page and
 * both product pages are purged after commit. An evidenced pair also purges its
 * connector product's page, the tag set `ops:retract-product` uses for the same rows
 * (`CACHE_STRATEGY.md` §2).
 */

import {
  ApiErrorCode,
  ClaimIntegrationResponseSchema,
  type ClaimIntegrationResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { vendorsForIntegrationSlots } from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  claimColumns,
  claimNotificationAudit,
  claimRaceSentinel,
  INTEGRATION_CLAIMED_ACTION,
  isClaimRaceError,
} from '../lib/integration-claims';
import {
  hasActiveEntitlement,
  integrationEntitlementRequired,
  type EntitlementSession,
} from '../lib/integration-entitlement';
import { endpointSlugs } from '../lib/integration-owner-writes';
import { publicSiteBase } from '../lib/public-urls';
import { pairCacheTag } from './promote-pair';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  isMaintenanceTransfer,
  recrawlEnabled,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/**
 * The row a claim targets, from whichever table holds it. The two tables name their
 * endpoints differently (`source`/`target` against `product_a`/`product_b`), and
 * everything the claim needs reads the same on both once they are lined up here.
 */
export interface ClaimTarget {
  table: 'integrations' | 'evidenced';
  id: string;
  name: string | null;
  builtByVendorId: string | null;
  claimedAt: string | null;
  maintainedBy: string;
  lastReviewedAt: string | null;
  /** `[source, target]` on `integrations`, `[product_a, product_b]` on the pair. */
  endpointIds: readonly [string, string];
  /** The evidenced pair's `connector_product_id`. `null` on `integrations`. */
  connectorProductId: string | null;
  /** Decision 9's predicate, unchanged: `isConnectorPoweredEdge`, or any row in
   *  `connector_evidenced_pairs`. */
  connectorPowered: boolean;
}

/**
 * Find the id the way promote's `locateEdge` does (AECI-1089): `integrations` first,
 * the larger table and the common hit, then `connector_evidenced_pairs`. The
 * single-table invariant means at most one matches. The order is a cost choice only.
 */
export async function locateClaimTarget(db: Db, id: string): Promise<ClaimTarget | null> {
  const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
  if (row) {
    return {
      table: 'integrations',
      id,
      name: row.name,
      builtByVendorId: row.builtByVendorId,
      claimedAt: row.claimedAt,
      maintainedBy: row.maintainedBy,
      lastReviewedAt: row.lastReviewedAt,
      endpointIds: [row.sourceProductId, row.targetProductId],
      connectorProductId: null,
      connectorPowered: isConnectorPoweredEdge(row),
    };
  }
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  });
  if (!pair) return null;
  return {
    table: 'evidenced',
    id,
    name: pair.name,
    builtByVendorId: pair.builtByVendorId,
    claimedAt: pair.claimedAt,
    maintainedBy: pair.maintainedBy,
    lastReviewedAt: pair.lastReviewedAt,
    endpointIds: [pair.productAId, pair.productBId],
    connectorProductId: pair.connectorProductId,
    // Every evidenced pair is connector-delivered by construction (decision 9).
    connectorPowered: true,
  };
}

/** Does the caller's vendor hold either endpoint of this row through `product_vendors`? */
async function callerHoldsAnEndpoint(
  db: Db,
  vendorId: string,
  target: ClaimTarget,
): Promise<boolean> {
  const hits = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        inArray(productVendors.productId, [...target.endpointIds]),
      ),
    )
    .limit(1);
  return hits.length > 0;
}

/**
 * Why this caller cannot claim this row, or `null` when it can. Shared by the
 * pre-check and the lost-race re-read, so a race answers exactly what the pre-check
 * would have answered a moment later.
 *
 * Order: ownership (404, 403 NOT_OWNER, 409 OWNER_UNKNOWN), then the entitlement on a
 * connector-powered row (AECI-1089), then already-claimed.
 */
async function refusalFor(
  db: Db,
  vendorId: string,
  session: EntitlementSession,
  target: ClaimTarget,
): Promise<ApiError | null> {
  if (target.builtByVendorId !== vendorId) {
    if (!(await callerHoldsAnEndpoint(db, vendorId, target))) {
      return notFoundError('integration', { id: target.id });
    }
    if (target.builtByVendorId === null) {
      return new ApiError(
        409,
        ApiErrorCode.INTEGRATION_OWNER_UNKNOWN,
        'No owner is on file for this integration. Contest the owner field to ask AECi to record you as the owner.',
      );
    }
    return new ApiError(
      403,
      ApiErrorCode.INTEGRATION_NOT_OWNER,
      'Another company is recorded as the owner of this integration. Contest the owner field if that is wrong.',
    );
  }
  // AECI-1040 ruling 2: the owner of a connector-powered row needs an active
  // entitlement. Asked after ownership, so a non-owner still gets the ownership answer.
  if (target.connectorPowered && !hasActiveEntitlement(session)) {
    return integrationEntitlementRequired(session);
  }
  if (target.claimedAt !== null) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_ALREADY_CLAIMED,
      'Your company has already claimed this integration.',
    );
  }
  return null;
}

/** Every vendor of either endpoint. The integrations arm reuses the §7 slot lookup.
 *  The evidenced arm reads `product_vendors` for `product_a` and `product_b`. */
async function endpointVendorIds(db: Db, target: ClaimTarget): Promise<string[]> {
  if (target.table === 'integrations') {
    const slots = (await vendorsForIntegrationSlots(db, [target.id])).get(target.id)?.slots;
    return [...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])];
  }
  const rows = await db
    .select({ vendorId: productVendors.vendorId })
    .from(productVendors)
    .where(inArray(productVendors.productId, [...target.endpointIds]));
  return rows.map((r) => r.vendorId);
}

/** The connector product's slug, for the evidenced pair's extra purge tag. */
async function connectorSlug(db: Db, target: ClaimTarget): Promise<string | null> {
  if (!target.connectorProductId) return null;
  const row = await db.query.products.findFirst({
    columns: { slug: true },
    where: eq(products.id, target.connectorProductId),
  });
  return row?.slug ?? null;
}

/** The guarded claim UPDATE on whichever table holds the row. Keyed on the owner too:
 *  a promote that re-pointed the owner between the read and this batch must not let
 *  the old owner claim. `updated_at` moves through the column's `$onUpdate`, which is
 *  what the §2.2 freshness cursor reads on both tables. */
function guardedClaimUpdate(db: Db, target: ClaimTarget, vendorId: string, now: string): BatchStmt {
  if (target.table === 'integrations') {
    return db
      .update(integrations)
      .set(claimColumns(now))
      .where(
        and(
          eq(integrations.id, target.id),
          isNull(integrations.claimedAt),
          eq(integrations.builtByVendorId, vendorId),
        ),
      );
  }
  return db
    .update(connectorEvidencedPairs)
    .set(claimColumns(now))
    .where(
      and(
        eq(connectorEvidencedPairs.id, target.id),
        isNull(connectorEvidencedPairs.claimedAt),
        eq(connectorEvidencedPairs.builtByVendorId, vendorId),
      ),
    );
}

export function createClaimIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const integrationId = c.req.param('id');
    if (!integrationId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    }
    const { db } = writeDb(c, dbFor);

    // 1. The row, from either table, alone in its wave. An unknown id and an
    //    invisible one are both 404.
    const target = await locateClaimTarget(db, integrationId);
    if (!target) throw notFoundError('integration', { id: integrationId });

    // 2. Ownership, then the entitlement on a connector-powered row, then state.
    const refusal = await refusalFor(db, vendorId, session, target);
    if (refusal) throw refusal;

    const [owner, endpointVendors, pairSlugs, connector] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      endpointVendorIds(db, target),
      endpointSlugs(db, target.endpointIds[0], target.endpointIds[1]),
      connectorSlug(db, target),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint, except the owner itself. A third-party owner
    // (neither endpoint's vendor) therefore notifies both sides.
    const recipients = [...new Set(endpointVendors)].filter((id) => id !== vendorId).sort();

    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const evidenced = target.table === 'evidenced';
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: INTEGRATION_CLAIMED_ACTION,
        // The same entity vocabulary promote writes for each table.
        entityType: evidenced ? 'connector_evidenced_pair' : 'integration',
        entityId: integrationId,
        beforeState: {
          claimed_at: null,
          built_by_vendor_id: target.builtByVendorId,
          maintained_by: target.maintainedBy,
          last_reviewed_at: target.lastReviewedAt,
        },
        afterState: {
          claimed_at: now,
          built_by_vendor_id: vendorId,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          reason: 'owner-claim',
          // Present only on the hand-changing write, never as `false` (§13.9).
          ...(isMaintenanceTransfer(target) ? { maintenanceTransfer: true } : {}),
          // AECI-1089: present only on the carve-out, so the audit log can count
          // connector-powered claims and which table they landed in.
          ...(target.connectorPowered
            ? { connectorPowered: true, anchor: evidenced ? 'evidenced_pair' : 'integration' }
            : {}),
        },
      },
      ...recipients.map((recipient) =>
        claimNotificationAudit(actor, {
          vendorId: recipient,
          integrationId,
          integrationName: target.name,
          ownerVendorId: vendorId,
          ownerName: owner.companyName,
          pairSlugs,
        }),
      ),
    ];

    const stmts: BatchStmt[] = [
      guardedClaimUpdate(db, target, vendorId, now),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here.
      claimRaceSentinel(db, integrationId),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isClaimRaceError(error)) throw error;
      const current = await locateClaimTarget(db, integrationId);
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        (await refusalFor(db, vendorId, session, current)) ??
        new ApiError(
          409,
          ApiErrorCode.INTEGRATION_ALREADY_CLAIMED,
          'This integration changed while it was being claimed. Reload and try again.',
        )
      );
    }

    const tags = pairSlugs
      ? [
          pairCacheTag(pairSlugs[0], pairSlugs[1]),
          `product:${pairSlugs[0]}`,
          `product:${pairSlugs[1]}`,
          ...(connector ? [`product:${connector}`] : []),
        ]
      : [];
    const base = publicSiteBase(c.env);
    const recrawl =
      pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);

    const body: ClaimIntegrationResponse = {
      integration: {
        id: integrationId,
        owner_vendor_id: vendorId,
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
      },
    };
    validateResponseInDev(c.env, () => ClaimIntegrationResponseSchema.parse(body));
    return json(body);
  };
}
