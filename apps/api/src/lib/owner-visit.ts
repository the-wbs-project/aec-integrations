/**
 * "Is this a vendor looking at its own listing?" — the ownership half of
 * `page_views.is_owner_visit` (AECI-934, `ADMIN_PANEL_SPEC.md` §13 **D26**,
 * `VENDOR_PERFORMANCE_SPEC.md` §3.3).
 *
 * The session half — which vendor, if any, the request's verified
 * `vendor_admin` session administers — is `resolveVisitorSession` in
 * `lib/operator-session.ts`. This module only answers whether the entity the
 * row is about belongs to that vendor:
 *
 *   - **a vendor page**: the row's `vendor_id` is the session's vendor;
 *   - **a product page**: any `product_vendors` row ties the product to the
 *     vendor. Not only the primary vendor: a co-owner looking at its own
 *     listing is not buyer demand either (ruled 2026-10-12, §13 D26);
 *   - **a pair page**: either endpoint product is the vendor's, by the same
 *     `product_vendors` rule (AECI-929's `pair_product_a_id` / `_b_id`);
 *   - **an SPA hop**: the browser tracker sends only `{ route, navigation }`,
 *     so a product or vendor page reached in-app stores no entity id. The slug
 *     in `/products/:slug` or `/vendors/:slug` is checked instead. This is the
 *     common case, not an edge: a vendor clicking from its portal to its own
 *     listing is an SPA hop. Only the flag reads the path; `product_id` and
 *     `vendor_id` storage is unchanged.
 *
 * **Free unless the session is a vendor's.** `ownerVendorId === null` returns
 * before any D1 work, so anonymous and operator traffic pay nothing on the
 * hottest write path in the app. A vendor's own request costs at most one read.
 *
 * **Never throws.** Like `is_operator`, it runs inside the fire-and-forget
 * capture, so a D1 error resolves to `false`: it costs the flag, never the row,
 * and fails in the direction that keeps a view counted (§13 D13 property 3).
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, productVendors, vendors } from '../db/schema';

/**
 * The product and vendor detail pages, as the browser tracker reports them.
 * Locale prefix, query and fragment are already stripped by the writers
 * (`PageViewPayloadSchema`), the same convention `parsePairPagePath` relies on.
 * A sub-page (`/products/:slug/review`, `/vendors/:slug/claim`) or a trailing
 * slash is a different page and matches neither.
 */
const PRODUCT_PAGE_PATH_RE = /^\/products\/([^/]+)$/;
const VENDOR_PAGE_PATH_RE = /^\/vendors\/([^/]+)$/;

export type OwnerVisitRow = {
  productId: string | null;
  vendorId: string | null;
  pairProductAId: string | null;
  pairProductBId: string | null;
  concretePath: string;
};

/**
 * Whether the row's entity belongs to `ownerVendorId`. See the module header.
 *
 * @param db a client on the SAME request-scoped D1 connection the caller uses
 * @param ownerVendorId the vendor the verified session administers, or `null`
 */
export async function resolveOwnerVisit(
  db: Db,
  ownerVendorId: string | null,
  row: OwnerVisitRow,
): Promise<boolean> {
  if (ownerVendorId === null) return false;
  if (row.vendorId === ownerVendorId) return true;

  try {
    const productIds = [row.productId, row.pairProductAId, row.pairProductBId].filter(
      (id): id is string => id !== null,
    );
    if (productIds.length > 0) {
      return await ownsProduct(db, ownerVendorId, inArray(productVendors.productId, productIds));
    }

    // No stored entity: an SPA hop, or an arrival whose id did not resolve.
    const productSlug = row.concretePath.match(PRODUCT_PAGE_PATH_RE)?.[1];
    if (productSlug) {
      return await ownsProduct(
        db,
        ownerVendorId,
        inArray(
          productVendors.productId,
          db.select({ id: products.id }).from(products).where(eq(products.slug, productSlug)),
        ),
      );
    }
    const vendorSlug = row.concretePath.match(VENDOR_PAGE_PATH_RE)?.[1];
    if (row.vendorId === null && vendorSlug) {
      const [hit] = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.id, ownerVendorId), eq(vendors.slug, vendorSlug)))
        .limit(1);
      return hit !== undefined;
    }
    return false;
  } catch {
    return false;
  }
}

async function ownsProduct(db: Db, ownerVendorId: string, productMatch: SQL): Promise<boolean> {
  const [hit] = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(and(eq(productVendors.vendorId, ownerVendorId), productMatch))
    .limit(1);
  return hit !== undefined;
}
