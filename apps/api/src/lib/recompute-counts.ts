/**
 * Denormalized product-count recompute — Drizzle/D1 successor to the Prisma
 * `lib/product-counts.ts` (ADR 0016 / AECI-253). Same aggregation rule:
 *   - `integration_count` = integrations where the product is source OR target.
 *   - `review_count` + both averages count ONLY `status = 'approved'` reviews;
 *     zero approved reviews → NULL averages.
 *
 * D1 has no interactive transactions, so this recompute runs as a separate
 * read+write AFTER the mutating `db.batch` commits (the denormalization may lag
 * briefly; `findProductCountDrift` is the reconciliation backstop).
 */

import { and, avg, count, eq, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations, products, reviews } from '../db/schema';

export const COUNTED_REVIEW_STATUS = 'approved';

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

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function computeExpected(db: Db, productId: string): Promise<ExpectedProductCounts> {
  const [intRow] = await db
    .select({ value: count() })
    .from(integrations)
    .where(
      or(eq(integrations.sourceProductId, productId), eq(integrations.targetProductId, productId)),
    );

  const approved = and(eq(reviews.productId, productId), eq(reviews.status, COUNTED_REVIEW_STATUS));
  const [revRow] = await db
    .select({
      value: count(),
      overall: avg(reviews.ratingOverall),
      onboarding: avg(reviews.ratingOnboarding),
    })
    .from(reviews)
    .where(approved);

  const overall = toNum(revRow?.overall ?? null);
  const onboarding = toNum(revRow?.onboarding ?? null);
  return {
    integrationCount: intRow?.value ?? 0,
    reviewCount: revRow?.value ?? 0,
    ratingOverallAvg: overall === null ? null : round2(overall),
    ratingOnboardingAvg: onboarding === null ? null : round2(onboarding),
  };
}

/** Recompute + persist the denormalized aggregates for `productIds` (sequential;
 *  no-op on empty). Call AFTER the mutating batch commits. */
export async function recomputeProductCounts(db: Db, productIds: Iterable<string>): Promise<void> {
  for (const id of productIds) {
    const expected = await computeExpected(db, id);
    await db.update(products).set(expected).where(eq(products.id, id));
  }
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
    if (p.integrationCount !== expected.integrationCount) {
      drift.push({
        productId: p.id,
        field: 'integrationCount',
        stored: p.integrationCount,
        expected: expected.integrationCount,
      });
    }
    if (p.reviewCount !== expected.reviewCount) {
      drift.push({
        productId: p.id,
        field: 'reviewCount',
        stored: p.reviewCount,
        expected: expected.reviewCount,
      });
    }
    pushAvgDrift(drift, p.id, 'ratingOverallAvg', p.ratingOverallAvg, expected.ratingOverallAvg);
    pushAvgDrift(
      drift,
      p.id,
      'ratingOnboardingAvg',
      p.ratingOnboardingAvg,
      expected.ratingOnboardingAvg,
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
