/**
 * The listing-visibility predicate, raw-SQL form (AECI-1238, ADR 0052).
 *
 * A `vendors` or `products` row is VISIBLE when `hidden_at IS NULL`. AECi hides a
 * listing through `POST /api/admin/{vendors,products}/:id/hide` and restores it.
 * A hidden row keeps all of its data, but it renders on no public page, counts
 * nowhere, is in no Algolia id set and is absent from the sitemap. A company hide
 * hides every product joined to it, so a product read needs only the product's own
 * column.
 *
 * An integration or evidenced pair that touches a hidden product is not live
 * either. That clause lives in the live predicate itself
 * (`live-integration.ts`), so every site that already filters retired rows filters
 * these too.
 *
 * This module is the string half, for the sites that write SQL by hand and cannot
 * import from `apps/api`: the datatool reindex and prune, the catalog agent and the
 * API's operator scripts. The Drizzle half is `apps/api/src/lib/listing-visibility.ts`.
 *
 * Rules:
 *
 * 1. **`IS NULL`, never `= NULL`.** As for `retired_at`.
 * 2. **The endpoint subquery names its own alias (`lh_hp`) and reads only
 *    `hidden_at` and `id` from it.** The outer columns it compares are the
 *    integration's. `products` has none of those column names, so even an
 *    unqualified outer column cannot be captured by the subquery's table.
 * 3. **Tools against a deployed database probe the column first.** Migration
 *    `0113` reaches each tier only at its next deploy. {@link visibleProductSqlIf}
 *    degrades to always-true when the column is absent, which is also correct: a
 *    database without the column cannot hold a hidden row.
 */

/** The column on `vendors` and `products`. */
export const LISTING_HIDDEN_COLUMN = 'hidden_at';

/** `<alias>."hidden_at" IS NULL`: the product is on the public site. */
export function visibleProductSql(alias: string): string {
  return `${alias}."${LISTING_HIDDEN_COLUMN}" IS NULL`;
}

/** `<alias>."hidden_at" IS NULL`: the company is on the public site. */
export function visibleVendorSql(alias: string): string {
  return `${alias}."${LISTING_HIDDEN_COLUMN}" IS NULL`;
}

/** The alias the endpoint subquery gives `products`. Exported for the source scans. */
export const HIDDEN_ENDPOINT_ALIAS = 'lh_hp';

/**
 * `NOT EXISTS` a hidden product among the given column expressions. Each expression
 * is an outer column, already qualified (`i.source_product_id`). A NULL among them
 * (an integration with no connector) matches nothing, which is the intent.
 */
export function endpointsVisibleSql(columns: readonly string[]): string {
  return `NOT EXISTS (SELECT 1 FROM products ${HIDDEN_ENDPOINT_ALIAS} WHERE ${HIDDEN_ENDPOINT_ALIAS}."id" IN (${columns.join(', ')}) AND ${HIDDEN_ENDPOINT_ALIAS}."${LISTING_HIDDEN_COLUMN}" IS NOT NULL)`;
}

/** The read that returns the `products` table's `CREATE TABLE` text. */
export const PRODUCTS_DDL_QUERY = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'`;

/** The read that returns the `vendors` table's `CREATE TABLE` text. */
export const VENDORS_DDL_QUERY = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vendors'`;

/**
 * Does this `CREATE TABLE` text declare `hidden_at`? Same parse as
 * `ddlHasRetiredColumn`: a declared type must follow the name.
 */
export function ddlHasHiddenColumn(ddl: string | null | undefined): boolean {
  if (typeof ddl !== 'string') return false;
  return new RegExp(
    `[(,]\\s*[\`"\\[]?${LISTING_HIDDEN_COLUMN}[\`"\\]]?\\s+(text|integer|int|real|blob|numeric)\\b`,
    'i',
  ).test(ddl);
}

/**
 * The DDL text out of a {@link PRODUCTS_DDL_QUERY} or {@link VENDORS_DDL_QUERY} read,
 * or a THROW. An empty read is "could not check", never "no column".
 */
export function listingDdlOrThrow(sql: unknown, table: 'products' | 'vendors'): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error(
      `Could not read the ${table} table definition from sqlite_master, so hidden listings cannot be excluded. Refusing to continue.`,
    );
  }
  return sql;
}

/** {@link visibleProductSql} when the column exists, else the always-true `1 = 1`. */
export function visibleProductSqlIf(alias: string, hasHiddenColumn: boolean): string {
  return hasHiddenColumn ? visibleProductSql(alias) : '1 = 1';
}

/** {@link visibleVendorSql} when the column exists, else the always-true `1 = 1`. */
export function visibleVendorSqlIf(alias: string, hasHiddenColumn: boolean): string {
  return hasHiddenColumn ? visibleVendorSql(alias) : '1 = 1';
}

/** {@link endpointsVisibleSql} when the column exists, else the always-true `1 = 1`. */
export function endpointsVisibleSqlIf(
  columns: readonly string[],
  hasHiddenColumn: boolean,
): string {
  return hasHiddenColumn ? endpointsVisibleSql(columns) : '1 = 1';
}
