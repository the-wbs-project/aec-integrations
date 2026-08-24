/**
 * The admin panel's catalog read layer (AECI-579 / `ADMIN_PANEL_SPEC.md` §5.5).
 *
 * Everything `GET /api/admin/catalog/coverage` needs: the coverage-gap counts and
 * samples, the promotion funnel, the `research_status` distribution, taxonomy
 * usage per facet, and the Stage 1.5 claim/attestation spine. The route handler
 * stays thin — parse the query, call in here, wrap the envelope — matching
 * `lib/admin-analytics.ts`.
 *
 * Four things are load-bearing and easy to get wrong:
 *
 * **1. The count is exact; the sample is a starting point.** §5.5 produces a
 * to-do list, so every gap reports an exact `total` next to a capped `sample`.
 * `universe` travels with it because the interesting reading is the ratio: 171 of
 * 171 products have no logo, and that is a worklist, not an error.
 *
 * **2. One query for eight gaps.** All the gap counts (plus the api-docs
 * consistency probe) come from a single conditional-aggregation `SELECT` over
 * `products`, not eight round trips. D1 charges per statement and this endpoint
 * already fires ~15; the samples then run only for the gaps that found something.
 *
 * **3. Degeneracy is derived, never assumed.** `promoted_cohort_only` is computed
 * from the rows. §13 D6 explains why it is true today — promote is D1's only
 * INSERT path into `products` and sets `'promoted'` on both branches, nothing
 * writes `'ready'`, and retraction hard-deletes — but the flag is data, so it
 * flips itself the day that stops being true rather than lying.
 *
 * **4. The trade facet is sparse BY DESIGN.** `TRADES_VOCABULARY.md` §1.1 tags a
 * product only when it has trade-*specific* value, so horizontal platforms
 * (Procore, Autodesk Build, Bluebeam) correctly carry zero `product_trades` rows.
 * The untagged count is still worth showing — `product_trades` is 0 overall today
 * — but it ships with `trade_facet_sparse_by_design` so it is not read as a
 * backlog the way "no logo" is.
 */

