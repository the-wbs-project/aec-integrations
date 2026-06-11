import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { byDisplayOrder, topByCount } from './taxonomy-rank';

function term(slug: string, productCount: number, displayOrder = 0): TaxonomyTermWithCount {
  return {
    id: slug,
    slug,
    name: slug.toUpperCase(),
    description: null,
    display_order: displayOrder,
    product_count: productCount,
  };
}

describe('topByCount', () => {
  it('returns an empty array for undefined input', () => {
    expect(topByCount(undefined, 10)).toEqual([]);
  });

  it('sorts by product_count descending', () => {
    const out = topByCount([term('a', 1), term('b', 5), term('c', 3)], 10);
    expect(out.map((t) => t.slug)).toEqual(['b', 'c', 'a']);
  });

  it('caps the result at n', () => {
    const out = topByCount([term('a', 1), term('b', 5), term('c', 3), term('d', 4)], 2);
    expect(out.map((t) => t.slug)).toEqual(['b', 'd']);
  });

  it('keeps every term when n is Infinity (phases)', () => {
    const out = topByCount([term('a', 1), term('b', 5), term('c', 3)], Infinity);
    expect(out.map((t) => t.slug)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [term('a', 1), term('b', 5)];
    topByCount(input, 10);
    expect(input.map((t) => t.slug)).toEqual(['a', 'b']);
  });
});

describe('byDisplayOrder', () => {
  it('returns an empty array for undefined input', () => {
    expect(byDisplayOrder(undefined)).toEqual([]);
  });

  it('sorts by display_order ascending, independent of product_count', () => {
    // High-count term has the latest display_order — count must not win.
    const out = byDisplayOrder([
      term('closeout', 99, 50),
      term('design', 1, 20),
      term('concept', 3, 10),
    ]);
    expect(out.map((t) => t.slug)).toEqual(['concept', 'design', 'closeout']);
  });

  it('breaks display_order ties by name', () => {
    const out = byDisplayOrder([term('zeta', 1, 10), term('alpha', 1, 10)]);
    expect(out.map((t) => t.slug)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const input = [term('b', 1, 20), term('a', 1, 10)];
    byDisplayOrder(input);
    expect(input.map((t) => t.slug)).toEqual(['b', 'a']);
  });
});
