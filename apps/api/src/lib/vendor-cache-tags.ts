/**
 * The vendor Cache-Tag purge set — ONE definition, shared by every writer that can move
 * `vendors.verified` (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.5).
 *
 * Promoted verbatim out of `routes/admin-claims.ts`, where it shipped as the
 * claim-grant's module-private `grantPurgeTags` (AECI-519). The license grant and
 * revoke (`routes/admin-licenses.ts`) use it now; the entitlement set/renew/clear
 * route that first shared it was retired by AECI-1375. Duplicated tag construction is
 * exactly how a page goes stale on one path and not the other. Renamed off "grant" because the set is no longer grant-specific.
 *
 * Why the FULL set and not just `vendor:{slug}`: `vendors.verified` drives the
 * version-diff gate on every pair page, and a pair page carries both endpoints'
 * `product:` tags. Those `product:` tags are the only part of the set that guards
 * anything derived from `verified` today. Until AECI-1266 (2026-10-12) the flag also
 * drove the claim button copy and its "Already managed" note on the vendor page and
 * every owned product page, and until AECI-1264 (2026-10-09) the public account
 * badge. Both are gone, and no public payload carries the flag any more. The
 * `vendor:` and `index:products` tags stay: a redundant purge costs one cache miss,
 * and dropping them would buy nothing. The tag set did not change.
 *
 * This module builds tags and nothing else. Enqueuing them onto the tier's
 * `CACHE_PURGE_QUEUE` stays in the route (`purgeGrantTags`) — that needs the Worker
 * env and the Datadog logger, both HTTP-context concerns.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, productVendors } from '../db/schema';
import { pairCacheTag } from '../routes/promote-pair';

import { isConnectorPoweredEdge } from './connector-powered';
import { chunked } from './promote-claims';

/**
 * The vendor identity a purge — and an entitlement write — resolves to: the id to walk
 * owned products from, the slug that becomes the tag, and the `verified` value both
 * callers preload for the mirror's guarded UPDATE.
 */
export interface TargetVendor {
  id: string;
  slug: string;
  verified: boolean;
}

/**
 * The pages that show a "Maintained by {owner}" caption whose form follows the owner's
 * plan (AECI-1614, `lib/field-captions.ts`): the connector-powered rows the vendor holds
 * and has edited. Those rows sit on the pages of two endpoints and a connector, which the
 * vendor may not own, so the owned-product tags alone would leave them stale when
 * `vendors.plan_ended_at` moves. A row with no stamp has no caption and costs no tag.
 */
async function connectorRowTags(db: Db, vendorId: string): Promise<string[]> {
  const [rows, pairs] = await Promise.all([
    db
      .select({
        sourceProductId: integrations.sourceProductId,
        targetProductId: integrations.targetProductId,
        poweredByProductId: integrations.poweredByProductId,
        mechanismKind: integrations.mechanismKind,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.builtByVendorId, vendorId),
          isNotNull(integrations.vendorEditedAt),
          isNull(integrations.retiredAt),
        ),
      ),
    db
      .select({
        sourceProductId: connectorEvidencedPairs.productAId,
        targetProductId: connectorEvidencedPairs.productBId,
        poweredByProductId: connectorEvidencedPairs.connectorProductId,
      })
      .from(connectorEvidencedPairs)
      .where(
        and(
          eq(connectorEvidencedPairs.builtByVendorId, vendorId),
          isNotNull(connectorEvidencedPairs.vendorEditedAt),
          isNull(connectorEvidencedPairs.retiredAt),
        ),
      ),
  ]);
  const edges = [...rows.filter((row) => isConnectorPoweredEdge(row)), ...pairs];
  if (edges.length === 0) return [];
  const ids = [
    ...new Set(
      edges.flatMap((edge) => [
        edge.sourceProductId,
        edge.targetProductId,
        ...(edge.poweredByProductId ? [edge.poweredByProductId] : []),
      ]),
    ),
  ];
  const slugRows = (
    await Promise.all(
      chunked(ids).map((slice) =>
        db
          .select({ id: products.id, slug: products.slug })
          .from(products)
          .where(inArray(products.id, slice)),
      ),
    )
  ).flat();
  const slugOf = new Map(slugRows.map((row) => [row.id, row.slug]));
  const tags = new Set<string>();
  for (const edge of edges) {
    const a = slugOf.get(edge.sourceProductId);
    const b = slugOf.get(edge.targetProductId);
    const connector = edge.poweredByProductId ? slugOf.get(edge.poweredByProductId) : undefined;
    if (a) tags.add(`product:${a}`);
    if (b) tags.add(`product:${b}`);
    if (connector) tags.add(`product:${connector}`);
    if (a && b) tags.add(pairCacheTag(a, b));
  }
  return [...tags];
}

/** The `vendor:<slug>` + every owned `product:<slug>` (+ `index:products`) tag set a
 *  `verified` flip invalidates, plus the pages of the vendor's edited connector-powered
 *  rows, because the same flip moves `plan_ended_at` (AECI-1614). */
export async function vendorPurgeTags(db: Db, vendor: TargetVendor): Promise<string[]> {
  const [productRows, rowTags] = await Promise.all([
    db
      .select({ slug: products.slug })
      .from(productVendors)
      .innerJoin(products, eq(products.id, productVendors.productId))
      .where(eq(productVendors.vendorId, vendor.id)),
    connectorRowTags(db, vendor.id),
  ]);
  const tags = new Set([
    `vendor:${vendor.slug}`,
    ...productRows.map((r) => `product:${r.slug}`),
    ...rowTags,
  ]);
  if (productRows.length > 0) tags.add('index:products');
  return [...tags];
}
