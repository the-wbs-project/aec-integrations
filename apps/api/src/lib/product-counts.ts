/**
 * Denormalized product-count maintenance + reconciliation (AECI-104).
 *
 * LEGACY Prisma path — retained ONLY for `routes/promote.ts` + its specs until
 * that route migrates to Drizzle (ADR 0016 / AECI-253). The Drizzle successor is
 * `lib/recompute-counts.ts`; once promote moves over, delete this file.
 *
 * `products.integration_count`, `products.review_count`,
 * `products.rating_overall_avg`, and `products.rating_onboarding_avg` are
 * denormalized for read performance and kept in sync at the application layer.
 * The aggregation rule (single source of truth):
 *   - `integration_count` = integrations where the product is source OR target.
 *   - `review_count` + both averages count ONLY `status = 'approved'` reviews;
 *     zero approved reviews → NULL averages.
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNum(v: AvgScalar): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

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

export async function recomputeProductCounts(
  db: RecomputeClient,
  productIds: Iterable<string>,
): Promise<void> {
  for (const id of productIds) {
    const expected = await computeExpected(db, id);
    await db.product.update({ where: { id }, data: expected });
  }
}

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
