import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { applySeed, applyTeardown, planFor, readProducts, summarizePlan } from './seed';
import { makeShimDb, type ShimHandle } from './test/d1';
import { seedProducts } from './test/seed-fixture';

const SEED = 0x5eed;

function count(raw: Database.Database, sql: string): number {
  return (raw.prepare(sql).get() as { n: number }).n;
}

describe('seed-reviews engine', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
    seedProducts(h.raw, 12);
  });
  afterEach(() => h.dispose());

  it('reads products with their (empty) category slugs', async () => {
    const products = await readProducts(h.db);
    expect(products).toHaveLength(12);
    expect(products[0]).toMatchObject({ slug: expect.any(String), categorySlugs: [] });
  });

  it('applies the plan: seeded rows carry the marker and recompute the aggregates', async () => {
    const products = await readProducts(h.db);
    const plan = planFor(products, SEED);
    expect(plan.reviews.length).toBeGreaterThan(0); // 12 products → non-trivial plan

    const { inserted } = await applySeed(h.db, plan);
    expect(inserted).toBe(plan.reviews.length);

    expect(count(h.raw, "SELECT count(*) AS n FROM reviews WHERE id LIKE 'aeceed00-%'")).toBe(
      plan.reviews.length,
    );
    // every seeded review is anonymous + approved
    expect(count(h.raw, 'SELECT count(*) AS n FROM reviews WHERE reviewer_id IS NOT NULL')).toBe(0);
    expect(count(h.raw, "SELECT count(*) AS n FROM reviews WHERE status <> 'approved'")).toBe(0);
    // aggregates recomputed: products with reviews have a non-null average
    expect(
      count(h.raw, 'SELECT count(*) AS n FROM products WHERE review_count > 0'),
    ).toBeGreaterThan(0);
    expect(
      count(
        h.raw,
        'SELECT count(*) AS n FROM products WHERE review_count > 0 AND rating_overall_avg IS NULL',
      ),
    ).toBe(0);
  });

  it('is idempotent: re-applying does not duplicate', async () => {
    const plan = planFor(await readProducts(h.db), SEED);
    await applySeed(h.db, plan);
    await applySeed(h.db, plan);
    expect(count(h.raw, "SELECT count(*) AS n FROM reviews WHERE id LIKE 'aeceed00-%'")).toBe(
      plan.reviews.length,
    );
  });

  it('teardown removes exactly the seeded rows and resets aggregates', async () => {
    const plan = planFor(await readProducts(h.db), SEED);
    await applySeed(h.db, plan);
    // a NON-seeded review must survive teardown
    h.raw
      .prepare(
        `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, status, created_at, updated_at)
         VALUES ('keep-1', 'prod-1', 4, 4, 'Real', 'Real review body text.', 'approved', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    await applyTeardown(h.db);

    expect(count(h.raw, "SELECT count(*) AS n FROM reviews WHERE id LIKE 'aeceed00-%'")).toBe(0);
    expect(count(h.raw, "SELECT count(*) AS n FROM reviews WHERE id = 'keep-1'")).toBe(1);
    // prod-1 keeps its one real review in the recompute; others reset to 0
    expect(
      (
        h.raw.prepare("SELECT review_count AS n FROM products WHERE id = 'prod-1'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('summarizePlan returns histogram + samples for the dry-run', async () => {
    const products = await readProducts(h.db);
    const summary = summarizePlan(planFor(products, SEED), products);
    expect(summary.products).toBe(12);
    expect(summary.ratingHistogram.reduce((s, r) => s + r.count, 0)).toBe(summary.totalReviews);
    expect(summary.samples.length).toBeGreaterThan(0);
  });
});
