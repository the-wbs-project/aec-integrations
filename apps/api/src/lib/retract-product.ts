/**
 * retract-product — the testable core of the Tier-0 product-retraction ops CLI
 * (`apps/api/scripts/retract-product.ts`).
 *
 * WHY THIS EXISTS. There is no product-delete path in the app: `POST /api/promote`
 * only ever UPSERTs (idempotent), and nothing deletes. So removing a promoted
 * product — the common case being a duplicate/stub that got promoted with a
 * disambiguated slug (`box` already existed → the dupe became `box-2`) — is a
 * manual operation against the deployed D1. This module holds the *pure* pieces
 * of that operation (SQL builders, footprint classification, the tombstone
 * INSERTs, cache-tag set, report formatting) so they can be unit-tested without a
 * live database or `wrangler`; the CLI shell supplies argv, the `wrangler d1
 * execute` I/O, Algolia credentials, and `console`. Split mirrors
 * `algolia-orphan-purge.ts` / `reconcile-product-counts.ts` / `retract-vendor.ts`.
 *
 * WHAT POINTS AT `products` (schema snapshot `apps/api/migrations/meta/0043_snapshot.json`).
 * Every foreign key into the table has an explicit outcome in `PRODUCT_FK_HANDLING`,
 * and `retract-product-fk-coverage.spec.ts` fails when the latest snapshot carries one
 * that does not — so the next table cannot become a silent cascade (AECI-687):
 *
 *   table                      column                 on delete   this lane
 *   ─────────────────────────  ─────────────────────  ──────────  ──────────────────────────────
 *   connector_catalogs         connector_product_id   cascade     REFUSE, even with --force
 *   connector_stub_mappings    product_id             set null    REFUSE, even with --force
 *   integrations               source_product_id      cascade     --force; deleted + tombstoned
 *   integrations               target_product_id      cascade     --force; deleted + tombstoned
 *   integrations               powered_by_product_id  —           --force; NULLed + tombstoned
 *   connector_evidenced_pairs  connector_product_id   cascade     --delete-evidenced-pairs; deleted + tombstoned
 *   connector_evidenced_pairs  product_a_id           cascade     --delete-evidenced-pairs; deleted + tombstoned
 *   connector_evidenced_pairs  product_b_id           cascade     --delete-evidenced-pairs; deleted + tombstoned
 *   reviews                    product_id             cascade     --force; deleted + tombstoned
 *   product_versions           product_id             cascade     --force; deleted + tombstoned
 *   product_vendors / _categories / _audiences / _phases / _trades,
 *   product_extensions (product_id AND host_product_id)
 *                                                     cascade     facet; deleted, counted on the
 *                                                                 product's own tombstone
 *   page_views                 product_id             —           log-class; NULLed, never deleted
 *
 * The rows this lane deletes have children of their own, and those are covered the
 * same way by `CASCADE_CHILD_HANDLING` (claims → attestations, field contests, the
 * two attestation version refs).
 *
 * A THIRD REFUSAL, also under --force: a vendor-held integration (AECI-1005 / ADR 0035).
 * An endpoint integration its owner has CLAIMED (`claimed_at` set) or a vendor CREATED
 * (`origin = 'vendor'`) belongs to the vendor, and retracting one of its endpoint
 * products would cascade it away with its claims, attestations and contests. That is
 * the same rule the retraction consumer enforces, and like there it is not something
 * `--force` can waive: the vendor has to retire the row (AECI-1010) or AECi has to rule
 * on it first. The count degrades to 0 on a database without migration 0044's
 * columns, where no row can be vendor-held (`buildFootprintSql`'s option).
 *
 * The same refusal covers a vendor-held CONNECTOR-EVIDENCED PAIR (AECI-1088). Migration
 * 0048 gave `connector_evidenced_pairs` the same two columns, and the owner carve-out
 * lets an owner hold a pair. `--delete-evidenced-pairs` authorises deleting AECi-seeded
 * pairs only: a vendor-held pair is refused with that flag, with `--force`, and with
 * both. Its count degrades to 0 on a database without 0048's columns.
 *
 * Why the two refusals hold even under --force. A connector catalogue and its stub
 * mappings are a mirror the connector-catalogue sync owns (`POST
 * /api/promote/connector-catalog`, `docs/REVIEW_APP_PROMOTE_API.md` §3a). Deleting the
 * connector product would cascade the whole catalogue — surfaces, stubs, mappings,
 * pairs — and NULLing a mapping's product would silently change the reach line on
 * every endpoint it served. Neither is a product-level decision. Unmap or retire the
 * catalogue upstream and let the sync carry it, then retract.
 *
 * Why evidenced pairs have a flag of their own (AECI-904). A connector-evidenced pair is
 * a delivered edge between two OTHER products when the retracted product is the
 * connector, so retracting one connector silently removes every pair it powers, with
 * their claims and attestations two cascade levels down (ADR 0018). Agave ERP Sync,
 * Aquifer and Trimble AppXchange each carry 16 to 22. `--force` is the flag an
 * operator reaches for to clear a duplicate stub's integrations, and it must not also
 * be the flag that takes a connector's whole delivered tier. So pairs refuse unless
 * `--delete-evidenced-pairs` is passed, `--force` or not, and the footprint reports
 * them per role (connector / endpoint A / endpoint B). Without the flag the product
 * DELETE is also guarded on no pair existing, so a pair that appears between the
 * check and the apply blocks the delete instead of cascading away uncounted.
 *
 * D1 ENFORCES FOREIGN KEYS, and `PRAGMA foreign_keys` cannot be turned off there
 * (see `retract-vendor.ts`). `buildDeleteStatements` therefore deletes children
 * before parents and writes every SET NULL explicitly rather than leaning on the FK
 * action, so the list reads the same as it behaves.
 *
 * AUDIT (§26.1, AECI-687). Every row this lane removes that §26.1 calls domain state
 * gets a tombstone, in the SAME `wrangler d1 execute` batch as the delete:
 *   - `product.deleted`, one row, whose `before_state` carries the product row plus
 *     the counts of every facet row and page view that went with it;
 *   - `integration.deleted`, one per endpoint integration AND one per connector-
 *     evidenced pair, told apart by `metadata.table` — the shape
 *     `scripts/ops/2026-09-retraction-consumer/consume.mjs` already writes, with the
 *     claim / attestation / contest counts in `before_state.cascade`;
 *   - `integration.updated`, one per integration whose `powered_by` is NULLed;
 *   - `review.deleted` and `product_version.deleted`, one per row.
 * Claims, attestations and facet rows are counted on their parent's tombstone rather
 * than tombstoned themselves, the same granularity `consume.mjs` chose. The per-row
 * tombstones are `INSERT … SELECT`s that run BEFORE their delete, because the rows
 * must still exist to be read. `actor_type` is `'system'`, matching
 * `retract-vendor.ts`; the operator is named in `metadata.operator`.
 */

