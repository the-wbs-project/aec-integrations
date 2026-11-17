import { describe, expect, it } from 'vitest';

import {
  HELD_REGION_COUNTRIES,
  TURNSTILE_EXCLUDED_COUNTRIES,
  isHeldRegionCountry,
} from './held-region';

describe('HELD_REGION_COUNTRIES (AECI-1581, AECI-1713)', () => {
  it('holds all 27 EU member states, the non-EU EEA, the UK and Switzerland', () => {
    const expected = [
      ...['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU'],
      ...['IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'],
      ...['IS', 'LI', 'NO', 'GB', 'CH'],
    ];
    for (const code of expected) expect(HELD_REGION_COUNTRIES.has(code)).toBe(true);
  });

  it('holds the no-location codes and the EU territories with their own code', () => {
    for (const code of ['XX', 'T1', 'AX', 'GF', 'GP', 'MF', 'MQ', 'RE', 'YT']) {
      expect(HELD_REGION_COUNTRIES.has(code)).toBe(true);
    }
  });

  it('has exactly 41 codes, each two uppercase characters', () => {
    expect(HELD_REGION_COUNTRIES.size).toBe(41);
    for (const code of HELD_REGION_COUNTRIES) expect(code).toMatch(/^[A-Z0-9]{2}$/);
  });

  it('TURNSTILE_EXCLUDED_COUNTRIES is the same set, not a copy', () => {
    expect(TURNSTILE_EXCLUDED_COUNTRIES).toBe(HELD_REGION_COUNTRIES);
  });
});

describe('isHeldRegionCountry (AECI-1713)', () => {
  it.each(['DE', 'FR', 'GB', 'CH', 'NO', 'RE', 'XX', 'T1'])('holds %s', (country) => {
    expect(isHeldRegionCountry(country)).toBe(true);
  });

  it.each([null, undefined, '', '  '])('fails closed on %j', (country) => {
    expect(isHeldRegionCountry(country)).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(isHeldRegionCountry('de')).toBe(true);
    expect(isHeldRegionCountry(' gb ')).toBe(true);
  });

  it.each(['US', 'CA', 'AU', 'ID', 'JP', 'BR', 'TR'])('does not hold %s', (country) => {
    expect(isHeldRegionCountry(country)).toBe(false);
  });
});
