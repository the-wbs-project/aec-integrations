/**
 * The listing-visibility predicate, Drizzle form (AECI-1238, ADR 0052,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6).
 *
 * A `vendors` or `products` row is VISIBLE when `hidden_at IS NULL`. AECi hides a
 * listing through the admin hide routes (`routes/admin-listing-hide.ts`); the data
 * stays, so a restore is lossless. A company hide sets `hidden_at` on every product
 * joined to it, so a product read tests the product's own column and never the
 * company's.
 *
 * Every public read of a product or a company goes through {@link visibleProductOn}
 * or {@link visibleVendorOn}: the lists, the detail lookups, the embeds, the counts,
 * the sitemap, the home stats, the slug redirects and the public entry points
 * (review submit, claim and correction targets). An integration or evidenced pair
 * touching a hidden product is not live (`live-integration.ts`), through
 * {@link noHiddenEndpointOn}.
 *
 * The raw-SQL twin is `@aeci/shared/listing-visibility`, for the datatool, the agent
 * and the operator scripts.
 *
 * Column-based, like `liveIntegrationOn`, so it works over an `alias()` and inside a
 * nested relation `where`. {@link noHiddenEndpointOn} is the one exception that needs
 * care: Drizzle re-aliases EVERY Column inside a relation `where`, including a
 * `products` column in a subquery. So the subquery names `products` under a raw alias
 * and reads its columns as raw text, and only the outer integration columns are
 * interpolated as Columns.
 */

import { HIDDEN_ENDPOINT_ALIAS, LISTING_HIDDEN_COLUMN } from '@aeci/shared';
import { isNotNull, isNull, sql, type Column, type SQL } from 'drizzle-orm';

import { products, vendors } from '../db/schema';

/** Visible over any table object carrying the column, including an `alias()`. */
export function visibleProductOn(t: { readonly hiddenAt: Column }): SQL {
  return isNull(t.hiddenAt);
}

/** Visible over `vendors`, or an `alias()` of it. */
export function visibleVendorOn(t: { readonly hiddenAt: Column }): SQL {
  return isNull(t.hiddenAt);
}

/** `products.hidden_at IS NULL`, for the unaliased table. */
export const visibleProductWhere: SQL = visibleProductOn(products);

/** `products.hidden_at IS NOT NULL`, the exact complement. */
export const hiddenProductWhere: SQL = isNotNull(products.hiddenAt);

/** `vendors.hidden_at IS NULL`, for the unaliased table. */
export const visibleVendorWhere: SQL = visibleVendorOn(vendors);

/** `vendors.hidden_at IS NOT NULL`, the exact complement. */
export const hiddenVendorWhere: SQL = isNotNull(vendors.hiddenAt);

const HIDDEN_ALIAS = sql.raw(HIDDEN_ENDPOINT_ALIAS);
const HIDDEN_COLUMN = sql.raw(`"${LISTING_HIDDEN_COLUMN}"`);

/**
 * `NOT EXISTS` a hidden product whose id is one of `columns`. The columns are the
 * outer row's (an integration's source, target and connector). A NULL column, such
 * as an unpowered integration's connector, matches nothing.
 */
export function noHiddenEndpointOn(columns: readonly Column[]): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM products ${HIDDEN_ALIAS} WHERE ${HIDDEN_ALIAS}."id" IN (${sql.join(
    [...columns],
    sql`, `,
  )}) AND ${HIDDEN_ALIAS}.${HIDDEN_COLUMN} IS NOT NULL)`;
}

/** For a raw `sql` template over a literal alias (`"products"`, `p`): the product
 *  is visible. The relational `extras` sites use this with the schema-key alias. */
export function visibleProductRaw(alias: string): SQL {
  return sql.raw(`${alias}."${LISTING_HIDDEN_COLUMN}" IS NULL`);
}
