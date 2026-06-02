/**
 * AECI-104 — integration test for denormalized product-count maintenance +
 * reconciliation, against a real Prisma client on `TEST_DATABASE_URL`.
 *
 * Seeds a product graph (integrations + approved/pending/archived reviews)
 * directly via Prisma, corrupts the stored aggregate columns, asserts
 * `findProductCountDrift` flags the corruption, then asserts
 * `recomputeProductCounts` repairs the row to the exact source-derived values
 * (NULL averages where there are zero approved reviews) and clears the drift.
 *
 * This is the canonical reconciliation guard against a write path forgetting to
 * recompute. Gated on `TEST_DATABASE_URL`; `describe.skipIf` keeps the unit lane
 * quiet when unset (same harness as airtable-to-supabase-bulk-migrate.spec.ts).
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findProductCountDrift,
  recomputeProductCounts,
  type DriftClient,
  type RecomputeClient,
} from '../lib/product-counts';

const testDbUrl = process.env.TEST_DATABASE_URL;
const TAG = `pc${Date.now()}`;
const slugA = `prod-a-${TAG}`;
const slugB = `prod-b-${TAG}`;

describe.skipIf(!testDbUrl)('product-count reconciliation — integration (AECI-104)', () => {
  let prisma: PrismaClient;
  let productAId = '';
  let productBId = '';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: testDbUrl });

    const a = await prisma.product.create({ data: { slug: slugA, name: `Prod A ${TAG}` } });
    const b = await prisma.product.create({ data: { slug: slugB, name: `Prod B ${TAG}` } });
    productAId = a.id;
    productBId = b.id;

    // A links to B (A is source) and B links to A (A is target) → A has 2.
    await prisma.integration.create({
      data: { name: `int1 ${TAG}`, sourceProductId: a.id, targetProductId: b.id },
    });
    await prisma.integration.create({
      data: { name: `int2 ${TAG}`, sourceProductId: b.id, targetProductId: a.id },
    });

    // Reviews on A: two approved (counted), plus pending + archived (ignored).
    await prisma.review.createMany({
      data: [
        {
          productId: a.id,
          status: 'approved',
          ratingOverall: 5,
          ratingOnboarding: 3,
          title: 't',
          body: 'b',
        },
        {
          productId: a.id,
          status: 'approved',
          ratingOverall: 4,
          ratingOnboarding: 5,
          title: 't',
          body: 'b',
        },
        {
          productId: a.id,
          status: 'pending',
          ratingOverall: 1,
          ratingOnboarding: 1,
          title: 't',
          body: 'b',
        },
        {
          productId: a.id,
          status: 'archived',
          ratingOverall: 1,
          ratingOnboarding: 1,
          title: 't',
          body: 'b',
        },
      ],
    });

    // Establish a correct denormalized baseline. The raw integration/review
    // inserts above bypass the app-layer recompute (no DB trigger maintains
    // these columns in Stage 1 — see lib/product-counts.ts), so without this
    // both A and B would start at the column defaults (0/0/NULL/NULL). B in
    // particular would then show integration_count drift (stored 0 vs its 2
    // integrations) and pollute the `before` assertion below. Recompute so the
    // only drift the test observes is the corruption it deliberately injects
    // into A.
    await recomputeProductCounts(prisma as unknown as RecomputeClient, [productAId, productBId]);
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = [productAId, productBId].filter(Boolean);
    if (ids.length) {
      await prisma.review.deleteMany({ where: { productId: { in: ids } } });
      await prisma.integration.deleteMany({
        where: { OR: [{ sourceProductId: { in: ids } }, { targetProductId: { in: ids } }] },
      });
      await prisma.product.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it('detects drift, then recompute repairs to the exact source-derived values', async () => {
    const drift = prisma as unknown as DriftClient;
    const recompute = prisma as unknown as RecomputeClient;
    const mine = <T extends { productId: string }>(rows: T[]): T[] =>
      rows.filter((d) => d.productId === productAId || d.productId === productBId);

    // Corrupt A's stored columns: wrong integration count, a stale non-null
    // onboarding average despite the real onboarding avg being 4.
    await prisma.product.update({
      where: { id: productAId },
      data: {
        integrationCount: 99,
        reviewCount: 0,
        ratingOverallAvg: 1.0,
        ratingOnboardingAvg: 2.0,
      },
    });

    const before = mine(await findProductCountDrift(drift));
    expect(before.map((d) => d.field).sort()).toEqual([
      'integrationCount',
      'ratingOnboardingAvg',
      'ratingOverallAvg',
      'reviewCount',
    ]);

    await recomputeProductCounts(recompute, [productAId, productBId]);

    const a = await prisma.product.findUniqueOrThrow({ where: { id: productAId } });
    expect(a.integrationCount).toBe(2);
    expect(a.reviewCount).toBe(2);
    expect(Number(a.ratingOverallAvg)).toBeCloseTo(4.5, 2); // (5+4)/2
    expect(Number(a.ratingOnboardingAvg)).toBeCloseTo(4, 2); // (3+5)/2

    // B has 2 integrations and zero approved reviews → averages NULL.
    const b = await prisma.product.findUniqueOrThrow({ where: { id: productBId } });
    expect(b.integrationCount).toBe(2);
    expect(b.reviewCount).toBe(0);
    expect(b.ratingOverallAvg).toBeNull();
    expect(b.ratingOnboardingAvg).toBeNull();

    expect(mine(await findProductCountDrift(drift))).toEqual([]);
  });
});
