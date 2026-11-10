/**
 * Denormalized product-count recompute — Drizzle/D1 successor to the Prisma
 * `lib/product-counts.ts` (ADR 0016 / AECI-253). Aggregation rule:
 *   - `integration_count` = **delivered edges, regardless of which table holds
 *     them** (`STAGE_1_5_SPEC.md` §13.5). That is: LIVE rows of `integrations`
 *     (`retired_at IS NULL`, AECI-1010) where the product is source OR target, PLUS LIVE rows
 *     of `connector_evidenced_pairs` (AECI-1091) where it is an endpoint OR **the connector**.
 *   - `review_count` + both averages count ONLY `status = 'approved'` reviews;
 *     zero approved reviews → NULL averages.
 *   - Each approved review is averaged at its EFFECTIVE rating (AECI-1613): the
 *     ratings of its latest `approved` update that carries ratings
 *     (`published_at DESC, id DESC`), else its own. {@link effectiveRatingSql}.
 *     `review_count` never reads `review_updates`: an update is not a review.
 *
 * ── THE CANONICAL DEFINITION (AECI-721) ─────────────────────────────────────
 * This function is site 1 of the lockstep list (`LOCKSTEP_SITES` in
 * `count-lockstep.spec.ts`), and the one the others are written to mirror. Two properties of the rule are load
 * bearing and easy to break separately:
 *
 *   **Endpoint totals must not move.** A delivered-via-connector edge already
 *   counted for its two endpoints before the migration, because the old rule had
 *   no status filter and no table qualifier. Counting the evidenced table here is
 *   what keeps that true afterwards — otherwise a *data* migration silently
 *   deducts from ~40 products and re-ranks the catalogue through
 *   `desc(integration_count)` on two Algolia indices, a numeric facet and two
 *   sort replicas.
 *
 *   **The connector's own count moves ON PURPOSE.** §12.5 was open until §13.5
 *   resolved it as option B: a connector counts the edges it powers. That is the
 *   `connectorProductId` disjunct, and it is why Agave ERP Sync goes 0 → 12 in
 *   production — a connector page that renders twelve pairs while claiming zero
 *   integrations was the anomaly, not the fix.
 *
 * **Evidenced only, never derived.** Only the delivered tier reaches a count.
 * Reachable pairs — derived at read time from `connector_stubs` +
 * `connector_stub_mappings` — must never appear here. MindCloud's catalogue alone
 * is ~3,411 stubs against facet buckets (`0 / 1–10 / 11–50 / 51+`) calibrated on a
 * catalogue topping out near 52: derived pairs would not shift the numbers, they
 * would destroy the scale.
 *
 * D1 has no interactive transactions, so this recompute runs as a separate
 * read+write AFTER the mutating `db.batch` commits (the denormalization may lag
 * briefly; `findProductCountDrift` is the reconciliation backstop).
 */

import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  products,
  reviews,
  reviewUpdates,
} from '../db/schema';
import { liveEvidencedPairWhere, liveIntegrationWhere } from './live-integration';

export const COUNTED_REVIEW_STATUS = 'approved';

export type ExpectedProductCounts = {
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: number | null;
  ratingOnboardingAvg: number | null;
};

export type ProductCountField = keyof ExpectedProductCounts;

/** A product's STORED aggregates — same shape as `ExpectedProductCounts`, but the
 *  values read off the `products` row rather than recomputed from source rows. */
export type StoredProductCounts = ExpectedProductCounts;

