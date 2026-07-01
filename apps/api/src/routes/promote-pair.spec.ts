/**
 * `promote-pair.ts` (AECI-297) — the single alphabetical primitive both promote
 * derivers share for the Stage 1.5 pair page. Pure; asserts the canonical ordering
 * (context = alphabetically-first slug) is stable regardless of argument order.
 */

import { describe, expect, it } from 'vitest';

import { pairCacheTag, sortedPairSlugs } from './promote-pair';

describe('sortedPairSlugs', () => {
  it('returns [context, other] with the alphabetically-first slug as context', () => {
    expect(sortedPairSlugs('revit', 'navisworks')).toEqual(['navisworks', 'revit']);
  });

  it('is order-independent', () => {
    expect(sortedPairSlugs('navisworks', 'revit')).toEqual(sortedPairSlugs('revit', 'navisworks'));
  });
});

describe('pairCacheTag', () => {
  it('formats as pair:{min}__{max}, order-independent', () => {
    expect(pairCacheTag('revit', 'navisworks')).toBe('pair:navisworks__revit');
    expect(pairCacheTag('navisworks', 'revit')).toBe('pair:navisworks__revit');
  });
});