import { pairCacheTag } from '../routes/promote-pair';

/** SQLite string-literal escape: double any single quote. Ids/slugs are the only
 *  interpolated values and are matched against `products` rows, but escape anyway
 *  so a slug with an apostrophe can't break (or inject) the statement. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// ─── FK handling (the table in the header, as data) ─────────────────────────

/**
 * What this lane does with one foreign key.
 *  - `refuse`          counted; the retraction is refused, `--force` or not.
 *  - `force-tombstone` counted; refused without `--force`; with it, every row is
 *                      deleted and gets its own tombstone.
 *  - `flag-tombstone`  counted; refused without `--delete-evidenced-pairs` (`--force`
 *                      does not cover it); with it, deleted and tombstoned (AECI-904).
 *  - `force-detach`    counted; refused without `--force`; with it, the column is
 *                      NULLed and every row gets an `*.updated` tombstone.
 *  - `facet`           counted; always deleted; recorded on the product's tombstone.
 *  - `detach`          log-class; the column is NULLed, the row is never deleted.
 *  - `cascade-child`   a child of a row this lane deletes; deleted explicitly and
 *                      counted on that parent's tombstone.
 */
export type FkOutcome =
  | 'refuse'
  | 'force-tombstone'
  | 'flag-tombstone'
  | 'force-detach'
  | 'facet'
  | 'detach'
  | 'cascade-child';

/** Every FK into `products`, keyed `table.column`. Pinned to the latest migration
 *  snapshot by `retract-product-fk-coverage.spec.ts`. */
export const PRODUCT_FK_HANDLING: Readonly<Record<string, FkOutcome>> = {
  'connector_catalogs.connector_product_id': 'refuse',
  'connector_stub_mappings.product_id': 'refuse',
  'integrations.source_product_id': 'force-tombstone',
  'integrations.target_product_id': 'force-tombstone',
  'integrations.powered_by_product_id': 'force-detach',
  'connector_evidenced_pairs.connector_product_id': 'flag-tombstone',
  'connector_evidenced_pairs.product_a_id': 'flag-tombstone',
  'connector_evidenced_pairs.product_b_id': 'flag-tombstone',
  'reviews.product_id': 'force-tombstone',
  'product_versions.product_id': 'force-tombstone',
  'product_vendors.product_id': 'facet',
  'product_categories.product_id': 'facet',
  'product_audiences.product_id': 'facet',
  'product_phases.product_id': 'facet',
  'product_trades.product_id': 'facet',
  'product_extensions.product_id': 'facet',
  'product_extensions.host_product_id': 'facet',
  'page_views.product_id': 'detach',
};

/** Every FK into a table this lane DELETEs from (other than `products` itself),
 *  keyed `table.column`. The spec derives that table set from
 *  `buildDeleteStatements`, so a new delete target is covered automatically. */
export const CASCADE_CHILD_HANDLING: Readonly<Record<string, FkOutcome>> = {
  'claims.integration_id': 'cascade-child',
  'claims.connector_evidenced_pair_id': 'cascade-child',
  'attestations.claim_id': 'cascade-child',
  'integration_field_challenges.integration_id': 'cascade-child',
  // AECI-1007. Deleted explicitly, and counted on the integration's tombstone, only
  // where the table exists (`vendorLinksTable`): migration 0045 reaches each tier at
  // its next deploy, and naming a missing table would fail the whole batch.
  'integration_vendor_links.integration_id': 'cascade-child',
  'attestations.introduced_version_id': 'detach',
  'attestations.deprecated_version_id': 'detach',
};

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

/** Subqueries shared by the footprint read and the delete plan, so the two can never
 *  disagree about which rows "belong to" the product. `includePairs: false` is the
 *  delete plan without `--delete-evidenced-pairs`: the claims on a pair are then out of
 *  scope, so a pair that appeared after the check keeps its curation data. */
