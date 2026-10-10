/**
 * The vendor Cache-Tag purge set — ONE definition, TWO writers (AECI-609 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.5).
 *
 * Promoted verbatim out of `routes/admin-claims.ts`, where it shipped as the
 * claim-grant's module-private `grantPurgeTags` (AECI-519). The Paid-Tiers epic adds a
 * SECOND writer of the identical set — §5's `PATCH /api/admin/vendors/:id/entitlement`
 * — and duplicated tag construction is exactly how a page goes stale on one path and
 * not the other. Renamed off "grant" because the set is no longer grant-specific.
 *
 * Why the FULL set and not just `vendor:{slug}`: `vendors.verified` drives the claim
 * button copy and its "Already managed" note on the vendor page AND every owned product
 * page, and the version-diff gate on every pair page (which carries both endpoints'
 * `product:` tags). Purging only the vendor tag leaves stale claim copy on every cached
 * product page (§5.3). Until AECI-1264 (2026-10-09) it also drove the public account
 * badge, which is gone. The tag set did not change.
 *
 * This module builds tags and nothing else. Enqueuing them onto the tier's
 * `CACHE_PURGE_QUEUE` stays in the route (`purgeGrantTags`) — that needs the Worker
 * env and the Datadog logger, both HTTP-context concerns.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, productVendors } from '../db/schema';

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

/** The `vendor:<slug>` + every owned `product:<slug>` (+ `index:products`) tag set a
 *  `verified` flip invalidates. */
export async function vendorPurgeTags(db: Db, vendor: TargetVendor): Promise<string[]> {
  const productRows = await db
    .select({ slug: products.slug })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, vendor.id));
  const tags = [`vendor:${vendor.slug}`, ...productRows.map((r) => `product:${r.slug}`)];
  if (productRows.length > 0) tags.push('index:products');
  return tags;
}