export type ProductCountDrift = {
  productId: string;
  field: ProductCountField;
  stored: number | null;
  expected: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The `integration_count` rule as ONE SQL expression over a bound product id. Site 1
 * of the lockstep list, used twice: {@link computeExpected} selects it, and
 * {@link integrationCountRecomputeStmt} writes it inside a caller's batch. One
 * expression, so the two can never drift apart.
 *
 * Two arms. LIVE `integrations` rows where the product is source or target
 * (AECI-1010: a retired row counts nowhere), plus `connector_evidenced_pairs` where
 * it is an endpoint in either canonical slot or the connector itself (§12.5 option
 * B). Both arms count LIVE rows only: since AECI-1091 an evidenced pair can be
 * retired too (`lib/live-integration.ts` rule 2).
 *
 * `productId` is a bound id, or (for {@link recomputeProductCounts}'s set-based
 * UPDATE) the outer `"products"."id"` column as SQL.
 */
function integrationCountSql(productId: string | SQL): SQL<number> {
  return sql<number>`(
    (SELECT COUNT(*) FROM ${integrations}
      WHERE (${integrations.sourceProductId} = ${productId}
          OR ${integrations.targetProductId} = ${productId})
        AND ${liveIntegrationWhere})
    + (SELECT COUNT(*) FROM ${connectorEvidencedPairs}
        WHERE (${connectorEvidencedPairs.productAId} = ${productId}
           OR ${connectorEvidencedPairs.productBId} = ${productId}
           OR ${connectorEvidencedPairs.connectorProductId} = ${productId})
          AND ${liveEvidencedPairWhere}))`;
}

/** The status of an update that counts toward its review's rating. */
export const COUNTED_UPDATE_STATUS = 'approved';

/** Inlined, not bound: {@link roundedApprovedAvgSql} repeats the expression four
 *  times per average, and a bound value each time would eat into the
 *  {@link RECOMPUTE_ID_CHUNK} headroom under D1's 100-parameter cap. */
const APPROVED_UPDATE_LITERAL = sql.raw(`'${COUNTED_UPDATE_STATUS}'`);

/**
 * One approved review's EFFECTIVE rating for `column` (AECI-1613), as SQL over the
 * enclosing query's `"reviews"` row. The rating of the review's latest approved
 * update that carries ratings, by `published_at DESC, id DESC`, else the review's
 * own. Rating-less updates are skipped, so the newest one that re-rated wins. A
 * removed update is not `approved`, so removing one reverts to the next.
 *
 * Site 1 of the averages rule. `scripts/reconcile-product-counts.ts` and
 * `RECOMPUTE_PRODUCTS` in `@aeci/shared/seed-reviews` mirror it in raw SQL through
 * `effectiveReviewRatingSql`. `recompute-counts.spec.ts` pins the forms together.
 * A correlated scalar subquery, not a JOIN or compound SELECT, so it stays inside
 * D1's limits and is served by `review_updates_review_status_published_idx`.
 */
function effectiveRatingSql(column: 'overall' | 'onboarding'): SQL<number> {
  const own = column === 'overall' ? reviews.ratingOverall : reviews.ratingOnboarding;
  const updated =
    column === 'overall' ? reviewUpdates.ratingOverall : reviewUpdates.ratingOnboarding;
  return sql<number>`COALESCE((SELECT ${updated} FROM ${reviewUpdates}
      WHERE ${reviewUpdates.reviewId} = ${reviews.id}
        AND ${reviewUpdates.status} = ${APPROVED_UPDATE_LITERAL}
        AND ${updated} IS NOT NULL
      ORDER BY ${reviewUpdates.publishedAt} DESC, ${reviewUpdates.id} DESC
      LIMIT 1), ${own})`;
}

async function computeExpected(db: Db, productId: string): Promise<ExpectedProductCounts> {
  // The canonical count (site 1). Selected off the product's own row, so an unknown
  // id reads as zero rather than failing.
  const [intRow] = await db
    .select({ value: integrationCountSql(productId) })
    .from(products)
    .where(eq(products.id, productId));

  const approved = and(eq(reviews.productId, productId), eq(reviews.status, COUNTED_REVIEW_STATUS));
  const [revRow] = await db
    .select({
      value: count(),
      overall: sql<number | null>`AVG(${effectiveRatingSql('overall')})`,
      onboarding: sql<number | null>`AVG(${effectiveRatingSql('onboarding')})`,
    })
    .from(reviews)
    .where(approved);

  const overall = toNum(revRow?.overall ?? null);
  const onboarding = toNum(revRow?.onboarding ?? null);
  return {
    integrationCount: Number(intRow?.value ?? 0),
    reviewCount: revRow?.value ?? 0,
    ratingOverallAvg: overall === null ? null : round2(overall),
    ratingOnboardingAvg: onboarding === null ? null : round2(onboarding),
  };
}

/** The outer row of the set-based UPDATE below. Written out in full: inside a
 *  subquery a bare `"id"` would bind to the subquery's own table. */
const OUTER_PRODUCT_ID = sql`"products"."id"`;

/** Approved reviews of the outer product. */
const outerApproved = sql`${reviews.productId} = ${OUTER_PRODUCT_ID} AND ${reviews.status} = ${COUNTED_REVIEW_STATUS}`;

/**
 * The outer product's approved-review average of the effective `column` rating
 * ({@link effectiveRatingSql}), rounded by
 * {@link round2} in SQL, bit for bit. SQLite's `ROUND(x, 2)` is NOT the same
 * function: `ROUND(107.0/40, 2)` is 2.67 where `Math.round(2.675 * 100) / 100` is
 * 2.68, and {@link findProductCountDrift} compares against the JS rounding with a
 * 0.005 tolerance, so a `ROUND()` write would read as drift. This is `Math.round`
 * for a positive value: truncate, then add one when the fraction is at least a
 * half (`y − trunc(y)` is exact in binary floating point). Ratings are 1–5, so `y`
 * is always positive. NULL in, NULL out, for a product with no approved review.
 * Verified against the JS function for every `s/n` with `n ≤ 300` (AECI-1484).
 *
 * One scalar subquery: SQLite computes the repeated `AVG(…)` once per group.
 */
function roundedApprovedAvgSql(column: 'overall' | 'onboarding'): SQL<number | null> {
  const y = sql`(AVG(${effectiveRatingSql(column)}) * 100)`;
  const t = sql`CAST(${y} AS INTEGER)`;
  return sql<
    number | null
  >`(SELECT (CASE WHEN ${y} - ${t} >= 0.5 THEN ${t} + 1 ELSE ${t} END) / 100.0 FROM ${reviews} WHERE ${outerApproved})`;
}

/** Upper bound on ids per UPDATE: well inside D1's 100-bound-parameter cap,
 *  leaving room for the few literals the SET clause binds. */
const RECOMPUTE_ID_CHUNK = 80;

/**
 * Recompute + persist the denormalized aggregates for `productIds` (no-op on
 * empty). Call AFTER the mutating batch commits.
 *
 * One `UPDATE products SET … WHERE id IN (…)` per {@link RECOMPUTE_ID_CHUNK} ids,
 * each column a correlated subquery on the outer row (AECI-1484). Until then this
 * was three sequential round trips per product (two reads, one write). The SET
 * clause is {@link computeExpected} in SQL: the same {@link integrationCountSql}
 * (lockstep site 1), the same approved-only review count, and the same averages
 * rounded by {@link roundedApprovedAvgSql}. `recompute-counts.spec.ts` pins the two forms to
 * each other. An unknown id matches no row, so it is a no-op, as before.
 *
 * A derived write (ADR 0022 exempt list, `recompute-counts`): no audit row.
 */
export async function recomputeProductCounts(db: Db, productIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(productIds)];
  for (let i = 0; i < ids.length; i += RECOMPUTE_ID_CHUNK) {
    await db
      .update(products)
      .set({
        integrationCount: integrationCountSql(OUTER_PRODUCT_ID),
        reviewCount: sql<number>`(SELECT COUNT(*) FROM ${reviews} WHERE ${outerApproved})`,
        ratingOverallAvg: roundedApprovedAvgSql('overall'),
        ratingOnboardingAvg: roundedApprovedAvgSql('onboarding'),
      })
      .where(inArray(products.id, ids.slice(i, i + RECOMPUTE_ID_CHUNK)));
  }
}

