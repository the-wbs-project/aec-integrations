import { describe, expect, it } from 'vitest';

import {
  correctionFor,
  publicCompanyFact,
  scalarCorrectionHolds,
  type StoredCorrection,
} from './company-facts-display';

const AT = '2026-11-01T00:00:00.000Z';
const none = { sourceUrl: null, checkedAt: null, ownedAt: null };

describe('publicCompanyFact, the §6.23 display rule (AECI-1635)', () => {
  it('shows nothing for a null value', () => {
    expect(publicCompanyFact(null, { ...none, sourceUrl: 'https://a.example' })).toBeNull();
  });

  it('hides an unsourced value on a vendor that does not own its record', () => {
    expect(publicCompanyFact('Denver, CO', none)).toBeNull();
    expect(publicCompanyFact(2001, none)).toBeNull();
  });

  it('shows a sourced value, the value an owned vendor set, and a corrected value', () => {
    expect(publicCompanyFact('Denver', { ...none, sourceUrl: 'https://a.example' })).toBe('Denver');
    expect(publicCompanyFact(2001, { ...none, ownedAt: AT })).toBe(2001);
    expect(
      publicCompanyFact('Denver', {
        ...none,
        correction: { field: 'headquarters', date: AT, source_url: null, cleared: false },
      }),
    ).toBe('Denver');
  });

  it('treats a non-http source as no source', () => {
    expect(publicCompanyFact('Denver', { ...none, sourceUrl: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('correctionFor', () => {
  const row = (over: Partial<StoredCorrection>): StoredCorrection => ({
    id: 'a',
    field: 'headquarters',
    value: 'Boston, MA',
    sourceUrl: 'https://registry.example',
    setAt: AT,
    ...over,
  });

  it('returns the correction while its value is the live value', () => {
    expect(correctionFor([row({})], 'headquarters', 'Boston, MA')).toEqual({
      field: 'headquarters',
      date: AT,
      source_url: 'https://registry.example',
      cleared: false,
    });
  });

  it('drops it once the value moved on, and ignores other fields', () => {
    expect(correctionFor([row({})], 'headquarters', 'Moved')).toBeUndefined();
    expect(correctionFor([row({})], 'founded_year', 'Boston, MA')).toBeUndefined();
  });

  it('reads only the newest row for a field', () => {
    const rows = [
      row({ id: 'b', value: 'Old', setAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'a', value: 'Boston, MA' }),
    ];
    expect(correctionFor(rows, 'headquarters', 'Old')).toBeUndefined();
    expect(correctionFor(rows, 'headquarters', 'Boston, MA')?.date).toBe(AT);
  });

  it('compares numbers strictly and never holds an array', () => {
    expect(scalarCorrectionHolds(2001, 2001)).toBe(true);
    expect(scalarCorrectionHolds('2001', 2001)).toBe(false);
    expect(scalarCorrectionHolds(['a'], 'a')).toBe(false);
    expect(scalarCorrectionHolds(null, undefined)).toBe(true);
  });
});
