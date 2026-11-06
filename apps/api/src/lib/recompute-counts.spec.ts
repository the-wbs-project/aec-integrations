/**
 * Unit tests for the product-count drift RULE (`diffProductCounts`) — the single
 * definition shared by `findProductCountDrift` (live Db) and the scheduled
 * reconcile CLI (`scripts/reconcile-product-counts.ts`). Locks in the exact
 * comparison semantics: counts are exact; averages tolerate `< 0.005` (both are
 * already rounded to 2dp) and treat a null↔value transition as drift.
 */

import { and, avg, count, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECOMPUTE_PRODUCTS } from '@aeci/shared/seed-reviews';

import {
  DRIFT_QUERY,
  RECOMPUTE_SQL,
  driftQuery,
  evaluateDrift,
} from '../../scripts/reconcile-product-counts';
import {
  connectorEvidencedPairs,
  integrations,
  products,
  reviewUpdates,
  reviews,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  diffProductCounts,
  findProductCountDrift,
  recomputeProductCounts,
  type ExpectedProductCounts,
  type StoredProductCounts,
} from './recompute-counts';

const CLEAN: StoredProductCounts = {
  integrationCount: 3,
  reviewCount: 2,
  ratingOverallAvg: 4.5,
  ratingOnboardingAvg: 4.0,
};

/** Stored snapshot with `overrides` applied — the "expected" baseline matches CLEAN. */
function diff(stored: Partial<StoredProductCounts>, expected: Partial<ExpectedProductCounts> = {}) {
  return diffProductCounts('prod_1', { ...CLEAN, ...stored }, { ...CLEAN, ...expected });
}

describe('diffProductCounts', () => {
  it('returns no drift when stored matches expected exactly', () => {
    expect(diff({})).toEqual([]);
  });

  it('flags integration_count drift', () => {
    expect(diff({ integrationCount: 2 })).toEqual([
      { productId: 'prod_1', field: 'integrationCount', stored: 2, expected: 3 },
    ]);
  });

  it('flags review_count drift', () => {
    expect(diff({ reviewCount: 5 })).toEqual([
      { productId: 'prod_1', field: 'reviewCount', stored: 5, expected: 2 },
    ]);
  });

  it('reports every drifted field for one product', () => {
    const result = diff({ integrationCount: 99, reviewCount: 0 });
    expect(result.map((d) => d.field)).toEqual(['integrationCount', 'reviewCount']);
  });

  describe('average comparison', () => {
    it('treats null === null as equal', () => {
      expect(diff({ ratingOverallAvg: null }, { ratingOverallAvg: null })).toEqual([]);
    });

    it('flags null↔value transitions (stored null, expected set)', () => {
      expect(diff({ ratingOverallAvg: null }, { ratingOverallAvg: 4.5 })).toEqual([
        { productId: 'prod_1', field: 'ratingOverallAvg', stored: null, expected: 4.5 },
      ]);
    });

    it('flags value↔null transitions (stored set, expected null)', () => {
      expect(diff({ ratingOnboardingAvg: 4.0 }, { ratingOnboardingAvg: null })).toEqual([
        { productId: 'prod_1', field: 'ratingOnboardingAvg', stored: 4.0, expected: null },
      ]);
    });

    it('does NOT flag a sub-0.005 difference (rounding noise)', () => {
      expect(diff({ ratingOverallAvg: 4.5 }, { ratingOverallAvg: 4.504 })).toEqual([]);
    });

    it('flags a >=0.005 difference', () => {
      expect(diff({ ratingOverallAvg: 4.5 }, { ratingOverallAvg: 4.51 })).toEqual([
        { productId: 'prod_1', field: 'ratingOverallAvg', stored: 4.5, expected: 4.51 },
      ]);
    });
  });
});