function scopes(p: string, opts: { includePairs: boolean } = { includePairs: true }) {
  const integrations = `SELECT "id" FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p}`;
  const pairs = `SELECT "id" FROM "connector_evidenced_pairs" WHERE "connector_product_id" = ${p} OR "product_a_id" = ${p} OR "product_b_id" = ${p}`;
  const claims = opts.includePairs
    ? `SELECT "id" FROM "claims" WHERE "integration_id" IN (${integrations}) OR "connector_evidenced_pair_id" IN (${pairs})`
    : `SELECT "id" FROM "claims" WHERE "integration_id" IN (${integrations})`;
  const versions = `SELECT "id" FROM "product_versions" WHERE "product_id" = ${p}`;
  // A `powered_by` row that is ALSO an endpoint integration is deleted, not detached,
  // so it gets the `integration.deleted` tombstone and not a second one.
  const poweredOnly = `"powered_by_product_id" = ${p} AND "source_product_id" <> ${p} AND "target_product_id" <> ${p}`;
  return { integrations, pairs, claims, versions, poweredOnly };
}

/**
 * One-row footprint: every table that references the product, plus the taxonomy
 * slugs needed to build the cache-tag purge set. All scalar subqueries in a single
 * SELECT (not a compound UNION — D1 caps compound-SELECT terms low). The escaped
 * product id is interpolated as a quoted literal into every subquery.
 */
/**
 * Does this `CREATE TABLE` text (from `sqlite_master.sql`) declare both vendor-held
 * columns? The TypeScript twin of `ddlHasColumn` in
 * `scripts/ops/2026-09-retraction-consumer/vendor-held.mjs`, which this package cannot
 * import. A declared type must follow the name, so a CHECK expression does not count.
 */
export function ddlHasVendorHeldColumns(ddl: string | null | undefined): boolean {
  // Used for both anchor tables: `integrations` (migration 0044) and
  // `connector_evidenced_pairs` (migration 0048, AECI-1088).
  if (typeof ddl !== 'string') return false;
  const has = (column: string) =>
    new RegExp(
      `[(,]\\s*[\`"\\[]?${column}[\`"\\]]?\\s+(text|integer|int|real|blob|numeric)\\b`,
      'i',
    ).test(ddl);
  return has('claimed_at') && has('origin');
}

/** The DDL probe the CLI runs before {@link buildFootprintSql}. */
export const INTEGRATIONS_DDL_SQL = `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'integrations';`;

/** AECI-1088: the same probe for `connector_evidenced_pairs`, whose vendor-held columns
 *  arrive with migration 0048. */
export const EVIDENCED_PAIRS_DDL_SQL = `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'connector_evidenced_pairs';`;

/** AECI-1007: does the per-side links table exist on this tier yet? One row when it
 *  does, none when migration 0045 has not reached it. */
export const VENDOR_LINKS_TABLE_SQL = `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'integration_vendor_links';`;