import {
  TRADE_PUBLISH_MIN_PRODUCTS,
  isPublishedTrade,
  type AdminClaimCoverage,
  type AdminCoverageGap,
  type AdminCoverageGapKey,
  type AdminIntegrationRef,
  type AdminPromotionFunnel,
  type AdminPromotionStatus,
  type AdminResearchStatus,
  type AdminResearchStatusCount,
  type AdminTaxonomyFacetUsage,
  type AdminTaxonomyTermUsage,
  type LinkRef,
} from '@aeci/shared';
import { asc, count, countDistinct, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import { alias, type AnySQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import {
  attestations,
  claims,
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { liveAttestationsWhere } from './drizzle-helpers';

// ─── Correlated-subquery identifiers ─────────────────────────────────────────

/**
 * `"table"."column"` — an EXPLICITLY qualified identifier.
 *
 * This is not decoration. Interpolating a Drizzle column into a `sql` template
 * emits a **bare** name (`"id"`) whenever the surrounding statement has no join,
 * and inside a correlated subquery a bare name binds to the INNER table if that
 * table happens to have a column of the same name. `claims` has an `id`, so
 * `… from claims where "data_object_id" = "id"` silently compares
 * `claims.data_object_id` against `claims.id` and every count comes back 0. The
 * facet joins (`product_categories` and friends) have no `id` column, so the same
 * construction happens to work there — which is exactly the kind of accident that
 * rots the day someone adds a surrogate key.
 *
 * `lib/drizzle-helpers.ts` avoids this by hand-writing the qualified name into
 * the template string; this derives it from the schema instead, so a renamed
 * column moves with it.
 */
function col(c: AnySQLiteColumn): SQL {
  return sql.raw(`"${getTableName(c.table)}"."${c.name}"`);
}

/** `"table"` — the quoted table name, for a subquery's `FROM`. */
function tbl(t: SQLiteTable): SQL {
  return sql.raw(`"${getTableName(t)}"`);
}

/** `(SELECT count(*) FROM <fk table> WHERE <fk> = <outer>)`, fully qualified. */
function correlatedCount(fk: AnySQLiteColumn, outer: AnySQLiteColumn): SQL<number> {
  return sql<number>`(select count(*) from ${tbl(fk.table as SQLiteTable)} where ${col(fk)} = ${col(outer)})`;
}

// ─── Gap predicates ──────────────────────────────────────────────────────────

/**
 * The eight §5.5 gaps as `products` predicates.
 *
 * The facet gaps use the **correlated** `NOT EXISTS` form rather than
 * `NOT IN (SELECT …)`, so each reads its join table's `product_id` index instead
 * of materialising every tagged product id — and, unlike `NOT IN`, it cannot be
 * derailed by a NULL in the subquery.
 *
 * `without_api_docs` keys off `api_docs_url IS NULL` rather than the
 * `has_api_docs` boolean: the URL is the artifact an operator goes and finds, and
 * the flag can disagree with it (which {@link productGapCounts} reports
 * separately rather than papering over).
 *
 * `without_description` treats whitespace as absent — a description of `'  '`
 * satisfies `IS NOT NULL` and helps nobody.
 */
/** `NOT EXISTS (SELECT 1 FROM <join> WHERE <join>.product_id = products.id)`.
 *
 *  Hand-rolled rather than Drizzle's `notExists()` because that helper emits
 *  `not exists ${arg}` with no parentheses of its own — correct for a `Subquery`
 *  object (which brings its own) and a syntax error for a raw `sql` fragment. */
function noJoinRow(fk: AnySQLiteColumn): SQL {
  return sql`not exists (select 1 from ${tbl(fk.table as SQLiteTable)} where ${col(fk)} = ${col(products.id)})`;
}

export const GAP_PREDICATE: Record<AdminCoverageGapKey, SQL> = {
  products_without_vendor: noJoinRow(productVendors.productId),
  products_without_logo: sql`${col(products.logoUrl)} is null`,
  products_without_description: sql`${col(products.description)} is null or trim(${col(products.description)}) = ''`,
  products_without_api_docs: sql`${col(products.apiDocsUrl)} is null`,
  products_without_category: noJoinRow(productCategories.productId),
  products_without_audience: noJoinRow(productAudiences.productId),
  products_without_phase: noJoinRow(productPhases.productId),
  products_without_trade: noJoinRow(productTrades.productId),
};

/** Declaration order is render order — vendor/logo/description first because they
 *  are unambiguous defects, facet tagging after, trade last (see the module
 *  header on why it is a different kind of number). */
export const GAP_KEYS: readonly AdminCoverageGapKey[] = [
  'products_without_vendor',
  'products_without_logo',
  'products_without_description',
  'products_without_api_docs',
  'products_without_category',
  'products_without_audience',
  'products_without_phase',
  'products_without_trade',
];

export interface GapCounts {
  /** Total products — the denominator every gap is read against. */
  universe: number;
  counts: Record<AdminCoverageGapKey, number>;
  /** Products claiming `has_api_docs` with no `api_docs_url`. A flag that
   *  disagrees with its artifact; surfaced as a note, not hidden. */
  apiDocsFlagInconsistent: number;
}

/** `sum(case when <predicate> then 1 else 0 end)` — SQLite returns NULL for an
 *  empty table, hence the coalesce. */
function tally(predicate: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${predicate} then 1 else 0 end), 0)`;
}

/**
 * Every gap count in ONE statement. Eight `sum(case …)` columns over a single
 * `products` scan beats eight `count(*)` round trips against D1, and it
 * guarantees all eight see the same snapshot — a promote landing mid-request
 * cannot make the numbers disagree with each other.
 */
export async function productGapCounts(db: Db): Promise<GapCounts> {
  const [row] = await db
    .select({
      universe: count(),
      products_without_vendor: tally(GAP_PREDICATE.products_without_vendor),
      products_without_logo: tally(GAP_PREDICATE.products_without_logo),
      products_without_description: tally(GAP_PREDICATE.products_without_description),
      products_without_api_docs: tally(GAP_PREDICATE.products_without_api_docs),
      products_without_category: tally(GAP_PREDICATE.products_without_category),
      products_without_audience: tally(GAP_PREDICATE.products_without_audience),
      products_without_phase: tally(GAP_PREDICATE.products_without_phase),
      products_without_trade: tally(GAP_PREDICATE.products_without_trade),
      apiDocsFlagInconsistent: tally(
        sql`${col(products.hasApiDocs)} = 1 and ${col(products.apiDocsUrl)} is null`,
      ),
    })
    .from(products);

  const num = (v: number | string | null | undefined): number => Number(v ?? 0);
  return {
    universe: num(row?.universe),
    apiDocsFlagInconsistent: num(row?.apiDocsFlagInconsistent),
    counts: {
      products_without_vendor: num(row?.products_without_vendor),
      products_without_logo: num(row?.products_without_logo),
      products_without_description: num(row?.products_without_description),
      products_without_api_docs: num(row?.products_without_api_docs),
      products_without_category: num(row?.products_without_category),
      products_without_audience: num(row?.products_without_audience),
      products_without_phase: num(row?.products_without_phase),
      products_without_trade: num(row?.products_without_trade),
    },
  };
}

/** One gap's sample rows, name-ordered so the list is stable between requests
 *  (an operator working down it should not see it reshuffle). */
export async function gapSample(
  db: Db,
  key: AdminCoverageGapKey,
  limit: number,
): Promise<LinkRef[]> {
  if (limit <= 0) return [];
  return db
    .select({ id: products.id, name: products.name, slug: products.slug })
    .from(products)
    .where(GAP_PREDICATE[key])
    .orderBy(asc(products.name), asc(products.id))
    .limit(limit);
}

export interface CoverageGapsResult {
  gaps: AdminCoverageGap[];
  /** Not part of the wire shape — the handler turns a non-zero value into the
   *  `api_docs_flag_inconsistent` note. Returned here so it costs no extra query. */
  apiDocsFlagInconsistent: number;
}

/**
 * All eight gaps, counted once and sampled only where there is something to
 * sample. A gap with a zero count costs no extra statement, which is the common
 * case for most of this list — and with `?sample=0` none of them do.
 */
export async function coverageGaps(db: Db, sampleLimit: number): Promise<CoverageGapsResult> {
  const { universe, counts, apiDocsFlagInconsistent } = await productGapCounts(db);

  const samples = await Promise.all(
    GAP_KEYS.map((key) =>
      counts[key] > 0 ? gapSample(db, key, sampleLimit) : Promise.resolve<LinkRef[]>([]),
    ),
  );

  return {
    apiDocsFlagInconsistent,
    gaps: GAP_KEYS.map((key, i) => {
      const sample = samples[i] ?? [];
      return {
        key,
        total: counts[key],
        universe,
        sample,
        sample_truncated: counts[key] > sample.length,
      };
    }),
  };
}

// ─── Funnel + research status ────────────────────────────────────────────────

/** Pipeline order, matching the `products_promotion_status_check` CHECK values.
 *  Zero-filling across all five is what keeps an absent stage rendering as `0`
 *  instead of vanishing from the funnel. */
const PROMOTION_STATUSES: readonly AdminPromotionStatus[] = [
  'pending',
  'ready',
  'promoted',
  'retracted',
  'rejected',
];

/** Matching `products_research_status_check`. */
const RESEARCH_STATUSES: readonly AdminResearchStatus[] = [
  'pending',
  'in_progress',
  'done',
  'blocked',
];

/**
 * The §5.5 promotion funnel.
 *
 * `promoted_cohort_only` is DERIVED — there is at least one product and every one
 * reads `promoted`. §13 D6 says that is the state of D1 today, but reading it off
 * the data means the flag (and the note the handler hangs off it) retires itself
 * if a Tier-1 retract endpoint ever introduces a real un-promote cycle.
 *
 * A status outside the CHECK vocabulary cannot exist, but if one somehow did it
 * would still count toward `total` — which is deliberate: `total` is `count(*)`,
 * so the stages summing to less than it would be a visible signal rather than a
 * silently dropped row.
 */
export async function promotionFunnel(db: Db): Promise<AdminPromotionFunnel> {
  const rows = await db
    .select({ status: products.promotionStatus, value: count() })
    .from(products)
    .groupBy(products.promotionStatus);

  const byStatus = new Map(rows.map((r) => [r.status, r.value]));
  const total = rows.reduce((acc, r) => acc + r.value, 0);
  const promoted = byStatus.get('promoted') ?? 0;

  return {
    stages: PROMOTION_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 })),
    total,
    promoted_cohort_only: total > 0 && promoted === total,
  };
}

/** `research_status` distribution, zero-filled across the four CHECK values. */
export async function researchStatusDistribution(db: Db): Promise<AdminResearchStatusCount[]> {
  const rows = await db
    .select({ status: products.researchStatus, value: count() })
    .from(products)
    .groupBy(products.researchStatus);

  const byStatus = new Map(rows.map((r) => [r.status, r.value]));
  return RESEARCH_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 }));
}

// ─── Taxonomy usage ──────────────────────────────────────────────────────────

/**
 * One facet's terms with their usage count. Terms come back uncapped and
 * display-ordered: the five vocabularies total ~122 rows (33 categories · 30
 * audiences · 5 phases · 34 trades · 20 data objects), so paging would be
 * ceremony over a list that fits on one screen.
 *
 * The correlated-count shape mirrors `categoryTermConfig` and friends in
 * `lib/drizzle-helpers.ts` — same subquery, expressed against `db.select()`
 * because this reads the raw table rather than the public term payload.
 */
async function facetUsage(
  db: Db,
  facet: 'category' | 'audience' | 'phase' | 'trade',
): Promise<AdminTaxonomyTermUsage[]> {
  const table = {
    category: taxonomyCategories,
    audience: taxonomyAudiences,
    phase: taxonomyPhases,
    trade: taxonomyTrades,
  }[facet];
  const join = {
    category: { t: productCategories, fk: productCategories.categoryId },
    audience: { t: productAudiences, fk: productAudiences.audienceId },
    phase: { t: productPhases, fk: productPhases.phaseId },
    trade: { t: productTrades, fk: productTrades.tradeId },
  }[facet];

  const rows = await db
    .select({
      id: table.id,
      slug: table.slug,
      name: table.name,
      value: correlatedCount(join.fk, table.id),
    })
    .from(table)
    .orderBy(asc(table.displayOrder), asc(table.name));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    count: Number(r.value ?? 0),
    // Only the trade facet has a publication gate; the others render `null` so a
    // consumer cannot mistake "no gate" for "fails the gate".
    published: facet === 'trade' ? isPublishedTrade({ product_count: Number(r.value ?? 0) }) : null,
  }));
}

/**
 * Data objects are the odd facet out: nothing joins them to products. They are
 * referenced by **claims** (`claims.data_object_id`, the Stage 1.5 spine), so
 * their usage count is a claim count — which the response labels via
 * `counts_what` rather than leaving a reader to assume it matches its siblings.
 */
async function dataObjectUsage(db: Db): Promise<AdminTaxonomyTermUsage[]> {
  const rows = await db
    .select({
      id: taxonomyDataObjects.id,
      slug: taxonomyDataObjects.slug,
      name: taxonomyDataObjects.name,
      // `claims` HAS an `id` column, so this is the correlation that breaks
      // without explicit qualification — see the note on `col()`.
      value: correlatedCount(claims.dataObjectId, taxonomyDataObjects.id),
    })
    .from(taxonomyDataObjects)
    .orderBy(asc(taxonomyDataObjects.displayOrder), asc(taxonomyDataObjects.name));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    count: Number(r.value ?? 0),
    published: null,
  }));
}

/** All five facets. Trades additionally carry the publication gate
 *  (`TRADE_PUBLISH_MIN_PRODUCTS` / `isPublishedTrade` from `@aeci/shared` — one
 *  copy of the floor, per `TRADES_VOCABULARY.md` §6). */
export async function taxonomyUsage(db: Db): Promise<AdminTaxonomyFacetUsage[]> {
  const [category, audience, phase, trade, dataObject] = await Promise.all([
    facetUsage(db, 'category'),
    facetUsage(db, 'audience'),
    facetUsage(db, 'phase'),
    facetUsage(db, 'trade'),
    dataObjectUsage(db),
  ]);

  const pack = (
    facet: AdminTaxonomyFacetUsage['facet'],
    terms: AdminTaxonomyTermUsage[],
    countsWhat: AdminTaxonomyFacetUsage['counts_what'],
  ): AdminTaxonomyFacetUsage => ({
    facet,
    counts_what: countsWhat,
    terms_total: terms.length,
    terms_used: terms.filter((t) => t.count > 0).length,
    publish_floor: facet === 'trade' ? TRADE_PUBLISH_MIN_PRODUCTS : null,
    terms_published: facet === 'trade' ? terms.filter((t) => t.published === true).length : null,
    terms,
  });

  return [
    pack('category', category, 'products'),
    pack('audience', audience, 'products'),
    pack('phase', phase, 'products'),
    pack('trade', trade, 'products'),
    pack('data_object', dataObject, 'claims'),
  ];
}

// ─── Claims / attestations (the Stage 1.5 spine) ─────────────────────────────

/**
 * Claim + attestation coverage. The census reads 915 / 915, so the numbers worth
 * looking at are the zeros: integrations carrying no claim, and claims carrying
 * no **active** attestation.
 *
 * "Active" is `retracted_at IS NULL` — the shared {@link liveAttestationsWhere},
 * which is also what the partial `attestations_active_idx` is predicated on since
 * AECI-603. It is deliberately NOT `deprecated_at`: that column is a **version
 * stamp** ("this flow existed until v6", `STAGE_1_5_SPEC.md` §3.3), not retirement,
 * and gating coverage on it would drop a vendor's live assertion from the count the
 * moment they recorded which release deprecated the flow. Retraction is the only
 * thing that ends an attestation. Until AECI-608 this read used `deprecated_at` —
 * inert while every attestation was `source='aeci'`, wrong the day one wasn't.
 *
 * `integrations_without_claims` is derived by subtraction rather than a second
 * `NOT EXISTS` count: `claims.integration_id` is a cascading FK, so every claim
 * has a live integration and the two agree by construction.
 */
export async function claimCoverage(db: Db, sampleLimit: number): Promise<AdminClaimCoverage> {
  const sourceProduct = alias(products, 'source_product');
  const targetProduct = alias(products, 'target_product');

  // Explicitly qualified for the same reason as `col()`: `claims` has its own
  // `id`, so an unqualified `"id"` here would bind to the wrong table and report
  // EVERY integration as claimless.
  const noClaims = sql`not exists (select 1 from ${tbl(claims)} where ${col(claims.integrationId)} = ${col(integrations.id)})`;

  const [
    [integrationsRow],
    [withClaimsRow],
    [claimsRow],
    [attestedRow],
    [attestationsRow],
    sampleRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(integrations),
    db.select({ value: countDistinct(claims.integrationId) }).from(claims),
    db.select({ value: count() }).from(claims),
    db
      .select({ value: countDistinct(attestations.claimId) })
      .from(attestations)
      .where(liveAttestationsWhere),
    db.select({ value: count() }).from(attestations),
    sampleLimit > 0
      ? db
          .select({
            id: integrations.id,
            name: integrations.name,
            sourceId: sourceProduct.id,
            sourceName: sourceProduct.name,
            sourceSlug: sourceProduct.slug,
            targetId: targetProduct.id,
            targetName: targetProduct.name,
            targetSlug: targetProduct.slug,
          })
          .from(integrations)
          .innerJoin(sourceProduct, eq(integrations.sourceProductId, sourceProduct.id))
          .innerJoin(targetProduct, eq(integrations.targetProductId, targetProduct.id))
          .where(noClaims)
          .orderBy(asc(sourceProduct.name), asc(targetProduct.name), asc(integrations.id))
          .limit(sampleLimit)
      : Promise.resolve([]),
  ]);

  const integrationsTotal = integrationsRow?.value ?? 0;
  const integrationsWithClaims = withClaimsRow?.value ?? 0;
  const claimsTotal = claimsRow?.value ?? 0;
  const claimsAttested = attestedRow?.value ?? 0;
  const integrationsWithoutClaims = integrationsTotal - integrationsWithClaims;

  const sample: AdminIntegrationRef[] = sampleRows.map((r) => ({
    id: r.id,
    name: r.name,
    source_product: { id: r.sourceId, name: r.sourceName, slug: r.sourceSlug },
    target_product: { id: r.targetId, name: r.targetName, slug: r.targetSlug },
  }));

  return {
    integrations_total: integrationsTotal,
    integrations_with_claims: integrationsWithClaims,
    integrations_without_claims: integrationsWithoutClaims,
    claims_total: claimsTotal,
    claims_with_active_attestation: claimsAttested,
    claims_without_active_attestation: claimsTotal - claimsAttested,
    attestations_total: attestationsRow?.value ?? 0,
    integrations_without_claims_sample: sample,
    integrations_without_claims_sample_truncated: integrationsWithoutClaims > sample.length,
  };
}

// ─── Totals ──────────────────────────────────────────────────────────────────

/** The five headline counts. `products` is re-counted here rather than reused
 *  from {@link productGapCounts} so the two call sites stay independent — they
 *  are one `count(*)` apiece and the coupling would not pay for itself. */
export async function catalogTotals(db: Db): Promise<{
  products: number;
  integrations: number;
  vendors: number;
  claims: number;
  attestations: number;
}> {
  const [[p], [i], [v], [c], [a]] = await Promise.all([
    db.select({ value: count() }).from(products),
    db.select({ value: count() }).from(integrations),
    db.select({ value: count() }).from(vendors),
    db.select({ value: count() }).from(claims),
    db.select({ value: count() }).from(attestations),
  ]);
  return {
    products: p?.value ?? 0,
    integrations: i?.value ?? 0,
    vendors: v?.value ?? 0,
    claims: c?.value ?? 0,
    attestations: a?.value ?? 0,
  };
}