// ─── recomputeProductCounts: the set-based UPDATE (AECI-1484) ────────────────
//
// AECI-1484 replaced three sequential round trips per product with one
// `UPDATE … WHERE id IN (…)`. `legacyExpected` is the pre-AECI-1484 per-product
// computation, kept here verbatim in behaviour (SQLite AVG, rounded in JS), so the
// new statement is pinned to it, including the averages where SQLite's own
// ROUND(x, 2) would disagree with the JS rounding.
describe('recomputeProductCounts (set-based UPDATE, AECI-1484)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const A = u(1);
  const B = u(2);
  const C = u(3);
  const CONNECTOR = u(4);
  const NO_REVIEWS = u(5);

  async function legacyExpected(productId: string): Promise<ExpectedProductCounts> {
    const integrationCount = (
      t.raw
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM integrations WHERE (source_product_id = ? OR target_product_id = ?) AND retired_at IS NULL)
           + (SELECT COUNT(*) FROM connector_evidenced_pairs
                WHERE (product_a_id = ? OR product_b_id = ? OR connector_product_id = ?) AND retired_at IS NULL) AS n`,
        )
        .get(productId, productId, productId, productId, productId) as { n: number }
    ).n;
    const [rev] = await t.db
      .select({
        value: count(),
        overall: avg(reviews.ratingOverall),
        onboarding: avg(reviews.ratingOnboarding),
      })
      .from(reviews)
      .where(and(eq(reviews.productId, productId), eq(reviews.status, 'approved')));
    const r2 = (v: string | null | undefined) =>
      v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;
    return {
      integrationCount,
      reviewCount: rev?.value ?? 0,
      ratingOverallAvg: r2(rev?.overall),
      ratingOnboardingAvg: r2(rev?.onboarding),
    };
  }

  async function stored(ids: string[]) {
    const rows = await t.db
      .select({
        id: products.id,
        integrationCount: products.integrationCount,
        reviewCount: products.reviewCount,
        ratingOverallAvg: products.ratingOverallAvg,
        ratingOnboardingAvg: products.ratingOnboardingAvg,
      })
      .from(products)
      .where(inArray(products.id, ids));
    return Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]));
  }

  function seedReviews(productId: string, ratings: [number, number, string][]): void {
    const stmt = t.raw.prepare(
      `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 't', 'b', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    ratings.forEach(([overall, onboarding, status], i) =>
      stmt.run(`${productId}-r${i}`, productId, overall, onboarding, status),
    );
  }

  async function seedFixture(): Promise<void> {
    await t.db.insert(products).values(
      [A, B, C, CONNECTOR, NO_REVIEWS].map((id, i) => ({
        id,
        slug: `p${i}`,
        name: `P${i}`,
        // Stale stored values, so a no-op would fail.
        integrationCount: 99,
        reviewCount: 99,
        ratingOverallAvg: 9,
        ratingOnboardingAvg: 9,
      })),
    );
    await t.db.insert(integrations).values([
      { id: u(21), sourceProductId: A, targetProductId: B },
      { id: u(22), sourceProductId: C, targetProductId: A },
      // Retired: counts nowhere.
      { id: u(23), sourceProductId: A, targetProductId: NO_REVIEWS, retiredAt: '2026-10-02' },
    ]);
    await t.db.insert(connectorEvidencedPairs).values({
      id: 'ep1',
      connectorProductId: CONNECTOR,
      productAId: A,
      productBId: C,
      direction: 'a_to_b',
    });
    // A: 40 approved reviews whose overall average is 107/40 = 2.675. JS rounds it
    // to 2.68; SQLite's ROUND(2.675, 2) gives 2.67. Onboarding averages to 1/3 + 2.
    const aReviews: [number, number, string][] = [];
    for (let i = 0; i < 40; i++) aReviews.push([i < 27 ? 3 : 2, i % 3 === 0 ? 3 : 2, 'approved']);
    // Not approved: excluded from every aggregate.
    aReviews.push([5, 5, 'pending'], [1, 1, 'rejected']);
    seedReviews(A, aReviews);
    seedReviews(B, [
      [5, 4, 'approved'],
      [4, 4, 'approved'],
      [4, 3, 'approved'],
    ]);
    // C has only pending reviews: count 0, both averages NULL.
    seedReviews(C, [[5, 5, 'pending']]);
  }

  it('writes exactly what the per-product computation wrote', async () => {
    await seedFixture();
    const ids = [A, B, C, CONNECTOR, NO_REVIEWS];
    const legacy = Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await legacyExpected(id)] as const)),
    );

    await recomputeProductCounts(t.db, ids);

    expect(await stored(ids)).toEqual(legacy);
    // Spelled out, so a regression shared by both computations still fails.
    expect(legacy[A]).toEqual({
      integrationCount: 3,
      reviewCount: 40,
      ratingOverallAvg: 2.68,
      ratingOnboardingAvg: 2.35,
    });
    expect(legacy[C]).toEqual({
      integrationCount: 2,
      reviewCount: 0,
      ratingOverallAvg: null,
      ratingOnboardingAvg: null,
    });
    expect(legacy[CONNECTOR]?.integrationCount).toBe(1);
    expect(legacy[NO_REVIEWS]?.integrationCount).toBe(0);
    // And the drift check, which recomputes in JS, sees nothing to repair.
    expect(await findProductCountDrift(t.db)).toEqual([]);
  });

  it('touches only the ids it is given, tolerates duplicates and unknown ids', async () => {
    await seedFixture();
    await recomputeProductCounts(t.db, [B, B, u(999)]);
    const after = await stored([A, B]);
    expect(after[B]).toEqual(await legacyExpected(B));
    // A was not named: its stale stored values stand.
    expect(after[A]?.reviewCount).toBe(99);
  });

  it('is a no-op on an empty set', async () => {
    await seedFixture();
    await recomputeProductCounts(t.db, []);
    expect((await stored([A]))[A]?.integrationCount).toBe(99);
  });

  it('covers every id when the set spans more than one chunk', async () => {
    const many = Array.from({ length: 170 }, (_, i) => u(1000 + i));
    await t.db
      .insert(products)
      .values(many.map((id, i) => ({ id, slug: `m${i}`, name: `M${i}`, reviewCount: 7 })));
    await recomputeProductCounts(t.db, many);
    const after = await stored(many);
    expect(Object.values(after).every((r) => r.reviewCount === 0)).toBe(true);
    expect(Object.keys(after)).toHaveLength(170);
  });
});

