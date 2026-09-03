/**
 * The §5.2 **payer test**, as one shared read (AECI-738).
 *
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 step 1 asks: *does this vendor own any
 * product with `product_role IN ('application','hybrid')`?* If yes it is an
 * ordinary paying vendor and takes the ordinary Grant/Reject flow. Only a vendor
 * **all** of whose products are `'connector'` routes to the partnership track —
 * on that claim Grant and Reject are BOTH wrong (§5.2(2)/(3)), so the operator
 * has to be able to see the answer before pressing either.
 *
 * ── WHY THIS IS A MODULE AND NOT TWO INLINE QUERIES ──────────────────────────
 * `/admin/claims` and `/admin/vendors/:id` both need it, and `STAGE_1_5_SPEC.md`
 * §13.5 (items 11/12) records what happens otherwise: two independent
 * implementations of the same operator number, drifting apart unnoticed. The SQL
 * shape, the fold, and the pure-connector predicate live here once.
 *
 * ── THE INVARIANTS ───────────────────────────────────────────────────────────
 *  1. **Per product, never per vendor.** `vendors` carries no connector marker
 *     at all (`STAGE_2_SPEC.md` §8.8(1): no `role`/`kind`/`is_connector`) and must
 *     not gain one — Autodesk, Trimble, Deltek and Sage Group each own
 *     connector-role products while being among the largest ENDPOINT accounts, so
 *     a per-vendor flag would catch the exact inverse of the intent.
 *  2. **All ownership rows count, not just `is_primary`.** §8.8(1) asks what the
 *     vendor owns, not what it owns first. (Contrast `resolveClaimVendorIds`,
 *     which needs the ONE vendor a grant would touch and so does order by
 *     `is_primary`.)
 *  3. **Zero products is UNKNOWN, not exempt.** A vendor with no products is
 *     `total: 0` and `isPureConnectorVendor() === false`. Reading "no
 *     application products" as "pure connector" would park a claim we know
 *     nothing about.
 *  4. **`hybrid` is an endpoint.** §8.8(1)'s hybrid rule: a hybrid product is an
 *     endpoint as well as a connector, chargeable on its endpoint side. It
 *     therefore disqualifies a vendor from the carve-out exactly as
 *     `application` does.
 */

import type { VendorProductRoles } from '@aeci/shared';
import { count, eq, inArray, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productVendors, products } from '../db/schema';

/** A vendor with no `product_vendors` rows produces no group rows at all, so the
 *  absent-from-the-map case folds to this rather than to `null`. See invariant 3. */
export const EMPTY_PRODUCT_ROLES: VendorProductRoles = {
  application: 0,
  connector: 0,
  hybrid: 0,
  total: 0,
};

/**
 * One grouped scan over the ownership join — `product_vendors ⋈ products GROUP BY
 * vendor_id, product_role`. Returned as an unawaited query builder so callers can
 * either `await` it (the claims fan-out) or drop it into a `db.batch` (the vendor
 * detail) without a second copy of the SQL.
 *
 * `innerJoin` is safe against undercounting: `product_vendors.product_id` is
 * `ON DELETE CASCADE` against `products`, so there is no ownership row whose
 * product is missing. That is what lets the vendor-detail handler derive
 * `product_count` from this sum instead of running a separate `count()` that
 * could disagree with it.
 */
export function selectProductRoleGroups(db: Db, where: SQL | undefined) {
  return db
    .select({
      vendorId: productVendors.vendorId,
      role: products.productRole,
      value: count(),
    })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(where)
    .groupBy(productVendors.vendorId, products.productRole);
}

/** Scoping predicates, so no caller hand-writes the column reference. */
export const productRolesForVendor = (vendorId: string) => eq(productVendors.vendorId, vendorId);
export const productRolesForVendors = (vendorIds: string[]) =>
  inArray(productVendors.vendorId, vendorIds);

type ProductRoleGroupRow = { vendorId: string; role: string; value: number };

/**
 * Fold the grouped rows into one breakdown per vendor.
 *
 * An unrecognised `product_role` still lands in `total` but in no named bucket —
 * deliberately. The column has a CHECK (`application|connector|hybrid`), so a
 * fourth value can only arrive by a migration that lands ahead of this file; when
 * it does, the vendor reads as "owns something that is not a connector", which
 * fails the carve-out CLOSED. Throwing here (as `toProductRole` does on the
 * public product path) would take down the whole claim queue over one row, and
 * silently counting it as a connector would park a claim wrongly.
 */
export function foldProductRoleGroups(
  rows: ProductRoleGroupRow[],
): Map<string, VendorProductRoles> {
  const byVendor = new Map<string, VendorProductRoles>();
  for (const row of rows) {
    const entry = byVendor.get(row.vendorId) ?? { ...EMPTY_PRODUCT_ROLES };
    if (row.role === 'application' || row.role === 'connector' || row.role === 'hybrid') {
      entry[row.role] += row.value;
    }
    entry.total += row.value;
    byVendor.set(row.vendorId, entry);
  }
  return byVendor;
}

/**
 * §8.8(1)'s test, stated positively: owns at least one product, and every one of
 * them is a connector.
 *
 * Written as `connector === total` rather than `application === 0 && hybrid === 0`
 * so an unrecognised role (see `foldProductRoleGroups`) fails it rather than
 * passing by omission.
 */
export function isPureConnectorVendor(roles: VendorProductRoles): boolean {
  return roles.total > 0 && roles.connector === roles.total;
}