export function buildFootprintSql(
  id: string,
  opts: {
    vendorHeldColumns?: boolean;
    /** AECI-1088: `connector_evidenced_pairs` has migration 0048's columns. */
    vendorHeldPairColumns?: boolean;
    vendorLinksTable?: boolean;
  } = {},
): string {
  const p = `'${escapeSqlLiteral(id)}'`;
  const s = scopes(p);
  // AECI-1007: per-side links the delete removes. Those on an endpoint integration
  // (the cascade), plus any link that names this product on a row it no longer sits
  // on (an endpoint re-point leaves the old product's link stored, and `product_id`
  // has no FK to clear it). The schema at HEAD has the table, so the default is
  // true; the CLI passes its probe.
  const vendorLinks =
    (opts.vendorLinksTable ?? true)
      ? `(SELECT count(*) FROM "integration_vendor_links" WHERE "integration_id" IN (${s.integrations}) OR "product_id" = ${p})`
      : '0';
  // AECI-1005: endpoint integrations the delete would cascade that are vendor-held,
  // plus `powered_by` rows it would detach. NULL-safe 0 when the columns are absent.
  const vendorHeld = opts.vendorHeldColumns
    ? `(SELECT count(*) FROM "integrations" WHERE ("id" IN (${s.integrations}) OR ${s.poweredOnly}) AND ("claimed_at" IS NOT NULL OR "origin" = 'vendor'))`
    : '0';
  // AECI-1088: pairs the product touches, in any of the three roles, that are
  // vendor-held. Counted whatever `--delete-evidenced-pairs` says, because that flag
  // never authorises deleting one.
  const vendorHeldPairs = opts.vendorHeldPairColumns
    ? `(SELECT count(*) FROM "connector_evidenced_pairs" WHERE "id" IN (${s.pairs}) AND ("claimed_at" IS NOT NULL OR "origin" = 'vendor'))`
    : '0';
  return `SELECT
    ${vendorHeld} AS vendor_held_integrations,
    ${vendorHeldPairs} AS vendor_held_evidenced_pairs,
    (SELECT count(*) FROM "connector_catalogs" WHERE "connector_product_id" = ${p}) AS connector_catalogs,
    (SELECT count(*) FROM "connector_stub_mappings" WHERE "product_id" = ${p}) AS stub_mappings,
    (SELECT count(*) FROM (${s.integrations})) AS integrations,
    (SELECT count(*) FROM "integrations" WHERE ${s.poweredOnly}) AS powered_by,
    (SELECT count(*) FROM (${s.pairs})) AS evidenced_pairs,
    (SELECT count(*) FROM "connector_evidenced_pairs" WHERE "connector_product_id" = ${p}) AS evidenced_pairs_as_connector,
    (SELECT count(*) FROM "connector_evidenced_pairs" WHERE "product_a_id" = ${p}) AS evidenced_pairs_as_a,
    (SELECT count(*) FROM "connector_evidenced_pairs" WHERE "product_b_id" = ${p}) AS evidenced_pairs_as_b,
    (SELECT count(*) FROM (${s.claims})) AS claims,
    (SELECT count(*) FROM "attestations" WHERE "claim_id" IN (${s.claims})) AS attestations,
    (SELECT count(*) FROM "integration_field_challenges" WHERE "integration_id" IN (${s.integrations})) AS field_challenges,
    ${vendorLinks} AS vendor_links,
    (SELECT count(*) FROM "reviews" WHERE "product_id" = ${p}) AS reviews,
    (SELECT count(*) FROM "product_versions" WHERE "product_id" = ${p}) AS product_versions,
    (SELECT count(*) FROM "page_views" WHERE "product_id" = ${p}) AS page_views,
    (SELECT count(*) FROM "product_vendors" WHERE "product_id" = ${p}) AS product_vendors,
    (SELECT count(*) FROM "product_categories" WHERE "product_id" = ${p}) AS product_categories,
    (SELECT count(*) FROM "product_audiences" WHERE "product_id" = ${p}) AS product_audiences,
    (SELECT count(*) FROM "product_phases" WHERE "product_id" = ${p}) AS product_phases,
    (SELECT count(*) FROM "product_trades" WHERE "product_id" = ${p}) AS product_trades,
    (SELECT count(*) FROM "product_extensions" WHERE "product_id" = ${p} OR "host_product_id" = ${p}) AS product_extensions,
    (SELECT group_concat(tc."slug") FROM "product_categories" pc JOIN "taxonomy_categories" tc ON tc."id" = pc."category_id" WHERE pc."product_id" = ${p}) AS category_slugs,
    (SELECT group_concat(ta."slug") FROM "product_audiences" pa JOIN "taxonomy_audiences" ta ON ta."id" = pa."audience_id" WHERE pa."product_id" = ${p}) AS audience_slugs,
    (SELECT group_concat(tp."slug") FROM "product_phases" pp JOIN "taxonomy_phases" tp ON tp."id" = pp."phase_id" WHERE pp."product_id" = ${p}) AS phase_slugs,
    (SELECT group_concat(tt."slug") FROM "product_trades" pt JOIN "taxonomy_trades" tt ON tt."id" = pt."trade_id" WHERE pt."product_id" = ${p}) AS trade_slugs,
    (SELECT group_concat(pa."slug" || ' ' || pb."slug" || ' ' || pc."slug") FROM "connector_evidenced_pairs" e JOIN "products" pa ON pa."id" = e."product_a_id" JOIN "products" pb ON pb."id" = e."product_b_id" JOIN "products" pc ON pc."id" = e."connector_product_id" WHERE e."id" IN (${s.pairs})) AS evidenced_pair_slugs;`;
}

/** Raw footprint row as D1 returns it (`group_concat` → comma string or null). */
export interface RawFootprintRow {
  /** AECI-1005. Optional so a row built before it still parses. */
  vendor_held_integrations?: number;
  /** AECI-1088. Optional so a row built before it still parses. */
  vendor_held_evidenced_pairs?: number;
  connector_catalogs: number;
  stub_mappings: number;
  integrations: number;
  powered_by: number;
  evidenced_pairs: number;
  evidenced_pairs_as_connector: number;
  evidenced_pairs_as_a: number;
  evidenced_pairs_as_b: number;
  claims: number;
  attestations: number;
  field_challenges: number;
  /** AECI-1007. Optional so a row built before it still parses. */
  vendor_links?: number;
  reviews: number;
  product_versions: number;
  page_views: number;
  product_vendors: number;
  product_categories: number;
  product_audiences: number;
  product_phases: number;
  product_trades: number;
  product_extensions: number;
  category_slugs: string | null;
  audience_slugs: string | null;
  phase_slugs: string | null;
  trade_slugs: string | null;
  /** One `"<a-slug> <b-slug> <connector-slug>"` triple per pair, comma-joined. */
  evidenced_pair_slugs: string | null;
}

export interface RetractFootprint {
  /** Claimed or vendor-created integrations the retraction would delete or detach. */
  vendorHeldIntegrations: number;
  /** Claimed or vendor-created connector-evidenced pairs the product is part of
   *  (AECI-1088). A refusal whatever the flags say. */
  vendorHeldEvidencedPairs: number;
  connectorCatalogs: number;
  stubMappings: number;
  integrations: number;
  poweredBy: number;
  evidencedPairs: number;
  /** The same pairs split by the role the product plays in each. A pair's connector
   *  must differ from both endpoints (CHECK), so the three sum to `evidencedPairs`. */
  evidencedPairsAsConnector: number;
  evidencedPairsAsA: number;
  evidencedPairsAsB: number;
  claims: number;
  attestations: number;
  fieldChallenges: number;
  vendorLinks: number;
  reviews: number;
  productVersions: number;
  pageViews: number;
  productVendors: number;
  productCategories: number;
  productAudiences: number;
  productPhases: number;
  productTrades: number;
  productExtensions: number;
  categorySlugs: string[];
  audienceSlugs: string[];
  phaseSlugs: string[];
  tradeSlugs: string[];
  /** Endpoint + connector slugs of every pair, for the `pair:` / `product:` purge. */
  evidencedPairSlugs: Array<{ a: string; b: string; connector: string }>;
}