/**
 * AECI-1613: the latest approved update that carries ratings is the review's
 * rating in the averages. `review_count` never moves. Every form of the rule (the
 * Drizzle recompute, the per-product `computeExpected`, the reconcile script's raw
 * SQL and the seed's `RECOMPUTE_PRODUCTS`) must agree.
 */
describe('the latest-rating rule (AECI-1613)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const P = '00000000-0000-4000-8000-000000009001';
  const R1 = '00000000-0000-4000-8000-000000009101';
  const R2 = '00000000-0000-4000-8000-000000009102';
  const R_PENDING = '00000000-0000-4000-8000-000000009103';
  let seq = 0;

  async function seed(): Promise<void> {
    await t.db.insert(products).values({ id: P, slug: 'p', name: 'P' });
    const review = (id: string, overall: number, onboarding: number, status = 'approved') => ({
      id,
      productId: P,
      ratingOverall: overall,
      ratingOnboarding: onboarding,
      title: 'Title',
      body: 'Body',
      status,
    });
    await t.db
      .insert(reviews)
      .values([review(R1, 2, 2), review(R2, 4, 4), review(R_PENDING, 1, 1, 'pending')]);
  }

  async function update(
    reviewId: string,
    status: string,
    ratings: [number, number] | null,
    publishedAt: string | null,
  ): Promise<string> {
    seq += 1;
    const id = `00000000-0000-4000-8000-0000000092${String(seq).padStart(2, '0')}`;
    await t.db.insert(reviewUpdates).values({
      id,
      reviewId,
      body: 'An update to the review.',
      ratingOverall: ratings?.[0] ?? null,
      ratingOnboarding: ratings?.[1] ?? null,
      status,
      publishedAt,
    });
    return id;
  }

  async function storedRow() {
    const [row] = await t.db
      .select({
        reviewCount: products.reviewCount,
        overall: products.ratingOverallAvg,
        onboarding: products.ratingOnboardingAvg,
      })
      .from(products)
      .where(eq(products.id, P));
    return row!;
  }

  /** Recompute, then assert every other form of the rule reads no drift. */
  async function recomputeAndAgree() {
    await recomputeProductCounts(t.db, [P]);
    const row = await storedRow();
    expect(await findProductCountDrift(t.db)).toEqual([]);
    expect(evaluateDrift(t.raw.prepare(DRIFT_QUERY).all() as never)).toEqual([]);
    t.raw.prepare(RECOMPUTE_PRODUCTS).run();
    expect(await storedRow()).toEqual(row);
    t.raw.prepare(RECOMPUTE_SQL.replace('__IDS__', `'${P}'`)).run();
    expect(await storedRow()).toEqual(row);
    return row;
  }

  it('uses the review ratings when there is no update', async () => {
    await seed();
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 3, onboarding: 3 });
  });

  it('skips an update that carries no ratings', async () => {
    await seed();
    await update(R1, 'approved', null, '2026-11-01T00:00:00.000Z');
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 3, onboarding: 3 });
  });

  it('uses the latest approved rated update, and a later rating-less one does not undo it', async () => {
    await seed();
    await update(R1, 'approved', [3, 3], '2026-10-01T00:00:00.000Z');
    await update(R1, 'approved', [5, 4], '2026-10-02T00:00:00.000Z');
    await update(R1, 'approved', null, '2026-10-03T00:00:00.000Z');
    // R1 counts at 5/4, R2 at 4/4. The review count is still 2.
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 4.5, onboarding: 4 });
  });

  it('ignores pending, rejected and removed updates, so a removal reverts the average', async () => {
    await seed();
    const kept = await update(R1, 'approved', [3, 3], '2026-10-01T00:00:00.000Z');
    const removed = await update(R1, 'approved', [5, 5], '2026-10-02T00:00:00.000Z');
    await update(R1, 'pending', [1, 1], null);
    await update(R2, 'rejected', [1, 1], null);
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 4.5, onboarding: 4.5 });

    await t.db
      .update(reviewUpdates)
      .set({ status: 'removed', publishedAt: null })
      .where(eq(reviewUpdates.id, removed));
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 3.5, onboarding: 3.5 });

    await t.db
      .update(reviewUpdates)
      .set({ status: 'removed', publishedAt: null })
      .where(eq(reviewUpdates.id, kept));
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 3, onboarding: 3 });
  });

  it('never counts an update on a review that is not approved', async () => {
    await seed();
    await update(R_PENDING, 'approved', [5, 5], '2026-10-01T00:00:00.000Z');
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 3, onboarding: 3 });
  });

  it('breaks a published_at tie on id DESC', async () => {
    await seed();
    await update(R1, 'approved', [1, 1], '2026-10-01T00:00:00.000Z');
    await update(R1, 'approved', [4, 4], '2026-10-01T00:00:00.000Z');
    expect(await recomputeAndAgree()).toEqual({ reviewCount: 2, overall: 4, onboarding: 4 });
  });

  it('agrees with the pre-0108 reconcile query when no update exists', () => {
    // The script's table probe drops the update term on an old tier. With no updates,
    // both forms read the same numbers.
    expect(
      driftQuery({ integrations: true, evidencedPairs: true, reviewUpdates: false }),
    ).not.toMatch(/review_updates/);
    expect(DRIFT_QUERY).toMatch(/review_updates/);
  });
});