/**
 * The in-batch form of the `integration_count` rule (lockstep site 1), for a write
 * that must commit the count WITH its mutation rather than after it.
 *
 * The integration retire and restore (AECI-1010) push one of these per endpoint
 * into their own `db.batch`. The post-commit {@link recomputeProductCounts} ran in
 * one `waitUntil` while the cache purge ran in another, so a page re-rendered
 * between the purge and the recompute cached the old count until its TTL. Inside
 * the batch the count is committed before any purge is even enqueued.
 *
 * The same expression {@link computeExpected} selects ({@link integrationCountSql}),
 * so this is site 1 again, not a new lockstep site. A derived write (ADR 0022), so no audit row. Only
 * `integration_count` moves: the review aggregates cannot change on these writes.
 */
export function integrationCountRecomputeStmt(db: Db, productId: string) {
  return db
    .update(products)
    .set({ integrationCount: integrationCountSql(productId) })
    .where(eq(products.id, productId));
}

/**
 * Compare one product's STORED aggregates against freshly-computed EXPECTED
 * values; return one entry per drifted field. Pure (no I/O) — the single
 * definition of the drift RULE, shared by `findProductCountDrift` (live Db) and
 * the scheduled reconcile CLI (`scripts/reconcile-product-counts.ts`, which works
 * off raw D1 rows because it can't hold a Worker binding). Counts must match
 * exactly; averages tolerate `< 0.005` (both are already rounded to 2dp) and
 * treat a null↔value transition as drift — see `pushAvgDrift`.
 */
