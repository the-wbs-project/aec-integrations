import { describe, expect, it } from 'vitest';

import {
  COUNTED_REVIEW_STATUS,
  findProductCountDrift,
  recomputeProductCounts,
} from './product-counts';

/**
 * Unit coverage for the denormalized product-count maintenance + reconciliation
 * helpers (AECI-104), driven by a tiny in-memory fake.
 *
 * This also stands in for the AECI-86-disabled promote write path: that block
 * calls exactly `recomputeProductCounts(tx, affectedProducts)`, so proving the
 * helper here proves the promote recompute is correct by construction once
 * re-enabled. The bulk-migrate active path is additionally covered end-to-end in
 * src/integration/airtable-to-supabase-bulk-migrate.spec.ts.
 */

type Rec = Record<string, unknown>;

function matchWhere(row: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Rec[]).some((cond) => matchWhere(row, cond))) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

type IntegrationSeed = { sourceProductId: string; targetProductId: string };
type ReviewSeed = {
  productId: string;
  status: string;
  ratingOverall: number;
  ratingOnboarding: number;
};
type ProductSeed = {
  id: string;
  integrationCount?: number;
  reviewCount?: number;
  ratingOverallAvg?: number | null;
  ratingOnboardingAvg?: number | null;
};

function makeDb(seed: {
  products: ProductSeed[];
  integrations?: IntegrationSeed[];
  reviews?: ReviewSeed[];
}) {
  const products = new Map<string, Rec>(
    seed.products.map((p) => [
      p.id,
      {
        id: p.id,
        integrationCount: p.integrationCount ?? 0,
        reviewCount: p.reviewCount ?? 0,
        ratingOverallAvg: p.ratingOverallAvg ?? null,
        ratingOnboardingAvg: p.ratingOnboardingAvg ?? null,
      },
    ]),
  );
  const integrations = (seed.integrations ?? []).map((r) => ({ ...r }) as Rec);
  const reviews = (seed.reviews ?? []).map((r) => ({ ...r }) as Rec);
  const updates: { id: string; data: Rec }[] = [];

  return {
    updates,
    products,
    integration: {
      count: async ({ where }: { where?: Rec } = {}) =>
        integrations.filter((r) => matchWhere(r, where)).length,
    },
    review: {
      count: async ({ where }: { where?: Rec } = {}) =>
        reviews.filter((r) => matchWhere(r, where)).length,
      aggregate: async ({ where, _avg }: { where?: Rec; _avg: Record<string, true> }) => {
        const rows = reviews.filter((r) => matchWhere(r, where));
        const out: Record<string, number | null> = {};
        for (const field of Object.keys(_avg)) {
          out[field] =
            rows.length === 0 ? null : rows.reduce((a, r) => a + Number(r[field]), 0) / rows.length;
        }
        return { _avg: out };
      },
    },
    product: {
      findMany: async ({ select: _select }: { select: Record<string, boolean> }) =>
        [...products.values()] as never,
      update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        const prev = products.get(where.id) ?? { id: where.id };
        const row = { ...prev, ...data };
        products.set(where.id, row);
        updates.push({ id: where.id, data });
        return row;
      },
    },
  };
}

const approved = (
  productId: string,
  ratingOverall: number,
  ratingOnboarding: number,
): ReviewSeed => ({
  productId,
  status: COUNTED_REVIEW_STATUS,
  ratingOverall,
  ratingOnboarding,
});

