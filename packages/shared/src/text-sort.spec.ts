import { describe, expect, it } from 'vitest';

import { TEXT_SORT_LOCALE, compareText } from './text-sort';

/** The exact page the AECI-825 report came from: `/products?sort=name`, page 1. */
const CATALOG = [
  'ADP Workforce Now',
  'AEC Integrations',
  'AEC Stack',
  'Access Coins Evo',
  'AccuLynx',
  'Acumatica',
  'Agave AI Analytics',
  'AkitaBox',
  'Amazon Redshift',
  'eSUB',
  'iSqFt',
  'openBIM',
  'Zoho',
];

describe('compareText — the AECI-825 regression', () => {
  it('reproduces the defect a byte sort produces', () => {
    // Kept as an assertion rather than a comment: this is the "before", and if
    // JS ever stopped sorting bare strings by code unit the fix below would be
    // passing for the wrong reason.
    expect([...CATALOG].sort().slice(0, 4)).toEqual([
      'ADP Workforce Now',
      'AEC Integrations',
      'AEC Stack',
      'Access Coins Evo',
    ]);
  });

  it('puts Access before ADP — case does not decide the order', () => {
    expect([...CATALOG].sort(compareText).slice(0, 6)).toEqual([
      'Access Coins Evo',
      'AccuLynx',
      'Acumatica',
      'ADP Workforce Now',
      'AEC Integrations',
      'AEC Stack',
    ]);
  });

  it('keeps lowercase-initial brands in the alphabet, not after Z', () => {
    const sorted = [...CATALOG].sort(compareText);
    expect(sorted.indexOf('eSUB')).toBeLessThan(sorted.indexOf('iSqFt'));
    expect(sorted.indexOf('openBIM')).toBeLessThan(sorted.indexOf('Zoho'));
  });

  it('is still a TOTAL order — a case-only pair is ranked, not called equal', () => {
    // The SQL side (`COLLATE NOCASE`) reports these as equal and relies on a
    // trailing `id` tiebreaker. ICU does not, which is why an in-memory sort
    // needs no extra term.
    expect(compareText('ADP', 'adp')).not.toBe(0);
    expect(compareText('ADP', 'ADP')).toBe(0);
  });

  // The same list is ordered by D1 (`COLLATE NOCASE`) on the paginated path and by
  // this comparator on the in-memory path, so a divergence would show up as page 1
  // and page 2 disagreeing about where a product belongs. Verified against real
  // SQLite in `apps/api/src/lib/collation.spec.ts`, which sorts this exact list
  // through `ORDER BY … COLLATE NOCASE` and asserts the identical output.
  it('agrees with SQLite COLLATE NOCASE on digits, punctuation and mixed case', () => {
    const mixed = ['Bluebeam', '4D Sim', 'e-Zone', 'eBuilder', 'Sage 20', 'Sage 100', 'Zoho'];
    expect([...mixed].sort(compareText)).toEqual([
      '4D Sim',
      'Bluebeam',
      'e-Zone',
      'eBuilder',
      'Sage 100',
      'Sage 20',
      'Zoho',
    ]);
  });

  it('is NOT numeric — `Sage 100` precedes `Sage 20`, exactly as SQL orders it', () => {
    // Deliberate. SQLite has no numeric collation, and the same list is paginated
    // by D1 on one path and sorted in memory on another; they must agree.
    expect([...['Sage 20', 'Sage 100']].sort(compareText)).toEqual(['Sage 100', 'Sage 20']);
  });

  it('pins the locale rather than taking the ambient one', () => {
    expect(TEXT_SORT_LOCALE).toBe('en');
    // Same answer regardless of what the host's default locale happens to be.
    expect(compareText('Access', 'ADP')).toBe('Access'.localeCompare('ADP', TEXT_SORT_LOCALE));
  });
});