export function diffProductCounts(
  productId: string,
  stored: StoredProductCounts,
  expected: ExpectedProductCounts,
): ProductCountDrift[] {
  const drift: ProductCountDrift[] = [];
  if (stored.integrationCount !== expected.integrationCount) {
    drift.push({
      productId,
      field: 'integrationCount',
      stored: stored.integrationCount,
      expected: expected.integrationCount,
    });
  }
  if (stored.reviewCount !== expected.reviewCount) {
    drift.push({
      productId,
      field: 'reviewCount',
      stored: stored.reviewCount,
      expected: expected.reviewCount,
    });
  }
  pushAvgDrift(
    drift,
    productId,
    'ratingOverallAvg',
    stored.ratingOverallAvg,
    expected.ratingOverallAvg,
  );
  pushAvgDrift(
    drift,
    productId,
    'ratingOnboardingAvg',
    stored.ratingOnboardingAvg,
    expected.ratingOnboardingAvg,
  );
  return drift;
}

/** Recompute expected aggregates for every product; return drifted fields. */
export async function findProductCountDrift(db: Db): Promise<ProductCountDrift[]> {
  const rows = await db.query.products.findMany({
    columns: {
      id: true,
      integrationCount: true,
      reviewCount: true,
      ratingOverallAvg: true,
      ratingOnboardingAvg: true,
    },
  });

  const drift: ProductCountDrift[] = [];
  for (const p of rows) {
    const expected = await computeExpected(db, p.id);
    drift.push(
      ...diffProductCounts(
        p.id,
        {
          integrationCount: p.integrationCount,
          reviewCount: p.reviewCount,
          ratingOverallAvg: p.ratingOverallAvg,
          ratingOnboardingAvg: p.ratingOnboardingAvg,
        },
        expected,
      ),
    );
  }
  return drift;
}

function pushAvgDrift(
  out: ProductCountDrift[],
  productId: string,
  field: ProductCountField,
  stored: number | null,
  expected: number | null,
): void {
  const equal =
    (stored === null && expected === null) ||
    (stored !== null && expected !== null && Math.abs(stored - expected) < 0.005);
  if (!equal) out.push({ productId, field, stored, expected });
}

/**
 * {@link integrationCountRecomputeStmt} for many products at once (AECI-1238): one
 * set-based `UPDATE … WHERE id IN (…)` per {@link RECOMPUTE_ID_CHUNK} ids, for a
 * caller's own batch. A listing hide changes the count of every counterpart and
 * connector of every product it hides, which on a large company is hundreds of
 * products. The same expression ({@link integrationCountSql}), so this is site 1
 * again, not a new lockstep site. A derived write (ADR 0022): no audit row.
 */
export function integrationCountRecomputeStmts(db: Db, productIds: Iterable<string>) {
  const ids = [...new Set(productIds)];
  const stmts = [];
  for (let i = 0; i < ids.length; i += RECOMPUTE_ID_CHUNK) {
    stmts.push(
      db
        .update(products)
        .set({ integrationCount: integrationCountSql(OUTER_PRODUCT_ID) })
        .where(inArray(products.id, ids.slice(i, i + RECOMPUTE_ID_CHUNK))),
    );
  }
  return stmts;
}
