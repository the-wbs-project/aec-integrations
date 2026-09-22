import { describe, expect, it } from 'vitest';

import { algoliaSortKey, type AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { FIXTURE_PRODUCTS } from './search-relevance.fixtures';
import { rankProducts, textScore, tokenize } from './ranking-strategies';

/**
 * Plain-Vitest (node) coverage for the pure ranking strategies behind the
 * `/preview/search-relevance` harness (AECI-286). No Angular, no Algolia — the
 * strategy functions are deterministic, so ordering is asserted exactly.
 */

function rec(partial: Partial<AlgoliaProductRecord> & { name: string }): AlgoliaProductRecord {
  return {
    objectID: partial.objectID ?? `id-${partial.name.toLowerCase()}`,
    name: partial.name,
    // AECI-825 — the `name_asc` replica's sort key. Derived, never hand-written,
    // so a fixture cannot disagree with the transform about its own key.
    name_sort: partial.name_sort ?? algoliaSortKey(partial.name),
    slug: partial.slug ?? partial.name.toLowerCase(),
    description: partial.description ?? null,
    vendor_name: partial.vendor_name ?? null,
    vendor_slug: partial.vendor_slug ?? null,
    categories: partial.categories ?? [],
    audiences: partial.audiences ?? [],
    phases: partial.phases ?? [],
    trades: partial.trades ?? [],
    trade_aliases: partial.trade_aliases ?? [],
    integration_count: partial.integration_count ?? 0,
    review_count: partial.review_count ?? 0,
    rating_overall_avg: partial.rating_overall_avg ?? null,
    has_api_docs: partial.has_api_docs ?? false,
    logo_url: null,
    ...(partial.listing_tier === undefined ? {} : { listing_tier: partial.listing_tier }),
  };
}

const names = (hits: { record: AlgoliaProductRecord }[]) => hits.map((h) => h.record.name);

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric, dropping empties', () => {
    expect(tokenize('  BIM, coordination! ')).toEqual(['bim', 'coordination']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('textScore', () => {
  it('weights matches by field priority (name > vendor > taxonomy > description)', () => {
    const name = rec({ name: 'Alpha' });
    const vendor = rec({ name: 'X', vendor_name: 'Alpha' });
    const taxonomy = rec({ name: 'X', categories: ['Alpha'] });
    const description = rec({ name: 'X', description: 'an alpha tool' });

    expect(textScore('alpha', name)).toBeCloseTo(1.0);
    expect(textScore('alpha', vendor)).toBeCloseTo(0.9);
    expect(textScore('alpha', taxonomy)).toBeCloseTo(0.7);
    expect(textScore('alpha', description)).toBeCloseTo(0.4);
  });

  it('scores an empty query as 0 (browse mode)', () => {
    expect(textScore('', rec({ name: 'Alpha' }))).toBe(0);
  });
});

describe('rankProducts — candidate set', () => {
  it('keeps only text matches for a non-empty query', () => {
    const a = rec({ name: 'Revit', categories: ['BIM'] });
    const b = rec({ name: 'Smartsheet', categories: ['Scheduling'] });
    expect(names(rankProducts('bim', [a, b], 'baseline'))).toEqual(['Revit']);
    expect(rankProducts('zzz-nomatch', [a, b], 'baseline')).toHaveLength(0);
  });

  it('includes everything for an empty query (browse), ordered by listing_tier under baseline', () => {
    // integration_count is deliberately inverted against the tier: since
    // AECI-636 PR-B the baseline no longer reads it.
    const thin = rec({ name: 'Thin', integration_count: 30 });
    const full = rec({ name: 'Full', integration_count: 5, listing_tier: 2 });
    const partial = rec({ name: 'Partial', integration_count: 10, listing_tier: 1 });
    expect(names(rankProducts('', [thin, full, partial], 'baseline'))).toEqual([
      'Full',
      'Partial',
      'Thin',
    ]);
  });

  it('assigns contiguous 1-based ranks', () => {
    const hits = rankProducts(
      '',
      [rec({ name: 'A' }), rec({ name: 'B' }), rec({ name: 'C' })],
      'baseline',
    );
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3]);
  });
});

