/**
 * The row a retire or restore acts on, in either anchor table (AECI-1091 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6 and §4.6.4).
 *
 * The owner routes (`routes/vendor-integration-retire.ts`) and the admin routes
 * (`routes/admin-integration-retire.ts`) take one `:id`. Since AECI-1091 it may name
 * an `integrations` row or a `connector_evidenced_pairs` row: the AECI-1040
 * carve-out lets the owner retire its connector-powered rows, and ruling D gives
 * AECi the same soft retire on vendor-held pairs. {@link locateRetireTarget} reads
 * `integrations` first and then the pair table, as promote's `locateEdge` and the
 * AECI-1090 edit do. Ids are uuids minted per table, so an id is in at most one.
 *
 * {@link RetireTarget} is the part of either row the refusal ladders read, so each
 * route keeps ONE ladder for both tables and the two cannot drift apart.
 */

import { and, eq, inArray, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, productVendors, products } from '../db/schema';
import { vendorsForIntegrationSlots } from './attestation-authority';
import { isConnectorPoweredEdge } from './connector-powered';

export type IntegrationRow = typeof integrations.$inferSelect;
export type EvidencedPairRow = typeof connectorEvidencedPairs.$inferSelect;

/** One row of either table, as the retire routes read it. */
export type LocatedRetireRow =
  | { anchor: 'integration'; row: IntegrationRow }
  | { anchor: 'evidenced_pair'; pair: EvidencedPairRow };

/** The fields every refusal ladder reads, the same on both tables. */
export interface RetireTarget {
  anchor: LocatedRetireRow['anchor'];
  id: string;
  builtByVendorId: string | null;
  /** The two endpoints: source/target on `integrations`, A/B on a pair. */
  endpointIds: readonly [string, string];
  claimedAt: string | null;
  origin: string;
  retiredAt: string | null;
  retiredBy: string | null;
  /** ADR 0035 decision 9's predicate: `isConnectorPoweredEdge` on `integrations`,
   *  and always true for a pair. The carve-out's entitlement step keys on it. */
  connectorPowered: boolean;
}

export function retireTargetOf(located: LocatedRetireRow): RetireTarget {
  if (located.anchor === 'integration') {
    const { row } = located;
    return {
      anchor: 'integration',
      id: row.id,
      builtByVendorId: row.builtByVendorId,
      endpointIds: [row.sourceProductId, row.targetProductId],
      claimedAt: row.claimedAt,
      origin: row.origin,
      retiredAt: row.retiredAt,
      retiredBy: row.retiredBy,
      connectorPowered: isConnectorPoweredEdge(row),
    };
  }
  const { pair } = located;
  return {
    anchor: 'evidenced_pair',
    id: pair.id,
    builtByVendorId: pair.builtByVendorId,
    endpointIds: [pair.productAId, pair.productBId],
    claimedAt: pair.claimedAt,
    origin: pair.origin,
    retiredAt: pair.retiredAt,
    retiredBy: pair.retiredBy,
    connectorPowered: true,
  };
}

/** The row by id, `integrations` first, then `connector_evidenced_pairs`. `null`
 *  when neither table holds it. Sequential on purpose: the second read runs only on
 *  a miss, which is the rarer case. */
export async function locateRetireTarget(db: Db, id: string): Promise<LocatedRetireRow | null> {
  const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
  if (row) return { anchor: 'integration', row };
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  });
  return pair ? { anchor: 'evidenced_pair', pair } : null;
}

/** Re-read the row in the table it was found in, for the lost-race answer. */
export async function relocateRetireTarget(
  db: Db,
  located: LocatedRetireRow,
): Promise<LocatedRetireRow | null> {
  if (located.anchor === 'integration') {
    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, located.row.id),
    });
    return row ? { anchor: 'integration', row } : null;
  }
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, located.pair.id),
  });
  return pair ? { anchor: 'evidenced_pair', pair } : null;
}

/** Does the caller's vendor hold either endpoint product? The visibility half of
 *  the 404 rule the claim route set. */
export async function ownsAnEndpoint(
  db: Db,
  vendorId: string,
  endpointIds: readonly [string, string],
): Promise<boolean> {
  const hit = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        inArray(productVendors.productId, [...endpointIds]),
      ),
    )
    .limit(1);
  return hit.length > 0;
}

/** Every vendor of either endpoint product, sorted by id (an id ordering stays
 *  BINARY, `API_CONTRACTS.md` §3.2). The retire notification's audience. */
export async function endpointVendorIds(db: Db, located: LocatedRetireRow): Promise<string[]> {
  if (located.anchor === 'integration') {
    const id = located.row.id;
    const slots = (await vendorsForIntegrationSlots(db, [id])).get(id)?.slots;
    return [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])].sort();
  }
  const { pair } = located;
  const rows = await db
    .select({ vendorId: productVendors.vendorId })
    .from(productVendors)
    .where(
      or(
        eq(productVendors.productId, pair.productAId),
        eq(productVendors.productId, pair.productBId),
      ),
    );
  return [...new Set(rows.map((r) => r.vendorId))].sort();
}

/**
 * The slugs the purge and the notification snapshot need: the two endpoints in the
 * row's own order (source/target, or A/B), and the connector's for a pair. One read.
 */
export async function retireSlugs(
  db: Db,
  located: LocatedRetireRow,
): Promise<{ pairSlugs: readonly [string, string] | null; connectorSlug: string | null }> {
  const target = retireTargetOf(located);
  const connectorId = located.anchor === 'evidenced_pair' ? located.pair.connectorProductId : null;
  const ids = [...target.endpointIds, ...(connectorId ? [connectorId] : [])];
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, ids));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(target.endpointIds[0]);
  const b = slug.get(target.endpointIds[1]);
  return {
    pairSlugs: a && b ? [a, b] : null,
    connectorSlug: connectorId ? (slug.get(connectorId) ?? null) : null,
  };
}
