/**
 * Which connector catalogues a vendor may read and edit (AECI-1083 —
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16).
 *
 * ONE predicate, three readers:
 *
 *   - `GET /api/vendor/products/:id/connector-catalog` — the Catalogue tab's read;
 *   - `GET /api/vendor/updates` — the `catalogue` cursor scope;
 *   - and, in spirit, `PATCH /api/vendor/connector-stub-mappings/:id`, whose inline
 *     ownership check (`routes/vendor-connector-stub-mappings.ts`) is the same three
 *     clauses. That route is AECI-724's and is deliberately not edited here; the
 *     lockstep between the two is pinned by `routes/vendor-connector-catalog.spec.ts`,
 *     which asserts that every row the read shows is one the PATCH accepts.
 *
 * The clauses: the catalogue's `connector_product_id` is held by the caller's vendor
 * through `product_vendors`, AND that product is `connector`-role. A vendor holding
 * the product in some other role reads nothing, exactly as its PATCH is a 404.
 *
 * No `vendor_entitlements` read and no capability: the §8.9 seat has neither
 * (`STAGE_2_SPEC.md` §8.9(2)).
 *
 * Behind `/api/vendor/*` there is no RLS, so this `WHERE` IS the authorization, and the
 * cursor must scope identically to the read (`STAGE_2_REALTIME_SPEC.md` §2.2): too
 * narrow and the tab is never live, too wide and the timestamp leaks another vendor's
 * catalogue. Both import this function for that reason.
 */

import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorCatalogs, productVendors, products } from '../db/schema';

/** `connector_catalogs.id` for every catalogue the vendor may maintain. A subquery,
 *  for `inArray(…, ownedConnectorCatalogIds(db, vendorId))`. */
export function ownedConnectorCatalogIds(db: Db, vendorId: string) {
  return db
    .select({ id: connectorCatalogs.id })
    .from(connectorCatalogs)
    .innerJoin(productVendors, eq(productVendors.productId, connectorCatalogs.connectorProductId))
    .innerJoin(products, eq(products.id, connectorCatalogs.connectorProductId))
    .where(and(eq(productVendors.vendorId, vendorId), eq(products.productRole, 'connector')));
}
