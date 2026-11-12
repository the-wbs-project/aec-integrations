import { describe, expect, it } from 'vitest';

import { countryName, ISO_COUNTRY_CODES, isIsoCountryCode } from './countries';

describe('ISO_COUNTRY_CODES (AECI-1705)', () => {
  it('holds the 249 assigned alpha-2 codes, sorted and unique', () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    expect([...ISO_COUNTRY_CODES].sort()).toEqual([...ISO_COUNTRY_CODES]);
    for (const code of ISO_COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('knows assigned codes only', () => {
    expect(isIsoCountryCode('US')).toBe(true);
    expect(isIsoCountryCode('us')).toBe(false);
    expect(isIsoCountryCode('UK')).toBe(false);
    expect(isIsoCountryCode('EU')).toBe(false);
  });

  it('names a code in the locale, and falls back to the code', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('DE', 'de')).toBe('Deutschland');
    expect(countryName('not a code')).toBe('not a code');
  });

  it('has a runtime name for every code', () => {
    for (const code of ISO_COUNTRY_CODES) expect(countryName(code)).not.toBe(code);
  });
});