function splitConcat(value: string | null): string[] {
  return value ? value.split(',').filter((s) => s.length > 0) : [];
}

export function parseFootprint(row: RawFootprintRow): RetractFootprint {
  return {
    vendorHeldIntegrations: row.vendor_held_integrations ?? 0,
    vendorHeldEvidencedPairs: row.vendor_held_evidenced_pairs ?? 0,
    connectorCatalogs: row.connector_catalogs,
    stubMappings: row.stub_mappings,
    integrations: row.integrations,
    poweredBy: row.powered_by,
    evidencedPairs: row.evidenced_pairs,
    evidencedPairsAsConnector: row.evidenced_pairs_as_connector,
    evidencedPairsAsA: row.evidenced_pairs_as_a,
    evidencedPairsAsB: row.evidenced_pairs_as_b,
    claims: row.claims,
    attestations: row.attestations,
    fieldChallenges: row.field_challenges,
    vendorLinks: row.vendor_links ?? 0,
    reviews: row.reviews,
    productVersions: row.product_versions,
    pageViews: row.page_views,
    productVendors: row.product_vendors,
    productCategories: row.product_categories,
    productAudiences: row.product_audiences,
    productPhases: row.product_phases,
    productTrades: row.product_trades,
    productExtensions: row.product_extensions,
    categorySlugs: splitConcat(row.category_slugs),
    audienceSlugs: splitConcat(row.audience_slugs),
    phaseSlugs: splitConcat(row.phase_slugs),
    tradeSlugs: splitConcat(row.trade_slugs),
    evidencedPairSlugs: splitConcat(row.evidenced_pair_slugs).map((triple) => {
      const [a = '', b = '', connector = ''] = triple.split(' ');
      return { a, b, connector };
    }),
  };
}

/**
 * Is this a clean "empty stub" (safe to hard-delete), does it carry content a
 * delete would destroy (`blockers` — overridable with `--force`), or is it
 * something this lane must never delete (`refusals` — not overridable)?
 *
 * Blockers are editorial or user content that should normally be re-pointed to the
 * canonical product (the future merge-then-retract tool), not destroyed. Refusals
 * are the connector-catalogue mirror, which the sync owns (see the header).
 * Facet links and page_views are cosmetic and always cleaned up.
 */
export interface RetractionClassification {
  safe: boolean;
  blockers: string[];
  refusals: string[];
  /** Evidenced pairs the product carries. A refusal unless the operator passed
   *  `--delete-evidenced-pairs`; `--force` does not clear it (AECI-904). */
  evidencedPairRefusal: string | null;
}

export interface ClassifyOptions {
  /** `--delete-evidenced-pairs` was passed. */
  deleteEvidencedPairs?: boolean;
}

/** The flag that authorises deleting connector-evidenced pairs. */
export const DELETE_EVIDENCED_PAIRS_FLAG = '--delete-evidenced-pairs';

export function describeEvidencedPairs(footprint: RetractFootprint): string {
  return (
    `${footprint.evidencedPairs} connector-evidenced pair(s): ` +
    `${footprint.evidencedPairsAsConnector} as connector, ` +
    `${footprint.evidencedPairsAsA} as endpoint A, ${footprint.evidencedPairsAsB} as endpoint B`
  );
}

export function classifyRetraction(
  footprint: RetractFootprint,
  opts: ClassifyOptions = {},
): RetractionClassification {
  const refusals: string[] = [];
  if (footprint.vendorHeldIntegrations > 0)
    refusals.push(
      `${footprint.vendorHeldIntegrations} vendor-held integration(s) — claimed by the owner or created by a vendor (ADR 0035); the vendor retires them, this tool does not delete them`,
    );
  if (footprint.vendorHeldEvidencedPairs > 0)
    refusals.push(
      `${footprint.vendorHeldEvidencedPairs} vendor-held connector-evidenced pair(s) — claimed by the owner or created by a vendor (ADR 0035); ${DELETE_EVIDENCED_PAIRS_FLAG} does not cover them, and neither does --force`,
    );
  if (footprint.connectorCatalogs > 0)
    refusals.push(
      `${footprint.connectorCatalogs} connector catalogue(s) — deleting the product would cascade the whole catalogue`,
    );
  if (footprint.stubMappings > 0)
    refusals.push(
      `${footprint.stubMappings} connector stub mapping(s) — unmap upstream and let the connector sync carry it`,
    );
  const blockers: string[] = [];
  if (footprint.integrations > 0)
    blockers.push(`${footprint.integrations} integration(s) (as source/target)`);
  if (footprint.poweredBy > 0)
    blockers.push(`${footprint.poweredBy} integration(s) list it as \`powered_by\``);
  if (footprint.reviews > 0) blockers.push(`${footprint.reviews} review(s)`);
  if (footprint.productVersions > 0)
    blockers.push(`${footprint.productVersions} product version(s)`);
  const evidencedPairRefusal =
    footprint.evidencedPairs > 0 && !opts.deleteEvidencedPairs
      ? describeEvidencedPairs(footprint)
      : null;
  return {
    safe: refusals.length === 0 && blockers.length === 0 && evidencedPairRefusal === null,
    blockers,
    refusals,
    evidencedPairRefusal,
  };
}

