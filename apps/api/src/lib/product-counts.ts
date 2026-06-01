/**
 * Denormalized product-count maintenance + reconciliation (AECI-104).
 *
 * `products.integration_count`, `products.review_count`,
 * `products.rating_overall_avg`, and `products.rating_onboarding_avg` are
 * denormalized for read performance. In Stage 1 they are kept in sync at the
 * **application layer** (NOT by DB triggers — those stay deferred to Phase 2,
 * see DATABASE_SCHEMA.md §11.2). Every write path that mutates `integrations`
 * or `reviews` must call `recomputeProductCounts()` for the touched products
 * **inside the same transaction** as the mutation, so the stored columns can
 * never lag the source rows.
 *
 * This module is the single source of truth for the aggregation rule:
 *   - `integration_count` = integrations where the product is the source OR the
 *     target endpoint (`poweredByProductId` is not counted).
 *   - `review_count` and both rating averages count ONLY reviews with
 *     `status = 'approved'` — the only publicly visible state
 *     (STAGE_1_SPEC.md §4.7 "no public visibility until approved"; §12). When a
 *     product has zero approved reviews the averages are NULL, matching the
 *     column defaults.
 *
 * `findProductCountDrift()` recomputes the expected values from the source rows
 * and reports any product whose stored columns disagree — the reconciliation
 * guard against a write path forgetting to recompute. Both functions share the
 * private `computeExpected()` primitive so "what we write" and "what we check"
 * can never diverge on the rule.
 *
 * Cache-Tag purging of affected pages is a SEPARATE concern (see CLAUDE.md
 * "Cache invalidation") and is not part of count maintenance.
 *
 * NOTE (future review write path, Phase 5/6): review submission, moderation
 * (approve/reject), and the §1073 reject→archive recompute must each call
 * `recomputeProductCounts()` for the affected product in their write tx.
 */

/** The only review status counted toward public aggregates. */
export const COUNTED_REVIEW_STATUS = 'approved';

/** Prisma `_avg` returns a Decimal (real client), a number (fakes), or null. */
type AvgScalar = number | string | { toString(): string } | null | undefined;

type CountArgs = { where?: Record<string, unknown> };
type AggregateArgs = { where?: Record<string, unknown>; _avg: Record<string, true> };

type IntegrationReader = { count(args?: CountArgs): Promise<number> };
type ReviewReader = {
  count(args?: CountArgs): Promise<number>;
  aggregate(args: AggregateArgs): Promise<{ _avg: Record<string, AvgScalar> }>;
};
type ProductWriter = {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
};
type ProductCountRow = {
  id: string;
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: AvgScalar;
  ratingOnboardingAvg: AvgScalar;
};
type ProductReader = {
  findMany(args: { select: Record<string, boolean> }): Promise<ProductCountRow[]>;
};

/** Minimal structural client for `recomputeProductCounts` — satisfied by the
 * Accelerate edge client, the vanilla node client, `PromoteTx`, and test fakes. */
export type RecomputeClient = {
  integration: IntegrationReader;
  review: ReviewReader;
  product: ProductWriter;
};

/** Read-only client surface needed by `findProductCountDrift`. */
export type DriftClient = {
  integration: IntegrationReader;
  review: ReviewReader;
  product: ProductReader;
};

/** Expected denormalized values recomputed from source rows. */
export type ExpectedProductCounts = {
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: number | null;
  ratingOnboardingAvg: number | null;
};

export type ProductCountField = keyof ExpectedProductCounts;

export type ProductCountDrift = {
  productId: string;
  field: ProductCountField;
  stored: number | null;
  expected: number | null;
};

/** numeric(3,2) precision — stored averages are rounded to 2dp by Postgres, so
 * we round expected values the same way before comparing. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Coerce a Prisma Decimal / number / string / null into a finite number or null. */
function toNum(v: AvgScalar): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

/** The aggregation rule, in one place. Recomputes the four denormalized columns
 * for a single product from the `integrations` / `reviews` source rows. */
async function computeExpected(
  db: { integration: IntegrationReader; review: ReviewReader },
  productId: string,
): Promise<ExpectedProductCounts> {
  const integrationCount = await db.integration.count({
    where: { OR: [{ sourceProductId: productId }, { targetProductId: productId }] },
  });

  const approvedWhere = { productId, status: COUNTED_REVIEW_STATUS };
  const reviewCount = await db.review.count({ where: approvedWhere });
  const agg = await db.review.aggregate({
    where: approvedWhere,
    _avg: { ratingOverall: true, ratingOnboarding: true },
  });

  const overall = toNum(agg._avg.ratingOverall);
  const onboarding = toNum(agg._avg.ratingOnboarding);
  return {
    integrationCount,
    reviewCount,
    ratingOverallAvg: overall === null ? null : round2(overall),
    ratingOnboardingAvg: onboarding === null ? null : round2(onboarding),
  };
}

/**
 * Recompute and persist the denormalized aggregates for `productIds`. Call
 * inside the same transaction as the integration/review write. No-op on an
 * empty id set. Runs sequentially to stay transaction-safe and avoid connection
 * storms on the bulk path.
 */
export async function recomputeProductCounts(
  db: RecomputeClient,
  productIds: Iterable<string>,
): Promise<void> {
  for (const id of productIds) {
    const expected = await computeExpected(db, id);
    await db.product.update({ where: { id }, data: expected });
  }
}

/**
 * Recompute expected aggregates for every product and return the rows whose
 * stored columns disagree — one entry per drifted field. Read-only; never
 * writes. An empty array means no drift.
 */
export async function findProductCountDrift(db: DriftClient): Promise<ProductCountDrift[]> {
  const products = await db.product.findMany({
    select: {
      id: true,
      integrationCount: true,
      reviewCount: true,
      ratingOverallAvg: true,
      ratingOnboardingAvg: true,
    },
  });

  const drift: ProductCountDrift[] = [];
  for (const p of products) {
    const expected = await computeExpected(db, p.id);
    pushIntDrift(drift, p.id, 'integrationCount', p.integrationCount, expected.integrationCount);
    pushIntDrift(drift, p.id, 'reviewCount', p.reviewCount, expected.reviewCount);
    pushAvgDrift(
      drift,
      p.id,
      'ratingOverallAvg',
      toNum(p.ratingOverallAvg),
      expected.ratingOverallAvg,
    );
    pushAvgDrift(
      drift,
      p.id,
      'ratingOnboardingAvg',
      toNum(p.ratingOnboardingAvg),
      expected.ratingOnboardingAvg,
    );
  }
  return drift;
}

function pushIntDrift(
  out: ProductCountDrift[],
  productId: string,
  field: ProductCountField,
  stored: number,
  expected: number,
): void {
  if (stored !== expected) out.push({ productId, field, stored, expected });
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
