import { describe, expect, it } from 'vitest';

import {
  buildPlan,
  buildSeedSql,
  ID_MARKER,
  ID_PREFIX,
  mulberry32,
  REVIEW_COLUMNS,
  reviewCells,
  Rng,
  type ProductInput,
} from './index';

const PRODUCTS: ProductInput[] = [
  { id: 'p-1', slug: 'autocad', name: 'AutoCAD', categorySlugs: ['bim-authoring', 'design'] },
  { id: 'p-2', slug: 'procore', name: 'Procore', categorySlugs: ['construction-management'] },
  { id: 'p-3', slug: 'bluebeam', name: 'Bluebeam', categorySlugs: ['docs'] },
];

function plan(seed: number) {
  return buildPlan(PRODUCTS, new Rng(mulberry32(seed)), Date.UTC(2026, 0, 1));
}

describe('seed-reviews generator', () => {
  it('is deterministic for a given seed (ids + content stable)', () => {
    const a = plan(0x5eed);
    const b = plan(0x5eed);
    expect(a.reviews.map((r) => r.id)).toEqual(b.reviews.map((r) => r.id));
    expect(a.reviews.map((r) => r.title)).toEqual(b.reviews.map((r) => r.title));
  });

  it('produces different plans for different seeds', () => {
    const a = plan(0x5eed);
    const c = plan(42);
    // Overwhelmingly likely to differ; guard against an accidental constant.
    expect(a.reviews.map((r) => r.id)).not.toEqual(c.reviews.map((r) => r.id));
  });

  it('marks every seeded id with the teardown marker + valid uuid shape', () => {
    for (const r of plan(7).reviews) {
      expect(r.id.startsWith(ID_MARKER)).toBe(true);
      expect(r.id.startsWith(ID_PREFIX)).toBe(true);
    }
  });

  it('renders the {product} token and keeps ratings in range', () => {
    for (const r of plan(7).reviews) {
      expect(r.title).not.toContain('{product}');
      expect(r.body).not.toContain('{product}');
      expect(r.ratingOverall).toBeGreaterThanOrEqual(1);
      expect(r.ratingOverall).toBeLessThanOrEqual(5);
      expect(r.ratingOnboarding).toBeGreaterThanOrEqual(1);
      expect(r.ratingOnboarding).toBeLessThanOrEqual(5);
      expect(r.reviewerId).toBeNull();
      expect(r.status).toBe('approved');
    }
  });

  it('reviewCells aligns with REVIEW_COLUMNS (count + anonymous reviewer)', () => {
    const r = plan(7).reviews[0];
    const cells = reviewCells(r);
    expect(cells).toHaveLength(REVIEW_COLUMNS.length);
    expect(cells[REVIEW_COLUMNS.indexOf('reviewer_id')]).toBeNull();
    expect(cells[REVIEW_COLUMNS.indexOf('verified_work_email')]).toBeTypeOf('number');
  });

  it('buildSeedSql wraps the plan with the idempotent delete + recompute', () => {
    const sql = buildSeedSql(plan(7), { db: 'aeci-app-staging', seed: 7 });
    expect(sql).toContain(`DELETE FROM "reviews" WHERE "id" LIKE '${ID_MARKER}%'`);
    expect(sql).toContain('INSERT INTO "reviews"');
    expect(sql).toContain('UPDATE "products" SET');
  });
});
