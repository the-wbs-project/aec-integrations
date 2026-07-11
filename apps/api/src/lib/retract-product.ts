/**
 * retract-product — the testable core of the Tier-0 product-retraction ops CLI
 * (`apps/api/scripts/retract-product.ts`).
 *
 * WHY THIS EXISTS. There is no product-delete path in the app: `POST /api/promote`
 * only ever UPSERTs (idempotent), and nothing deletes. So removing a promoted
 * product — the common case being a duplicate/stub that got promoted with a
 * disambiguated slug (`box` already existed → the dupe became `box-2`) — is a
 * manual operation against the deployed D1. This module holds the *pure* pieces
 * of that operation (SQL builders, footprint classification, cache-tag set,
 * report formatting) so they can be unit-tested without a live database or
 * `wrangler`; the CLI shell supplies argv, the `wrangler d1 execute` I/O, Algolia
 * credentials, and `console`. Split mirrors `algolia-orphan-purge.ts` /
 * `reconcile-product-counts.ts`.
 *
 * WHAT A PRODUCT DELETE TOUCHES (schema, `apps/api/src/db/schema.ts`). Two FKs to
 * `products.id` are RESTRICT (no `onDelete`) and would BLOCK a bare delete:
 * `page_views.product_id` and `integrations.powered_by_product_id`. The rest
 * cascade. To be correct regardless of whether D1 has FK enforcement/cascade on
 * for a given `wrangler d1 execute`, `buildDeleteStatements` deletes children
 * before parents EXPLICITLY (and NULLs the nullable `powered_by` ref) rather than
 * relying on cascade — so it works the same with FKs on or off.
 *
 * CAVEAT (§26.1). A raw delete emits no `audit_log` row (there is no handler to
 * route it through). That is inherent to Tier 0 — the audited path is the future
 * Tier-1 `retract` endpoint (the inverse of promote). The CLI prints this caveat.
 */

/** SQLite string-literal escape: double any single quote. Ids/slugs are the only
 *  interpolated values and are matched against `products` rows, but escape anyway
 *  so a slug with an apostrophe can't break (or inject) the statement. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** How the operator named the product to retract: by slug (usual) or raw id. */
export type RetractTarget = { slug: string } | { id: string };

/** Column of `products` a target resolves against, quoted-escaped literal value. */
function targetPredicate(target: RetractTarget): string {
  return 'slug' in target
    ? `"slug" = '${escapeSqlLiteral(target.slug)}'`
    : `"id" = '${escapeSqlLiteral(target.id)}'`;
}

/** The identity row read first — resolves the target to a concrete id + slug and
 *  surfaces the name/status for the confirmation report. */
export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  promotion_status: string;
}

export function buildProductLookupSql(target: RetractTarget): string {
  return `SELECT "id", "slug", "name", "promotion_status" FROM "products" WHERE ${targetPredicate(
    target,
  )} LIMIT 1;`;
}

/**
 * One-row footprint: every table that references the product, plus the taxonomy
 * slugs needed to build the cache-tag purge set. All scalar subqueries in a single
 * SELECT (not a compound UNION — D1 caps compound-SELECT terms low, ~10). The
 * escaped product id is interpolated as a quoted literal into every subquery.
 */
export function buildFootprintSql(id: string): string {
  const p = `'${escapeSqlLiteral(id)}'`;
  return `SELECT
    (SELECT count(*) FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p}) AS integrations,
    (SELECT count(*) FROM "integrations" WHERE "powered_by_product_id" = ${p}) AS powered_by,
    (SELECT count(*) FROM "claims" WHERE "integration_id" IN
       (SELECT "id" FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p})) AS claims,
    (SELECT count(*) FROM "reviews" WHERE "product_id" = ${p}) AS reviews,
    (SELECT count(*) FROM "page_views" WHERE "product_id" = ${p}) AS page_views,
    (SELECT count(*) FROM "product_vendors" WHERE "product_id" = ${p}) AS product_vendors,
    (SELECT count(*) FROM "product_categories" WHERE "product_id" = ${p}) AS product_categories,
    (SELECT count(*) FROM "product_audiences" WHERE "product_id" = ${p}) AS product_audiences,
    (SELECT count(*) FROM "product_phases" WHERE "product_id" = ${p}) AS product_phases,
    (SELECT count(*) FROM "product_extensions" WHERE "product_id" = ${p} OR "host_product_id" = ${p}) AS product_extensions,
    (SELECT group_concat(tc."slug") FROM "product_categories" pc JOIN "taxonomy_categories" tc ON tc."id" = pc."category_id" WHERE pc."product_id" = ${p}) AS category_slugs,
    (SELECT group_concat(ta."slug") FROM "product_audiences" pa JOIN "taxonomy_audiences" ta ON ta."id" = pa."audience_id" WHERE pa."product_id" = ${p}) AS audience_slugs,
    (SELECT group_concat(tp."slug") FROM "product_phases" pp JOIN "taxonomy_phases" tp ON tp."id" = pp."phase_id" WHERE pp."product_id" = ${p}) AS phase_slugs;`;
}

/** Raw footprint row as D1 returns it (`group_concat` → comma string or null). */
export interface RawFootprintRow {
  integrations: number;
  powered_by: number;
  claims: number;
  reviews: number;
  page_views: number;
  product_vendors: number;
  product_categories: number;
  product_audiences: number;
  product_phases: number;
  product_extensions: number;
  category_slugs: string | null;
  audience_slugs: string | null;
  phase_slugs: string | null;
}

