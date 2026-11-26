/**
 * A Sync Service adds its own pair: the reads, the refusals and the commit-time
 * sentinels the route shares with its lost-race re-read (AECI-2040, rulings 7 and 11 on
 * AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7). The route is
 * `routes/vendor-sync-service-pair-create.ts`.
 *
 * The refusal order, each one before any write:
 *
 *   1. the connector product is not the caller's, not promoted, hidden or missing:
 *      `404` (the same answer for each, so a vendor cannot probe the catalog);
 *   2. it is the caller's but not a Sync Service (an Integration platform, a blank
 *      kind or an `application`): `422 CONNECTOR_NOT_SYNC_SERVICE`. Ruling 1 of
 *      2026-09-23 stands for every connector that is not a Sync Service;
 *   3. an endpoint is not promoted, hidden or missing: `404`;
 *   4. the pair is already on record through this connector, in either table, live or
 *      retired (`findSyncServicePairBlock`, `lib/integration-twins.ts`): `409
 *      INTEGRATION_ALREADY_ON_RECORD`.
 *
 * The batch re-checks 1 to 4 at commit ({@link syncServicePairCreateSentinels}), so an
 * admin clearing the kind, a hide, a seat change or a promote that lands between the
 * read and the batch aborts the create. The route then re-runs {@link
 * syncServicePairCreateRefusal} to answer what the read would have answered.
 */

import { ApiErrorCode, isSyncService, type SyncServicePairOnRecordDetails } from '@aeci/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, productVendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import type { BatchStmt } from './audit';
import { ONE_ROW } from './integration-claims';
import {
  findSyncServicePairBlock,
  syncServicePairBlockSentinel,
  type SyncServicePairBlock,
  type SyncServicePairCandidate,
} from './integration-twins';
import { visibleProductWhere } from './listing-visibility';

/** The token the connector and endpoint sentinels raise. */
export const SYNC_SERVICE_PAIR_CHANGED_TOKEN = 'sync-service-pair-changed';

/** The roles a Sync Service sits on, as SQL. `CONNECTOR_KIND_ROLES` in `@aeci/shared`. */
const SYNC_SERVICE_ROLES = ['connector', 'hybrid'] as const;

/** Listed: promoted and not hidden (AECI-1238). */
const listedProductWhere: SQL = and(eq(products.promotionStatus, 'promoted'), visibleProductWhere)!;

/** What the route needs about the caller's connector product. */
export interface CallerConnector {
  id: string;
  slug: string;
  productRole: string;
  connectorKind: string | null;
}

/** The connector product, when it is listed and the caller's vendor holds it. */
export async function callerConnectorProduct(
  db: Db,
  connectorId: string,
  vendorId: string,
): Promise<CallerConnector | null> {
  const [row] = await db
    .select({
      id: products.id,
      slug: products.slug,
      productRole: products.productRole,
      connectorKind: products.connectorKind,
    })
    .from(products)
    .innerJoin(
      productVendors,
      and(eq(productVendors.productId, products.id), eq(productVendors.vendorId, vendorId)),
    )
    .where(and(eq(products.id, connectorId), listedProductWhere))
    .limit(1);
  return row ?? null;
}

/** The two endpoints that are listed, with their slugs. */
export async function listedEndpoints(
  db: Db,
  ids: readonly [string, string],
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(and(inArray(products.id, [...ids]), listedProductWhere));
  return new Map(rows.map((row) => [row.id, row.slug]));
}

/** The `409` for a pair already on record. `details` lets the portal open it. */
export function alreadyOnRecordError(block: SyncServicePairBlock, vendorId: string): ApiError {
  // AECI-2042: an endpoint vendor's veto is in force on this pair. It is not a
  // duplicate to restore: only that vendor's withdraw or an AECi lift ends it.
  if (block.reason === 'endpoint_veto') {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_VETOED,
      'A vendor of one of these products removed this integration from its product, so it cannot be added again. That vendor can withdraw the removal.',
    );
  }
  const details: SyncServicePairOnRecordDetails = {
    existing_id: block.id,
    anchor: block.anchor,
    retired: block.retiredAt !== null,
    owned_by_caller: block.builtByVendorId === vendorId,
    claimed: block.claimedAt !== null,
  };
  return new ApiError(
    409,
    ApiErrorCode.INTEGRATION_ALREADY_ON_RECORD,
    block.retiredAt !== null
      ? 'This integration is already on record through this connector, and it is retired. Restore it instead of adding it again.'
      : 'This integration is already on record through this connector.',
    { details },
  );
}

/**
 * Why this caller may not add this pair now, or `null` when it may. The route's
 * pre-check and its lost-race re-read, so both answer alike.
 */
export async function syncServicePairCreateRefusal(
  db: Db,
  vendorId: string,
  candidate: SyncServicePairCandidate,
): Promise<ApiError | null> {
  const connector = await callerConnectorProduct(db, candidate.connectorProductId, vendorId);
  if (!connector) return notFoundError('product', { id: candidate.connectorProductId });
  if (!isSyncService(connector.productRole, connector.connectorKind)) {
    return new ApiError(
      422,
      ApiErrorCode.CONNECTOR_NOT_SYNC_SERVICE,
      'Only a Sync Service can add the integrations it delivers. Ask AEC Integrations to add this one.',
      { field: 'connector_product_id' },
    );
  }
  const listed = await listedEndpoints(db, [candidate.productAId, candidate.productBId]);
  for (const id of [candidate.productAId, candidate.productBId]) {
    if (!listed.has(id)) return notFoundError('product', { id });
  }
  const block = await findSyncServicePairBlock(db, candidate);
  return block ? alreadyOnRecordError(block, vendorId) : null;
}

/**
 * The commit-time sentinels, pushed AHEAD of the INSERT in this order: the connector
 * is still the caller's listed Sync Service, both endpoints are still listed, and
 * nothing blocks the pair. Each selects FROM `ONE_ROW`, so it runs exactly once, and
 * each raises "malformed JSON" when it fails.
 */
export function syncServicePairCreateSentinels(
  db: Db,
  vendorId: string,
  candidate: SyncServicePairCandidate,
): BatchStmt[] {
  const endpoints = [candidate.productAId, candidate.productBId];
  return [
    db
      .select({
        guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${products} INNER JOIN ${productVendors} ON ${productVendors.productId} = ${products.id} AND ${productVendors.vendorId} = ${vendorId} WHERE ${products.id} = ${candidate.connectorProductId} AND ${inArray(products.productRole, [...SYNC_SERVICE_ROLES])} AND ${products.connectorKind} = 'sync_service' AND ${listedProductWhere}) THEN json(${SYNC_SERVICE_PAIR_CHANGED_TOKEN}) END`,
      })
      .from(ONE_ROW),
    db
      .select({
        guard: sql`CASE WHEN (SELECT count(*) FROM ${products} WHERE ${inArray(products.id, endpoints)} AND ${listedProductWhere}) < 2 THEN json(${SYNC_SERVICE_PAIR_CHANGED_TOKEN}) END`,
      })
      .from(ONE_ROW),
    syncServicePairBlockSentinel(db, candidate),
  ];
}

/** True for the error one of the sentinels raises, in D1 or SQLite. */
export function isSyncServicePairRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