describe('rankProducts — lexicographic strategies', () => {
  const a = rec({
    name: 'A-tool',
    categories: ['BIM'],
    integration_count: 10,
    rating_overall_avg: 4.5,
  });
  const b = rec({
    name: 'B-tool',
    categories: ['BIM'],
    integration_count: 20,
    rating_overall_avg: 4.0,
  });

  it('baseline breaks a textual tie by listing_tier desc, never by integration_count', () => {
    // Equal textScore (both match "bim" in taxonomy). B has more integrations,
    // A has the more complete listing, and the listing wins (AECI-636 PR-B).
    const fuller = rec({ ...a, listing_tier: 2 });
    const thinner = rec({ ...b, listing_tier: 1 });
    expect(names(rankProducts('bim', [thinner, fuller], 'baseline'))).toEqual(['A-tool', 'B-tool']);
  });

  it('baseline falls through to review_count when the tiers tie', () => {
    const fewer = rec({ ...a, listing_tier: 2, review_count: 1 });
    const more = rec({ ...b, listing_tier: 2, review_count: 9 });
    expect(names(rankProducts('bim', [fewer, more], 'baseline'))).toEqual(['B-tool', 'A-tool']);
  });

  it('ratings-forward breaks a textual tie by rating, ahead of coverage', () => {
    const lowCoverageHighRating = rec({
      name: 'Gem',
      categories: ['BIM'],
      integration_count: 1,
      rating_overall_avg: 4.9,
    });
    const ranked = names(rankProducts('bim', [a, b, lowCoverageHighRating], 'ratings'));
    expect(ranked[0]).toBe('Gem'); // 4.9 rating wins despite the lowest coverage
  });

  it('treats a null rating as 0 under ratings-forward', () => {
    const rated = rec({
      name: 'Rated',
      categories: ['BIM'],
      integration_count: 5,
      rating_overall_avg: 3.0,
    });
    const unrated = rec({
      name: 'Unrated',
      categories: ['BIM'],
      integration_count: 5,
      rating_overall_avg: null,
    });
    expect(names(rankProducts('bim', [unrated, rated], 'ratings'))).toEqual(['Rated', 'Unrated']);
  });
});

describe('rankProducts — weighted strategies', () => {
  // Exact name match (text 1.0, low coverage) vs taxonomy-only match (text 0.7, high coverage).
  const exact = rec({ name: 'Fieldwire', integration_count: 6 });
  const heavy = rec({ name: 'Trimble', categories: ['Field Reporting'], integration_count: 50 });

  it('baseline keeps the exact text match on top', () => {
    expect(names(rankProducts('field', [exact, heavy], 'baseline'))).toEqual([
      'Fieldwire',
      'Trimble',
    ]);
  });

  it('coverage-weighted lets a heavily-integrated product override a closer text match', () => {
    expect(names(rankProducts('field', [exact, heavy], 'coverage'))).toEqual([
      'Trimble',
      'Fieldwire',
    ]);
  });

  it('blend weights change the order', () => {
    const textHeavy = names(
      rankProducts('field', [exact, heavy], 'blend', { text: 1, coverage: 0, ratings: 0 }),
    );
    const coverageHeavy = names(
      rankProducts('field', [exact, heavy], 'blend', { text: 0, coverage: 1, ratings: 0 }),
    );
    expect(textHeavy).toEqual(['Fieldwire', 'Trimble']);
    expect(coverageHeavy).toEqual(['Trimble', 'Fieldwire']);
  });
});

describe('rankProducts — over the curated fixtures', () => {
  // Before AECI-636 PR-B the baseline led with ProEst, the more-integrated tool.
  // The fixtures carry no listing_tier, so the baseline now falls through to
  // review_count and no longer rewards the integration count.
  it('"estimating": Baseline no longer leads with the most-integrated tool', () => {
    expect(rankProducts('estimating', FIXTURE_PRODUCTS, 'baseline')[0].record.slug).toBe('stack');
    expect(rankProducts('estimating', FIXTURE_PRODUCTS, 'ratings')[0].record.slug).toBe('stack');
  });

  // e2e/preview-search-relevance.spec.ts relies on this divergence: switching
  // from Baseline to Coverage-weighted must change the top row.
  it('"estimating" diverges: Baseline leads with STACK, Coverage-weighted with ProEst', () => {
    expect(rankProducts('estimating', FIXTURE_PRODUCTS, 'baseline')[0].record.slug).toBe('stack');
    expect(rankProducts('estimating', FIXTURE_PRODUCTS, 'coverage')[0].record.slug).toBe('proest');
  });
});