export interface RetractFootprint {
  integrations: number;
  poweredBy: number;
  claims: number;
  reviews: number;
  pageViews: number;
  productVendors: number;
  productCategories: number;
  productAudiences: number;
  productPhases: number;
  productExtensions: number;
  categorySlugs: string[];
  audienceSlugs: string[];
  phaseSlugs: string[];
}

function splitConcat(value: string | null): string[] {
  return value ? value.split(',').filter((s) => s.length > 0) : [];
}

export function parseFootprint(row: RawFootprintRow): RetractFootprint {
  return {
    integrations: row.integrations,
    poweredBy: row.powered_by,
    claims: row.claims,
    reviews: row.reviews,
    pageViews: row.page_views,
    productVendors: row.product_vendors,
    productCategories: row.product_categories,
    productAudiences: row.product_audiences,
    productPhases: row.product_phases,
    productExtensions: row.product_extensions,
    categorySlugs: splitConcat(row.category_slugs),
    audienceSlugs: splitConcat(row.audience_slugs),
    phaseSlugs: splitConcat(row.phase_slugs),
  };
}

/**
 * Is this a clean "empty stub" (safe to hard-delete), or does it carry real
 * content that a delete would cascade away? A product is UNSAFE to delete without
 * `--force` if it participates in any integration (as endpoint or `powered_by`)
 * or has any review — those represent editorial/user content that should be
 * re-pointed to the canonical product (the future merge-then-retract tool), not
 * destroyed. Join-table links (vendor/category/…) and page_views are cosmetic
 * and always cleaned up. `blockers` explains the refusal to the operator.
 */
export interface RetractionClassification {
  safe: boolean;
  blockers: string[];
}

export function classifyRetraction(footprint: RetractFootprint): RetractionClassification {
  const blockers: string[] = [];
  if (footprint.integrations > 0)
    blockers.push(`${footprint.integrations} integration(s) (as source/target)`);
  if (footprint.poweredBy > 0)
    blockers.push(`${footprint.poweredBy} integration(s) list it as \`powered_by\``);
  if (footprint.reviews > 0) blockers.push(`${footprint.reviews} review(s)`);
  return { safe: blockers.length === 0, blockers };
}

/**
 * Ordered DELETE/UPDATE statements to remove the product and everything that hangs
 * off it. Children before parents, so it is correct whether or not D1 enforces the
 * FKs/cascades for this `execute`. Statements against empty tables are harmless
 * no-ops (the clean-stub case runs the same set). The final statement removes the
 * product row itself.
 */
export function buildDeleteStatements(id: string): string[] {
  const p = `'${escapeSqlLiteral(id)}'`;
  const endpointIntegrations = `SELECT "id" FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p}`;
  return [
    // attestations → claims → integrations (deepest child first).
    `DELETE FROM "attestations" WHERE "claim_id" IN (SELECT "id" FROM "claims" WHERE "integration_id" IN (${endpointIntegrations}));`,
    `DELETE FROM "claims" WHERE "integration_id" IN (${endpointIntegrations});`,
    // NULL the nullable RESTRICT ref before deleting the integrations it points at.
    `UPDATE "integrations" SET "powered_by_product_id" = NULL WHERE "powered_by_product_id" = ${p};`,
    `DELETE FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p};`,
    // Direct children of the product.
    `DELETE FROM "reviews" WHERE "product_id" = ${p};`,
    `DELETE FROM "page_views" WHERE "product_id" = ${p};`, // RESTRICT blocker — must precede the product delete.
    `DELETE FROM "product_categories" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_audiences" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_phases" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_vendors" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_extensions" WHERE "product_id" = ${p} OR "host_product_id" = ${p};`,
    // The product itself, last.
    `DELETE FROM "products" WHERE "id" = ${p};`,
  ];
}

/**
 * Cache-Tags to purge so no edge-cached page keeps rendering the deleted product.
 * Matches the tags the SSR responses actually set (`apps/web/src/server/cache-tags.ts`):
 * the product detail page (`product:<slug>`), the products index (`index:products`),
 * and each browse page the product appeared on (`category|audience|phase:<slug>`).
 */
export function buildCacheTagsForProduct(slug: string, footprint: RetractFootprint): string[] {
  const tags = [`product:${slug}`, 'index:products'];
  for (const s of footprint.categorySlugs) tags.push(`category:${s}`);
  for (const s of footprint.audienceSlugs) tags.push(`audience:${s}`);
  for (const s of footprint.phaseSlugs) tags.push(`phase:${s}`);
  return [...new Set(tags)];
}

/** Human-readable footprint block for the dry-run / pre-apply report. */
export function formatFootprintReport(product: ProductRow, footprint: RetractFootprint): string {
  const rows: Array<[string, number]> = [
    ['integrations (source/target)', footprint.integrations],
    ['integrations powered_by', footprint.poweredBy],
    ['claims', footprint.claims],
    ['reviews', footprint.reviews],
    ['page_views', footprint.pageViews],
    ['product_vendors', footprint.productVendors],
    ['product_categories', footprint.productCategories],
    ['product_audiences', footprint.productAudiences],
    ['product_phases', footprint.productPhases],
    ['product_extensions', footprint.productExtensions],
  ];
  const lines = [
    `Product:  ${product.name}  (slug: ${product.slug})`,
    `Id:       ${product.id}`,
    `Status:   ${product.promotion_status}`,
    '',
    'Footprint (rows that will be removed / detached):',
    ...rows.map(([label, n]) => `  ${n === 0 ? ' ' : '•'} ${label.padEnd(30)} ${n}`),
  ];
  return lines.join('\n');
}
