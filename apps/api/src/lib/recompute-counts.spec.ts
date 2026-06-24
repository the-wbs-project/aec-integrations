/**
 * Unit tests for the product-count drift RULE (`diffProductCounts`) — the single
 * definition shared by `findProductCountDrift` (live Db) and the scheduled
 * reconcile CLI (`scripts/reconcile-product-counts.ts`). Locks in the exact
 * comparison semantics: counts are exact; averages tolerate `< 0.005` (both are
 * already rounded to 2dp) and treat a null↔value transition as drift.
 */

import { describe, expect, it } from 'vitest';

import {
  diffProductCounts,
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
