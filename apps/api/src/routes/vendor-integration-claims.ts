/**
 * Integration ownership claim, vendor side (AECI-1005 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations/:id/claim — the recorded owner claims the row (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules of
 * this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')`, and no `requireCapability` and no
 * Verified check (AECI-1003 decision 15). The same named exception to §6.14's
 * "writes are entitlement-gated" that contests took (§11b). Who gets a seat is the
 * commercial control, not a capability on the route.
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
 * ── 4. CONNECTOR-POWERED ROWS MAY BE CLAIMED, AND NOTHING ELSE ──────────────
 * Decision 9 keeps connector-powered integrations out of every vendor write, and
 * the 2026-09-21 ruling carves exactly one thing out of that for v1: the owner may
 * claim. So this route does NOT refuse a connector-powered row. Every later owner
 * write (1006 edit, 1007 links, 1010 retire) must.
 *
 * ── 5. ONE BATCH ────────────────────────────────────────────────────────────
 * The guarded `UPDATE … WHERE claimed_at IS NULL AND built_by_vendor_id = <caller>`,
 * then `claimRaceSentinel` immediately after it, then the `integration.claimed`
 * audit row and one `notification.sent` row per other endpoint vendor. A lost race
 * writes nothing at all and answers 409. The UPDATE also performs §13.9's
 * maintenance transfer (`maintained_by = 'vendor'`, a fresh `last_reviewed_at`),
 * which changes the pair page's marker, so the pair page and both product pages
 * are purged after commit.
 */

import {
  ApiErrorCode,
  ClaimIntegrationResponseSchema,
  type ClaimIntegrationResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { integrations, productVendors, products, vendors } from '../db/schema';
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
  isClaimed,
  isClaimRaceError,
} from '../lib/integration-claims';
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

type IntegrationRow = typeof integrations.$inferSelect;

/** Does the caller's vendor own either endpoint product? The visibility half of
 *  rule 3: an endpoint vendor already sees the row in its portal. */
async function ownsAnEndpoint(
  db: Db,
  vendorId: string,
  row: Pick<IntegrationRow, 'sourceProductId' | 'targetProductId'>,
): Promise<boolean> {
  const hit = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        or(
          eq(productVendors.productId, row.sourceProductId),
          eq(productVendors.productId, row.targetProductId),
        ),
      ),
    )
    .limit(1);
  return hit.length > 0;
}

/** Both endpoint slugs, for the purge, the notification snapshot and the recrawl. */
async function endpointSlugs(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<readonly [string, string] | null> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, [sourceId, targetId]));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(sourceId);
  const b = slug.get(targetId);
  return a && b ? [a, b] : null;
}

/**
 * Why this caller cannot claim this row, or `null` when it can. Shared by the
 * pre-check and the lost-race re-read, so a race answers exactly what the pre-check
 * would have answered a moment later.
 */
async function refusalFor(db: Db, vendorId: string, row: IntegrationRow): Promise<ApiError | null> {
  if (row.builtByVendorId !== vendorId) {
    if (!(await ownsAnEndpoint(db, vendorId, row))) {
      return notFoundError('integration', { id: row.id });
    }
    if (row.builtByVendorId === null) {
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
  if (isClaimed(row)) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_ALREADY_CLAIMED,
      'Your company has already claimed this integration.',
    );
  }
  return null;
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

    // 1. The row, alone in its wave. An unknown id and an invisible one are both 404.
    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, integrationId),
    });
    if (!row) throw notFoundError('integration', { id: integrationId });

    // 2. Ownership, then state.
    const refusal = await refusalFor(db, vendorId, row);
    if (refusal) throw refusal;

    const [owner, slotVendors, pairSlugs] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      vendorsForIntegrationSlots(db, [integrationId]),
      endpointSlugs(db, row.sourceProductId, row.targetProductId),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint, except the owner itself. A third-party owner
    // (neither endpoint's vendor) therefore notifies both sides.
    const slots = slotVendors.get(integrationId)?.slots;
    const recipients = [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])]
      .filter((id) => id !== vendorId)
      .sort();

    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: INTEGRATION_CLAIMED_ACTION,
        entityType: 'integration',
        entityId: integrationId,
        beforeState: {
          claimed_at: null,
          built_by_vendor_id: row.builtByVendorId,
          maintained_by: row.maintainedBy,
          last_reviewed_at: row.lastReviewedAt,
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
          ...(isMaintenanceTransfer(row) ? { maintenanceTransfer: true } : {}),
          // The one vendor write decision 9 allows on a connector-powered row.
          ...(isConnectorPoweredEdge(row) ? { connectorPowered: true } : {}),
        },
      },
      ...recipients.map((recipient) =>
        claimNotificationAudit(actor, {
          vendorId: recipient,
          integrationId,
          integrationName: row.name,
          ownerVendorId: vendorId,
          ownerName: owner.companyName,
          pairSlugs,
        }),
      ),
    ];

    const stmts: BatchStmt[] = [
      db
        .update(integrations)
        .set(claimColumns(now))
        .where(
          and(
            eq(integrations.id, integrationId),
            isNull(integrations.claimedAt),
            // Guarded on the owner too: a promote that re-pointed the owner between
            // the read above and this batch must not let the old owner claim.
            eq(integrations.builtByVendorId, vendorId),
          ),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here.
      claimRaceSentinel(db, integrationId),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isClaimRaceError(error)) throw error;
      const current = await db.query.integrations.findFirst({
        where: eq(integrations.id, integrationId),
      });
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        (await refusalFor(db, vendorId, current)) ??
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