// ─── Tombstones ──────────────────────────────────────────────────────────────

/** The fixed provenance every tombstone this lane writes carries. */
export const RETRACT_PRODUCT_TOOL_PATH = 'apps/api/scripts/retract-product.ts';
export const RETRACT_PRODUCT_ISSUE = 'AECI-687';

export interface ProductDeleteArgs {
  product: ProductRow;
  footprint: RetractFootprint;
  /** Id of the `product.deleted` row. The per-row tombstones mint their own in SQL. */
  auditId: string;
  /** ISO-8601 UTC, stamped on every tombstone. `audit_log.created_at` is NOT NULL and
   *  its default only runs in application code, so raw SQL must supply it. */
  now: string;
  operator?: string;
  force?: boolean;
  /** `--delete-evidenced-pairs`. Without it the plan carries no pair delete, and the
   *  product DELETE is guarded on no pair existing (AECI-904). */
  deleteEvidencedPairs?: boolean;
  /** AECI-1007: whether `integration_vendor_links` exists on the target tier. Defaults
   *  to true, the schema at HEAD; the CLI passes its {@link VENDOR_LINKS_TABLE_SQL}
   *  probe so a tier without migration 0045 gets a plan that never names the table. */
  vendorLinksTable?: boolean;
}

function sqlLiteral(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${escapeSqlLiteral(v)}'`;
}

