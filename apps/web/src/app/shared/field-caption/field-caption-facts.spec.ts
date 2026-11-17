import { describe, expect, it } from 'vitest';

import { correctionsInSlots, countUnderReview, isUnderReview } from './field-caption-facts';

const correction = (field: string, cleared = false) => ({
  field,
  date: '2026-09-15T00:00:00.000Z',
  source_url: null,
  cleared,
});

describe('correctionsInSlots (AECI-1666, §4.5.8)', () => {
  it('lists a correction while its value shows, and a removal while the slot is empty', () => {
    const picked = correctionsInSlots(
      [correction('website'), correction('docs_url', true), correction('maturity')],
      { website: true, docs_url: false, maturity: false },
    );
    expect(picked.map((c) => c.field)).toEqual(['website', 'docs_url']);
  });

  it('drops a removal whose slot holds a value again', () => {
    expect(correctionsInSlots([correction('website', true)], { website: true })).toEqual([]);
  });

  it('drops a field the page has no slot for', () => {
    expect(correctionsInSlots([correction('phone_number')], { website: true })).toEqual([]);
    expect(correctionsInSlots([correction('toString')], {})).toEqual([]);
  });

  it('tolerates an absent list', () => {
    expect(correctionsInSlots(undefined, { website: true })).toEqual([]);
  });
});

describe('countUnderReview (AECI-1666)', () => {
  it('counts only the fields the page marks', () => {
    expect(
      countUnderReview(['website', 'phone_number', 'description'], ['website', 'description']),
    ).toBe(2);
    expect(countUnderReview(null, ['website'])).toBe(0);
  });
});

describe('isUnderReview (AECI-1238)', () => {
  it('finds a hidden field', () => {
    expect(isUnderReview(['description', 'website'], 'website')).toBe(true);
    expect(isUnderReview(['description'], 'website')).toBe(false);
  });

  it('tolerates an absent list from an older API', () => {
    expect(isUnderReview(undefined, 'website')).toBe(false);
    expect(isUnderReview(null, 'website')).toBe(false);
  });
});
