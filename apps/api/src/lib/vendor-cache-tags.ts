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
