/**
 * A Sync Service adds its own pair (AECI-2040, rulings 7 and 11 on AECI-2035,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7) — Drizzle/D1.
 *
 *   POST /api/vendor/sync-service-pairs — the caller's Sync Service delivers a new pair (201).
 *
 * A sibling of `POST /api/vendor/integrations` (`vendor-integration-create.ts`), which
 * stays closed on connector-delivered rows (ruling 1 of 2026-09-23, which stands for
 * Integration platforms and unclassified connectors). Six rules of this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')`, then the checks in the handler, and no
 * `requireCapability` (AECI-1003 decision 15, AECI-2038). `requireVendor()` already
 * refuses a suspended company and a company blocked on the terms-acceptance gate.
 *
 * ── 2. THE CONNECTOR IS THE CALLER'S SYNC SERVICE ───────────────────────────
 * `connector_product_id` must be a listed product the caller's vendor holds, of role
 * `connector` or `hybrid` and kind `sync_service`. Not the caller's, hidden, not
 * promoted or missing is the same `404`; the caller's but another kind is `422
 * CONNECTOR_NOT_SYNC_SERVICE` (`lib/sync-service-pair-create.ts`).
 *
 * ── 3. ANY TWO LISTED ENDPOINTS ─────────────────────────────────────────────
 * Neither endpoint needs to be the caller's, and an owned endpoint does not block it
 * (ruling 7). Neither may be the connector (`400`, and the table's CHECK). Hidden, not
 * promoted or missing is `404`.
 *
 * ── 4. THE CALLER OWNS IT FROM THE FIRST STATEMENT ──────────────────────────
 * The row lands in `connector_evidenced_pairs` in canonical order, with `origin =
 * 'vendor'`, `built_by_vendor_id` = caller, `claimed_at` = now, and §13.9's maintenance
 * transfer. Vendor-held, so promote's fence and its evidenced twin guard keep off it.
 *
 * ── 5. A DUPLICATE IS REFUSED ───────────────────────────────────────────────
 * Unlike the vendor create, which warns: the unique index on (connector, A, B) would
 * refuse a second evidenced row anyway, and the guard (`findSyncServicePairBlock` in
 * `lib/integration-twins.ts`) also searches `integrations` for a row through the same
 * connector. A retired pair is a duplicate: restore it instead.
 *
 * ── 6. ONE BATCH, THEN THE RETIRE'S TAIL ────────────────────────────────────
 * The three sentinels (connector, endpoints, block), the INSERT, the
 * `integration.created` audit row (entity `connector_evidenced_pair`), one
 * `notification.sent` row per vendor of either endpoint except the caller (ruling 11),
 * and THREE count recomputes: both endpoints and the connector (§12.5 option B). After
 * commit: by-id Algolia sync, purge `pair:`, both endpoint `product:` tags, the
 * connector's `product:` tag, `vendor:`, `index:products`, `taxonomy` and `sitemap`;
 * queue the pair re-crawl. `afterVendorWrite` re-sends the ownership record of every
 * owned vendor the audit rows touch, `deliveredPairs[]` included (AECI-2047).
 */