describe('recomputeProductCounts', () => {
  it('counts integrations where the product is the source OR the target endpoint', async () => {
    const db = makeDb({
      products: [{ id: 'p1' }],
      integrations: [
        { sourceProductId: 'p1', targetProductId: 'x' }, // source
        { sourceProductId: 'y', targetProductId: 'p1' }, // target
        { sourceProductId: 'y', targetProductId: 'z' }, // unrelated
      ],
    });

    await recomputeProductCounts(db, ['p1']);

    expect(db.products.get('p1')).toMatchObject({ integrationCount: 2 });
  });

  it('counts and averages only status=approved reviews', async () => {
    const db = makeDb({
      products: [{ id: 'p1' }],
      reviews: [
        approved('p1', 5, 3),
        approved('p1', 4, 5),
        { productId: 'p1', status: 'pending', ratingOverall: 1, ratingOnboarding: 1 },
        { productId: 'p1', status: 'archived', ratingOverall: 1, ratingOnboarding: 1 },
        { productId: 'p1', status: 'rejected', ratingOverall: 1, ratingOnboarding: 1 },
      ],
    });

    await recomputeProductCounts(db, ['p1']);

    expect(db.products.get('p1')).toMatchObject({
      reviewCount: 2,
      ratingOverallAvg: 4.5, // (5+4)/2
      ratingOnboardingAvg: 4, // (3+5)/2
    });
  });

  it('rounds rating averages to 2dp (numeric(3,2) precision)', async () => {
    const db = makeDb({
      products: [{ id: 'p1' }],
      reviews: [approved('p1', 5, 1), approved('p1', 4, 1), approved('p1', 5, 1)], // overall avg 4.666…
    });

    await recomputeProductCounts(db, ['p1']);

    expect(db.products.get('p1')).toMatchObject({ ratingOverallAvg: 4.67, reviewCount: 3 });
  });

  it('writes NULL averages and zero count when a product has no approved reviews', async () => {
    const db = makeDb({
      products: [{ id: 'p1', reviewCount: 9, ratingOverallAvg: 4.5, ratingOnboardingAvg: 4.5 }],
      reviews: [{ productId: 'p1', status: 'pending', ratingOverall: 5, ratingOnboarding: 5 }],
    });

    await recomputeProductCounts(db, ['p1']);

    expect(db.products.get('p1')).toMatchObject({
      reviewCount: 0,
      ratingOverallAvg: null,
      ratingOnboardingAvg: null,
    });
  });

  it('is a no-op on an empty id set', async () => {
    const db = makeDb({ products: [{ id: 'p1' }] });
    await recomputeProductCounts(db, []);
    expect(db.updates).toHaveLength(0);
  });
});

describe('findProductCountDrift', () => {
  it('flags every stored column that disagrees with the source rows', async () => {
    const db = makeDb({
      products: [
        // Stored values are deliberately wrong: too many integrations, a stale
        // non-null average despite zero approved reviews.
        {
          id: 'p1',
          integrationCount: 5,
          reviewCount: 0,
          ratingOverallAvg: 4.5,
          ratingOnboardingAvg: null,
        },
      ],
      integrations: [{ sourceProductId: 'p1', targetProductId: 'x' }], // actual = 1
      reviews: [], // actual reviewCount = 0, averages NULL
    });

    const drift = await findProductCountDrift(db);

    expect(drift).toEqual(
      expect.arrayContaining([
        { productId: 'p1', field: 'integrationCount', stored: 5, expected: 1 },
        { productId: 'p1', field: 'ratingOverallAvg', stored: 4.5, expected: null },
      ]),
    );
    // reviewCount (0 vs 0) and ratingOnboardingAvg (null vs null) must NOT drift.
    expect(drift.map((d) => d.field)).not.toContain('reviewCount');
    expect(drift.map((d) => d.field)).not.toContain('ratingOnboardingAvg');
  });

  it('returns no drift once recomputeProductCounts has run', async () => {
    const db = makeDb({
      products: [{ id: 'p1', integrationCount: 99, reviewCount: 99, ratingOverallAvg: 1.0 }],
      integrations: [{ sourceProductId: 'p1', targetProductId: 'x' }],
      reviews: [approved('p1', 5, 4)],
    });

    expect((await findProductCountDrift(db)).length).toBeGreaterThan(0);

    await recomputeProductCounts(db, ['p1']);

    expect(await findProductCountDrift(db)).toEqual([]);
  });
});
