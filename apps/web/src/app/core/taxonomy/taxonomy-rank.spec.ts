import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { topByCount } from './taxonomy-rank';

function term(slug: string, productCount: number): TaxonomyTermWithCount {
  return {
    id: slug,
    slug,
    name: slug.toUpperCase(),
    description: null,
    display_order: 0,
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
