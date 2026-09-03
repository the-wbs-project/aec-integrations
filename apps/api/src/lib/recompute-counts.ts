/**
 * Denormalized product-count recompute — Drizzle/D1 successor to the Prisma
 * `lib/product-counts.ts` (ADR 0016 / AECI-253). Aggregation rule:
 *   - `integration_count` = **delivered edges, regardless of which table holds
 *     them** (`STAGE_1_5_SPEC.md` §13.5). That is: rows of `integrations` where
 *     the product is source OR target, PLUS rows of `connector_evidenced_pairs`
 *     where it is an endpoint OR **the connector**.
 *   - `review_count` + both averages count ONLY `status = 'approved'` reviews;
 *     zero approved reviews → NULL averages.
 *
 * ── THE CANONICAL DEFINITION (AECI-721) ─────────────────────────────────────
 * This function is site 1 of **fourteen** that express the same rule, and the one
 * the other thirteen are written to mirror. Two properties of the rule are load
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

import { and, avg, count, eq, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, reviews } from '../db/schema';

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

async function computeExpected(db: Db, productId: string): Promise<ExpectedProductCounts> {
  const [intRow] = await db
    .select({ value: count() })
    .from(integrations)
    .where(
      or(eq(integrations.sourceProductId, productId), eq(integrations.targetProductId, productId)),
    );

  // The evidenced arm — see the header. Three disjuncts, not two: an endpoint in
  // either canonical slot, and the connector itself (§12.5 option B).
  const [evidencedRow] = await db
    .select({ value: count() })
    .from(connectorEvidencedPairs)
    .where(
      or(
        eq(connectorEvidencedPairs.productAId, productId),
        eq(connectorEvidencedPairs.productBId, productId),
        eq(connectorEvidencedPairs.connectorProductId, productId),
      ),
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
    integrationCount: (intRow?.value ?? 0) + (evidencedRow?.value ?? 0),
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