import {
  ApiErrorCode,
  CONNECTOR_POWERED_EDIT_FIELDS,
  CreateSyncServicePairResponseSchema,
  CreateSyncServicePairSchema,
  claimDirectionFromContext,
  integrationEditValueProblem,
  type ContextDirection,
  type CreateSyncServicePairResponse,
  type IntegrationEditField,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { eq, inArray } from 'drizzle-orm';

import { getDb } from '../db/client';
import { connectorEvidencedPairs, productVendors, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { claimColumns } from '../lib/integration-claims';
import { createNotificationAudit, INTEGRATION_CREATED_ACTION } from '../lib/integration-create';
import { EVIDENCED_PAIR_ANCHOR, EVIDENCED_PAIR_ENTITY_TYPE } from '../lib/integration-retire';
import type { SyncServicePairCandidate } from '../lib/integration-twins';
import { publicSiteBase } from '../lib/public-urls';
import { integrationCountRecomputeStmt } from '../lib/recompute-counts';
import {
  isSyncServicePairRaceError,
  syncServicePairCreateRefusal,
  syncServicePairCreateSentinels,
} from '../lib/sync-service-pair-create';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { pairCacheTag } from './promote-pair';
import { EVIDENCED_EDIT_COLUMNS } from './vendor-evidenced-pair-edits';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  stampCauseProductPlan,
  vendorAuditEntry,
  vendorRecrawlEnabled,
  withRecrawlProduct,
  type VendorContext,
} from './vendor-shared';

type PairField = Exclude<IntegrationEditField, 'mechanism_kind'>;
const PAIR_FIELDS = CONNECTOR_POWERED_EDIT_FIELDS as readonly PairField[];

export function createCreateSyncServicePairHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Shape: 400 for an unknown key (`mechanism_kind`, `origin`, …), a missing
    //    required field, or two ids that are the same.
    const payload = await parseJsonBody(c, CreateSyncServicePairSchema);
    const connectorId = payload.connector_product_id;
    const [productAId, productBId] =
      payload.product_id < payload.counterpart_product_id
        ? [payload.product_id, payload.counterpart_product_id]
        : [payload.counterpart_product_id, payload.product_id];
    const candidate: SyncServicePairCandidate = {
      connectorProductId: connectorId,
      productAId,
      productBId,
    };

    // 2. Connector, endpoints, duplicate: 404, 422, 404, 409, in that order.
    const refusal = await syncServicePairCreateRefusal(db, vendorId, candidate);
    if (refusal) throw refusal;

    // 3. Values: the owner edit's rule per field, so 422 rather than 400. `direction`
    //    is framed against `product_id` on the wire and stored in the A/B frame.
    const contextIsA = payload.product_id === productAId;
    const values: Partial<Record<PairField, string>> = {};
    for (const field of PAIR_FIELDS) {
      const wire = payload[field];
      if (wire === undefined || wire === null) continue;
      const problem = integrationEditValueProblem(field, wire);
      if (problem) {
        throw new ApiError(422, ApiErrorCode.INTEGRATION_INVALID_VALUE, problem, { field });
      }
      values[field] =
        field === 'direction'
          ? claimDirectionFromContext(wire as ContextDirection, contextIsA)
          : wire;
    }

    // 4. Everything the batch and the tail need, in one wave.
    const productIds = [productAId, productBId, connectorId];
    const [owner, endpointVendors, productRows] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      db
        .select({ vendorId: productVendors.vendorId })
        .from(productVendors)
        .where(inArray(productVendors.productId, [productAId, productBId])),
      db.query.products.findMany({
        columns: { id: true, slug: true },
        where: (p, { inArray: inArr }) => inArr(p.id, productIds),
      }),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });
    const slugOf = new Map(productRows.map((p) => [p.id, p.slug]));
    const slugA = slugOf.get(productAId);
    const slugB = slugOf.get(productBId);
    const pairSlugs: readonly [string, string] | null = slugA && slugB ? [slugA, slugB] : null;
    const connectorSlug = slugOf.get(connectorId) ?? null;

    // Ruling 11: every vendor with a seat on either endpoint, except the caller. A
    // `notification.sent` row is what the portal feed reads, so a vendor with no seat
    // yet sees it once it gets one. Sorted by id: an id ordering stays BINARY
    // (`API_CONTRACTS.md` §3.2).
    const recipients = [...new Set(endpointVendors.map((row) => row.vendorId))]
      .filter((id) => id !== vendorId)
      .sort();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const columns: Record<string, string> = {};
    for (const [field, value] of Object.entries(values) as [PairField, string][]) {
      columns[EVIDENCED_EDIT_COLUMNS[field]] = value;
    }
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        // The action the catalog "additions" series counts, as the vendor create.
        action: INTEGRATION_CREATED_ACTION,
        entityType: EVIDENCED_PAIR_ENTITY_TYPE,
        entityId: id,
        afterState: {
          ...values,
          connector_product_id: connectorId,
          product_a_id: productAId,
          product_b_id: productBId,
          built_by_vendor_id: vendorId,
          origin: 'vendor',
          claimed_at: now,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          reason: 'sync-service-create',
          // The same carve-out markers the claim, edit and retire write on this table.
          connectorPowered: true,
          anchor: EVIDENCED_PAIR_ANCHOR,
          connectorProductId: connectorId,
        },
      },
      ...recipients.map((recipient) =>
        createNotificationAudit(
          'portal-sync-service-pair-create',
          actor,
          {
            vendorId: recipient,
            integrationId: id,
            integrationName: values.name ?? null,
            ownerVendorId: vendorId,
            ownerName: owner.companyName,
            pairSlugs,
          },
          'evidenced_pair',
        ),
      ),
    ];

    // AECI-1376: the cause product is the caller's own, the connector.
    stampCauseProductPlan(c, audits, connectorId);
    const stmts: BatchStmt[] = [
      // First: a change since the read (kind cleared, a hide, a promote of the same
      // pair) aborts here, before anything is written.
      ...syncServicePairCreateSentinels(db, vendorId, candidate),
      db.insert(connectorEvidencedPairs).values({
        id,
        ...columns,
        connectorProductId: connectorId,
        productAId,
        productBId,
        builtByVendorId: vendorId,
        origin: 'vendor',
        ...claimColumns(now),
        // AECI-1614: the vendor wrote every field on this row.
        vendorEditedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
      // Last: all three counts over the row as this batch leaves it.
      ...productIds.map((productId) => integrationCountRecomputeStmt(db, productId)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isSyncServicePairRaceError(error)) throw error;
      throw (
        (await syncServicePairCreateRefusal(db, vendorId, candidate)) ??
        new ApiError(
          409,
          ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
          'Something changed while this integration was being added. Reload and try again.',
        )
      );
    }

    dispatchOwnerWriteSearch(
      c,
      'vendor-sync-service-create-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        {
          integrations: [id],
          products: productIds,
          vendors: [vendorId],
          // AECI-1897: the vendor count is reach, so every vendor of an endpoint and
          // of the connector moved.
          vendorsOfProducts: productIds,
        },
        'aeci.api.vendor.sync_service_create_algolia_sync_failed',
      ),
    );

    const tags = [
      ...(pairSlugs
        ? [
            pairCacheTag(pairSlugs[0], pairSlugs[1]),
            `product:${pairSlugs[0]}`,
            `product:${pairSlugs[1]}`,
          ]
        : []),
      ...(connectorSlug ? [`product:${connectorSlug}`] : []),
      `vendor:${owner.slug}`,
      'index:products',
      'taxonomy',
      'sitemap',
    ];
    const base = publicSiteBase(c.env);
    const recrawl =
      pairSlugs && vendorRecrawlEnabled(c) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, withRecrawlProduct(recrawl, connectorId), db);

    const body: CreateSyncServicePairResponse = {
      pair: {
        id,
        connector_product_id: connectorId,
        product_a_id: productAId,
        product_b_id: productBId,
        origin: 'vendor',
        owner_vendor_id: vendorId,
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        created_at: now,
        updated_at: now,
      },
    };
    validateResponseInDev(c.env, () => CreateSyncServicePairResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}