/** A v4-shaped UUID minted in SQLite, one per selected row. */
const SQL_UUID =
  `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || ` +
  `substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || ` +
  `substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;

const AUDIT_COLS = `"id","actor_id","actor_type","action","entity_type","entity_id","before_state","metadata","created_at"`;

function metadataJson(args: ProductDeleteArgs, table: string, reason: string): string {
  return JSON.stringify({
    source: 'ops-cli',
    issue: RETRACT_PRODUCT_ISSUE,
    tool: RETRACT_PRODUCT_TOOL_PATH,
    operator: args.operator ?? 'chrisw@thewbsproject.com',
    table,
    reason,
    retracted_product_id: args.product.id,
    retracted_product_slug: args.product.slug,
    force: args.force ?? false,
    delete_evidenced_pairs: args.deleteEvidencedPairs ?? false,
  });
}

/** One `INSERT … SELECT` that writes a tombstone per row the `FROM`/`WHERE` selects. */
function tombstoneSelect(o: {
  args: ProductDeleteArgs;
  action: string;
  entityType: string;
  table: string;
  reason: string;
  beforeState: string;
  from: string;
}): string {
  return (
    `INSERT INTO "audit_log" (${AUDIT_COLS}) SELECT ${SQL_UUID}, NULL, 'system', ` +
    `${sqlLiteral(o.action)}, ${sqlLiteral(o.entityType)}, "id", ${o.beforeState}, ` +
    `${sqlLiteral(metadataJson(o.args, o.table, o.reason))}, ${sqlLiteral(o.args.now)} ${o.from};`
  );
}

/** `json_object('col', "col", …)` over the named columns of the selected row. */
function rowJson(cols: string[]): string {
  return `json_object(${cols.map((c) => `'${c}', "${c}"`).join(', ')})`;
}

function productTombstone(args: ProductDeleteArgs, guard: string): string {
  const f = args.footprint;
  const beforeState = {
    table: 'products',
    row: args.product,
    removed: {
      product_vendors: f.productVendors,
      product_categories: f.productCategories,
      product_audiences: f.productAudiences,
      product_phases: f.productPhases,
      product_trades: f.productTrades,
      product_extensions: f.productExtensions,
      integrations: f.integrations,
      evidenced_pairs: f.evidencedPairs,
      evidenced_pairs_by_role: {
        connector: f.evidencedPairsAsConnector,
        product_a: f.evidencedPairsAsA,
        product_b: f.evidencedPairsAsB,
      },
      reviews: f.reviews,
      product_versions: f.productVersions,
      // AECI-1007: every per-side link the plan deletes, on endpoint rows and on
      // rows the product no longer sits on.
      vendor_links: f.vendorLinks,
    },
    detached: { page_views: f.pageViews, powered_by: f.poweredBy },
  };
  const vals = [
    sqlLiteral(args.auditId),
    'NULL',
    sqlLiteral('system'),
    sqlLiteral('product.deleted'),
    sqlLiteral('product'),
    sqlLiteral(args.product.id),
    sqlLiteral(JSON.stringify(beforeState)),
    sqlLiteral(metadataJson(args, 'products', 'retracted')),
    sqlLiteral(args.now),
  ];
  // Gated on the same predicate as the product DELETE, so a row that was not deleted
  // is never tombstoned.
  return `INSERT INTO "audit_log" (${AUDIT_COLS}) SELECT ${vals.join(', ')} WHERE ${guard};`;
}

// ─── The delete plan ─────────────────────────────────────────────────────────

/**
 * Ordered statements to remove the product and everything that hangs off it, with
 * every tombstone in the same batch. Order is:
 *   1. per-row tombstones (INSERT … SELECT — the rows must still exist);
 *   2. deletes and SET NULLs, children before parents;
 *   3. the product's own tombstone, then the product row.
 * Statements against empty tables are harmless no-ops, so the clean-stub case runs
 * the same list. The product DELETE and its tombstone both carry a guard that is
 * false while a connector catalogue or stub mapping still points at the product, so a
 * refusal the CLI already checked cannot be undone by a row that appeared since.
 */
export function buildDeleteStatements(args: ProductDeleteArgs): string[] {
  const p = sqlLiteral(args.product.id);
  const withPairs = args.deleteEvidencedPairs ?? false;
  const s = scopes(p, { includePairs: withPairs });
  const claimCount = (col: string) => `(SELECT count(*) FROM "claims" c WHERE c."${col}" = t."id")`;
  const attestationCount = (col: string) =>
    `(SELECT count(*) FROM "attestations" a JOIN "claims" c ON c."id" = a."claim_id" WHERE c."${col}" = t."id")`;
  const vendorLinksTable = args.vendorLinksTable ?? true;
  const refusalGuard =
    `NOT EXISTS (SELECT 1 FROM "connector_catalogs" WHERE "connector_product_id" = ${p})` +
    ` AND NOT EXISTS (SELECT 1 FROM "connector_stub_mappings" WHERE "product_id" = ${p})` +
    // Without the flag a pair must block the product DELETE, never cascade off it.
    (withPairs ? '' : ` AND NOT EXISTS (${s.pairs})`);

  const pairTombstone = tombstoneSelect({
    args,
    action: 'integration.deleted',
    entityType: 'integration',
    table: 'connector_evidenced_pairs',
    reason: 'connector or endpoint product retracted',
    beforeState:
      `json_object('table', 'connector_evidenced_pairs', 'row', ${rowJson(['id', 'name', 'connector_product_id', 'product_a_id', 'product_b_id', 'mechanism_name', 'direction', 'created_at'])}, ` +
      `'cascade', json_object('claims', ${claimCount('connector_evidenced_pair_id')}, 'attestations', ${attestationCount('connector_evidenced_pair_id')}))`,
    from: `FROM "connector_evidenced_pairs" t WHERE t."id" IN (${s.pairs})`,
  });

  return [
    // 1. Per-row tombstones, before anything they describe is gone.
    tombstoneSelect({
      args,
      action: 'integration.deleted',
      entityType: 'integration',
      table: 'integrations',
      reason: 'endpoint product retracted',
      beforeState:
        `json_object('table', 'integrations', 'row', ${rowJson(['id', 'name', 'source_product_id', 'target_product_id', 'mechanism_kind', 'mechanism_name', 'direction', 'powered_by_product_id', 'created_at'])}, ` +
        `'cascade', json_object('claims', ${claimCount('integration_id')}, 'attestations', ${attestationCount('integration_id')}, ` +
        `'field_challenges', (SELECT count(*) FROM "integration_field_challenges" f WHERE f."integration_id" = t."id")` +
        (vendorLinksTable
          ? `, 'vendor_links', (SELECT count(*) FROM "integration_vendor_links" l WHERE l."integration_id" = t."id")`
          : '') +
        `))`,
      from: `FROM "integrations" t WHERE t."id" IN (${s.integrations})`,
    }),
    ...(withPairs ? [pairTombstone] : []),
    tombstoneSelect({
      args,
      action: 'integration.updated',
      entityType: 'integration',
      table: 'integrations',
      reason: 'powered_by product retracted; powered_by_product_id set to NULL',
      beforeState: `json_object('powered_by_product_id', "powered_by_product_id")`,
      from: `FROM "integrations" WHERE ${s.poweredOnly}`,
    }),
    tombstoneSelect({
      args,
      action: 'review.deleted',
      entityType: 'review',
      table: 'reviews',
      reason: 'product retracted',
      // Deliberately not the body or the reviewer's firm: `audit_log` is kept
      // indefinitely (§26.6) and survives erasure (§26.7).
      beforeState: `json_object('table', 'reviews', 'row', ${rowJson(['id', 'product_id', 'reviewer_id', 'status', 'rating_overall', 'rating_onboarding', 'created_at'])})`,
      from: `FROM "reviews" WHERE "product_id" = ${p}`,
    }),
    tombstoneSelect({
      args,
      action: 'product_version.deleted',
      entityType: 'product_version',
      table: 'product_versions',
      reason: 'product retracted',
      beforeState: `json_object('table', 'product_versions', 'row', ${rowJson(['id', 'product_id', 'label', 'released_at', 'sunset_at', 'sort_key', 'created_at'])})`,
      from: `FROM "product_versions" WHERE "product_id" = ${p}`,
    }),

    // 2. Children before parents, explicitly: attestations → claims → edges. Never
    //    left to the FK cascade, which is two levels deep here (ADR 0018).
    `DELETE FROM "attestations" WHERE "claim_id" IN (${s.claims});`,
    `DELETE FROM "claims" WHERE "id" IN (${s.claims});`,
    `DELETE FROM "integration_field_challenges" WHERE "integration_id" IN (${s.integrations});`,
    ...(vendorLinksTable
      ? [
          `DELETE FROM "integration_vendor_links" WHERE "integration_id" IN (${s.integrations});`,
          // `product_id` has no FK, so a link naming this product on a row it no
          // longer sits on (left by an endpoint re-point) would otherwise outlive
          // the product it speaks for.
          `DELETE FROM "integration_vendor_links" WHERE "product_id" = ${p};`,
        ]
      : []),
    // NULL the no-action `powered_by` ref before deleting the product it points at.
    `UPDATE "integrations" SET "powered_by_product_id" = NULL WHERE "powered_by_product_id" = ${p};`,
    `DELETE FROM "integrations" WHERE "id" IN (${s.integrations});`,
    ...(withPairs ? [`DELETE FROM "connector_evidenced_pairs" WHERE "id" IN (${s.pairs});`] : []),
    // Version refs on surviving attestations are detached, never deleted with them.
    `UPDATE "attestations" SET "introduced_version_id" = NULL WHERE "introduced_version_id" IN (${s.versions});`,
    `UPDATE "attestations" SET "deprecated_version_id" = NULL WHERE "deprecated_version_id" IN (${s.versions});`,
    `DELETE FROM "product_versions" WHERE "product_id" = ${p};`,
    `DELETE FROM "reviews" WHERE "product_id" = ${p};`,
    // page_views is log-class traffic history: detach, never delete (the no-action FK
    // would otherwise block the product DELETE).
    `UPDATE "page_views" SET "product_id" = NULL WHERE "product_id" = ${p};`,
    // Facets.
    `DELETE FROM "product_categories" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_audiences" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_phases" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_trades" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_vendors" WHERE "product_id" = ${p};`,
    `DELETE FROM "product_extensions" WHERE "product_id" = ${p} OR "host_product_id" = ${p};`,

    // 3. The product's tombstone, then the product itself.
    productTombstone(
      args,
      `EXISTS (SELECT 1 FROM "products" WHERE "id" = ${p}) AND ${refusalGuard}`,
    ),
    `DELETE FROM "products" WHERE "id" = ${p} AND ${refusalGuard};`,
  ];
}

/**
 * Cache-Tags to purge so no edge-cached page keeps rendering the deleted product.
 * Each deleted connector-evidenced pair also purges its pair page
 * (`pair:{min}__{max}`, via `pairCacheTag` so the order matches the SSR tag) and
 * `product:` for its two endpoints and its connector, whose pages list the pair
 * (AECI-904). Those are pages of OTHER products when the retracted one is the
 * connector, which is why the footprint carries their slugs.
 * Matches the tags the SSR responses actually set (`apps/web/src/server/cache-tags.ts`):
 * the product detail page (`product:<slug>`), the products index (`index:products`),
 * and each browse page the product appeared on (`category|audience|phase|trade:<slug>`,
 * plus `index:trades` when it carried any trade — `CACHE_STRATEGY.md`).
 */
export function buildCacheTagsForProduct(slug: string, footprint: RetractFootprint): string[] {
  const tags = [`product:${slug}`, 'index:products'];
  for (const s of footprint.categorySlugs) tags.push(`category:${s}`);
  for (const s of footprint.audienceSlugs) tags.push(`audience:${s}`);
  for (const s of footprint.phaseSlugs) tags.push(`phase:${s}`);
  for (const s of footprint.tradeSlugs) tags.push(`trade:${s}`);
  if (footprint.tradeSlugs.length > 0) tags.push('index:trades');
  for (const pair of footprint.evidencedPairSlugs) {
    tags.push(pairCacheTag(pair.a, pair.b));
    tags.push(`product:${pair.a}`, `product:${pair.b}`, `product:${pair.connector}`);
  }
  return [...new Set(tags)];
}

/** Human-readable footprint block for the dry-run / pre-apply report. */
export function formatFootprintReport(product: ProductRow, footprint: RetractFootprint): string {
  const rows: Array<[string, number]> = [
    ['connector catalogues (REFUSE)', footprint.connectorCatalogs],
    ['connector stub mappings (REFUSE)', footprint.stubMappings],
    ['integrations (source/target)', footprint.integrations],
    ['integrations powered_by (NULLed)', footprint.poweredBy],
    ['connector-evidenced pairs (FLAG)', footprint.evidencedPairs],
    ['  as connector', footprint.evidencedPairsAsConnector],
    ['  as endpoint A', footprint.evidencedPairsAsA],
    ['  as endpoint B', footprint.evidencedPairsAsB],
    ['  vendor-held (REFUSE)', footprint.vendorHeldEvidencedPairs],
    ['claims', footprint.claims],
    ['attestations', footprint.attestations],
    ['field contests', footprint.fieldChallenges],
    ['per-side vendor links', footprint.vendorLinks],
    ['reviews', footprint.reviews],
    ['product_versions', footprint.productVersions],
    ['page_views (NULLed, kept)', footprint.pageViews],
    ['product_vendors', footprint.productVendors],
    ['product_categories', footprint.productCategories],
    ['product_audiences', footprint.productAudiences],
    ['product_phases', footprint.productPhases],
    ['product_trades', footprint.productTrades],
    ['product_extensions', footprint.productExtensions],
  ];
  const lines = [
    `Product:  ${product.name}  (slug: ${product.slug})`,
    `Id:       ${product.id}`,
    `Status:   ${product.promotion_status}`,
    '',
    'Footprint (rows that will be removed / detached):',
    ...rows.map(([label, n]) => `  ${n === 0 ? ' ' : '•'} ${label.padEnd(34)} ${n}`),
  ];
  return lines.join('\n');
}
