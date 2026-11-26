/**
 * The pairs one connector product delivers, from both anchor tables (AECI-2045).
 *
 * "Delivered" means the product is the row's connector: `connector_product_id` on a
 * `connector_evidenced_pairs` row, `powered_by_product_id` on an `integrations` row.
 * No catalogue row is needed, so a Sync Service with no catalogue is covered.
 *
 * Two readers share it: the vendor portal's see-and-ask list
 * (`routes/vendor-delivered-pairs.ts`) and the admin console's pair list and owner
 * write (`routes/admin-integration-owner.ts`).
 */

import type { ProductLink } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, vendors } from '../db/schema';

import { productLinkColumns, toOwnedProductLink } from './drizzle-helpers';
import { chunked } from './promote-claims';

/** One delivered row, before the reader shapes it. */
export interface DeliveredPairRow {
  id: string;
  anchor: 'integration' | 'evidenced_pair';
  name: string | null;
  productAId: string;
  productBId: string;
  builtByVendorId: string | null;
  claimedAt: string | null;
  retiredAt: string | null;
  retiredBy: 'owner' | 'aeci' | null;
}

/**
 * Every row in either table whose connector is `connectorProductId`, live and retired,
 * ordered by name case-insensitively (the A and B names when it has none), then id.
 * `limit` caps the merged list. `onlyId` narrows both reads to one row, so a caller
 * that wants one pair never depends on where it sorts under the cap.
 */
export async function loadDeliveredPairs(
  db: Db,
  connectorProductId: string,
  limit: number,
  onlyId?: string,
): Promise<{ rows: DeliveredPairRow[]; links: Map<string, ProductLink> }> {
  const [pairs, rows] = await Promise.all([
    db
      .select({
        id: connectorEvidencedPairs.id,
        name: connectorEvidencedPairs.name,
        productAId: connectorEvidencedPairs.productAId,
        productBId: connectorEvidencedPairs.productBId,
        builtByVendorId: connectorEvidencedPairs.builtByVendorId,
        claimedAt: connectorEvidencedPairs.claimedAt,
        retiredAt: connectorEvidencedPairs.retiredAt,
        retiredBy: connectorEvidencedPairs.retiredBy,
      })
      .from(connectorEvidencedPairs)
      .where(
        and(
          eq(connectorEvidencedPairs.connectorProductId, connectorProductId),
          onlyId ? eq(connectorEvidencedPairs.id, onlyId) : undefined,
        ),
      ),
    db
      .select({
        id: integrations.id,
        name: integrations.name,
        productAId: integrations.sourceProductId,
        productBId: integrations.targetProductId,
        builtByVendorId: integrations.builtByVendorId,
        claimedAt: integrations.claimedAt,
        retiredAt: integrations.retiredAt,
        retiredBy: integrations.retiredBy,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.poweredByProductId, connectorProductId),
          onlyId ? eq(integrations.id, onlyId) : undefined,
        ),
      ),
  ]);
  // A Convention-A self-reference names the connector as one of its own endpoints: a
  // direct integration of that product, not a pair it delivers to two others.
  const merged: DeliveredPairRow[] = [
    ...pairs.map((p) => ({ ...p, anchor: 'evidenced_pair' as const })),
    ...rows
      .filter((r) => r.productAId !== connectorProductId && r.productBId !== connectorProductId)
      .map((r) => ({ ...r, anchor: 'integration' as const })),
  ].map((r) => ({ ...r, retiredBy: (r.retiredBy ?? null) as DeliveredPairRow['retiredBy'] }));
  const links = await productLinksById(db, [
    ...new Set(merged.flatMap((r) => [r.productAId, r.productBId])),
  ]);
  const sortName = (r: DeliveredPairRow) =>
    r.name ?? `${links.get(r.productAId)?.name ?? ''} ${links.get(r.productBId)?.name ?? ''}`;
  merged.sort((a, b) => compareText(sortName(a), sortName(b)) || (a.id < b.id ? -1 : 1));
  return { rows: merged.slice(0, limit), links };
}

/** Product links by id, chunked under D1's bound-parameter cap. */
export async function productLinksById(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, ProductLink>> {
  const out = new Map<string, ProductLink>();
  if (ids.length === 0) return out;
  const pages = await Promise.all(
    chunked(ids).map((chunk) =>
      db.query.products.findMany({
        columns: productLinkColumns,
        where: inArray(products.id, chunk),
      }),
    ),
  );
  for (const row of pages.flat()) out.set(row.id, toOwnedProductLink(row));
  return out;
}

/** Vendor names by id. */
export async function vendorNamesById(
  db: Db,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const pages = await Promise.all(
    chunked(wanted).map((chunk) =>
      db
        .select({ id: vendors.id, name: vendors.companyName })
        .from(vendors)
        .where(inArray(vendors.id, chunk)),
    ),
  );
  for (const row of pages.flat()) out.set(row.id, row.name);
  return out;
}

/** A link for a product the read did not find (deleted mid-read): never throws. */
export function linkOrStub(links: Map<string, ProductLink>, id: string): ProductLink {
  return links.get(id) ?? { id, name: id, slug: id, logo_url: null };
}
