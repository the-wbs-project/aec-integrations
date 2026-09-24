/**
 * The §5.2 **owner test**, as one shared read (AECI-1041).
 *
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 step 1a (`STAGE_2_SPEC.md` §8.10(1)) asks
 * whether a pure connector vendor is the recorded owner of any live integration.
 * If it is, and it wants to manage those integrations through the portal, it is a
 * paying third-party owner and takes the ordinary Grant rather than being parked.
 * `/admin/claims` and `/admin/vendors/:id` both need the number, so it lives here
 * once, beside `vendor-product-roles.ts`, which answers step 1.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *  1. **The owner is `built_by_vendor_id`** (§8.10 "Two terms"). There is no
 *     second owner column, and `maintained_by` is not ownership.
 *  2. **Both delivered-tier tables.** Promote routes an edge whose connector is a
 *     third product into `connector_evidenced_pairs`, so a third-party owner's
 *     rows are mostly there. A count over `integrations` alone reads zero for
 *     exactly the vendors step 1a exists for.
 *  3. **Live rows only.** `integrations` takes the AECI-1010 live predicate
 *     through {@link liveIntegrationWhere}, never a restatement of it.
 *     `connector_evidenced_pairs` takes the same rule through
 *     {@link liveEvidencedPairWhere} since AECI-1091, when pairs became retirable.
 *
 * This is the same vendor rule as `algoliaVendorConfig` and `vendorListConfig`
 * (lockstep sites 6a and 14a). It is lockstep site 14b, and the claim queue reads
 * it through this module rather than adding a site of its own.
 *
 * ── WHY TWO GROUPED READS AND NOT A UNION ───────────────────────────────────
 * Two reads keep each table's own predicate visible. The vendor-detail handler
 * spreads both into its existing `db.batch`, so they cost it no extra round trip.
 * That handler avoids `UNION` on purpose (D1 caps a compound select at five
 * terms), and a batch has no such ceiling. The claim queue runs them concurrently
 * inside its existing `Promise.all` fan-out (see {@link loadOwnedIntegrations}).
 */

import type { VendorOwnedIntegrations } from '@aeci/shared';
import { and, count, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations } from '../db/schema';
import { liveEvidencedPairWhere, liveIntegrationWhere } from './live-integration';

/** A vendor that owns nothing produces no group rows, so it folds to this. */
export const EMPTY_OWNED_INTEGRATIONS: VendorOwnedIntegrations = {
  integrations: 0,
  connector_evidenced: 0,
  total: 0,
};

/**
 * The two grouped counts, as unawaited query builders, so a caller can spread
 * them into its own `db.batch`. `vendorIds` must be non-empty: an empty `IN ()`
 * is a caller bug, not a zero.
 */
export function selectOwnedIntegrationGroups(db: Db, vendorIds: readonly string[]) {
  const ids = [...vendorIds];
  return [
    db
      .select({ vendorId: integrations.builtByVendorId, value: count() })
      .from(integrations)
      .where(and(inArray(integrations.builtByVendorId, ids), liveIntegrationWhere))
      .groupBy(integrations.builtByVendorId),
    db
      .select({ vendorId: connectorEvidencedPairs.builtByVendorId, value: count() })
      .from(connectorEvidencedPairs)
      .where(and(inArray(connectorEvidencedPairs.builtByVendorId, ids), liveEvidencedPairWhere))
      .groupBy(connectorEvidencedPairs.builtByVendorId),
  ] as const;
}

type OwnedGroupRow = { vendorId: string | null; value: number };

/** Fold both tables' group rows into one breakdown per vendor. */
export function foldOwnedIntegrations(
  integrationRows: readonly OwnedGroupRow[],
  evidencedRows: readonly OwnedGroupRow[],
): Map<string, VendorOwnedIntegrations> {
  const byVendor = new Map<string, VendorOwnedIntegrations>();
  const add = (row: OwnedGroupRow, key: 'integrations' | 'connector_evidenced') => {
    if (!row.vendorId) return;
    const entry = byVendor.get(row.vendorId) ?? { ...EMPTY_OWNED_INTEGRATIONS };
    entry[key] += row.value;
    entry.total += row.value;
    byVendor.set(row.vendorId, entry);
  };
  for (const row of integrationRows) add(row, 'integrations');
  for (const row of evidencedRows) add(row, 'connector_evidenced');
  return byVendor;
}

/**
 * Both reads, concurrently, folded. For callers with no batch of their own: the
 * claim queue fans its signals out through `Promise.all`, so this joins that
 * fan-out rather than opening a `db.batch`. On the claim routes `db.batch` is
 * reserved for writes, and the note route's specs assert exactly that.
 */
export async function loadOwnedIntegrations(
  db: Db,
  vendorIds: readonly string[],
): Promise<Map<string, VendorOwnedIntegrations>> {
  if (vendorIds.length === 0) return new Map();
  const [integrationQuery, evidencedQuery] = selectOwnedIntegrationGroups(db, vendorIds);
  const [integrationRows, evidencedRows] = await Promise.all([integrationQuery, evidencedQuery]);
  return foldOwnedIntegrations(integrationRows, evidencedRows);
}
