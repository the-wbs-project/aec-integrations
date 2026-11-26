/**
 * AECI-1870: which documents' first in-force version took effect at a moment
 * (`legal-first-effective.ts`). The day-of notice sends one email per moment from it.
 */
import { describe, expect, it } from 'vitest';

import {
  isLegalFirstInForceVersion,
  legalFirstInForceAt,
  legalFirstInForceMoments,
} from './legal-first-effective';
import type { LegalInForceMaps, LegalPublishedLite } from './legal-in-force';
import { legalEffectiveAtMs } from './legal-moment';

const DAY = '2027-01-15';
const MOMENT = legalEffectiveAtMs(DAY);
const LATER_DAY = '2027-06-01';
const LATER = legalEffectiveAtMs(LATER_DAY);

/** Today's drafts, with a first in-force version of four documents upcoming on DAY. */
const MAPS: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: {
    vendor_terms: { version: '1.4', effectiveOn: DAY },
    managed_plan: { version: '1.2', effectiveOn: DAY },
  },
  agreementEffectiveOn: {
    vendor_terms: { '1.0': null, '1.1': null, '1.2': null, '1.3': null },
    managed_plan: { '1.0': null, '1.1': null },
  },
  readerCurrent: { terms: '1.1', privacy: '1.1' },
  readerUpcoming: { terms: { version: '1.2', effectiveOn: DAY } },
  readerEffectiveOn: { terms: { '1.0': null, '1.1': null }, privacy: { '1.0': null, '1.1': null } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: { listing_accuracy: { version: '1.1', effectiveOn: DAY } },
};

const row = (document: string, version: string, effectiveAt = MOMENT): LegalPublishedLite => ({
  document,
  version,
  effectiveAt,
});

const FIRST = [
  row('vendor_terms', '1.4'),
  row('managed_plan', '1.2'),
  row('terms', '1.2'),
  row('listing_accuracy', '1.1'),
];

describe('isLegalFirstInForceVersion', () => {
  it('counts a published upcoming version of a document never in force', () => {
    for (const r of FIRST)
      expect(isLegalFirstInForceVersion(r, FIRST, MAPS), r.document).toBe(true);
  });

  it('does not count a later version: an earlier published row was in force', () => {
    const later = row('terms', '1.3', LATER);
    const maps: LegalInForceMaps = {
      ...MAPS,
      readerUpcoming: { terms: { version: '1.3', effectiveOn: LATER_DAY } },
      readerEffectiveOn: {
        terms: { '1.0': null, '1.1': null, '1.2': DAY },
        privacy: { '1.0': null, '1.1': null },
      },
      readerCurrent: { terms: '1.2', privacy: '1.1' },
    };
    expect(isLegalFirstInForceVersion(later, [...FIRST, later], maps)).toBe(false);
  });

  it('does not count a later version when only the committed map dates the earlier one', () => {
    const later = row('vendor_terms', '1.5', LATER);
    const maps: LegalInForceMaps = {
      ...MAPS,
      agreementCurrent: { vendor_terms: '1.4', managed_plan: '1.1' },
      agreementUpcoming: { vendor_terms: { version: '1.5', effectiveOn: LATER_DAY } },
      agreementEffectiveOn: {
        vendor_terms: { '1.0': null, '1.1': null, '1.2': null, '1.3': null, '1.4': DAY },
        managed_plan: { '1.0': null, '1.1': null },
      },
    };
    expect(isLegalFirstInForceVersion(later, [later], maps)).toBe(false);
  });

  it('still counts the first version after bump day dated it in the committed map', () => {
    const maps: LegalInForceMaps = {
      ...MAPS,
      agreementCurrent: { vendor_terms: '1.4', managed_plan: '1.1' },
      agreementUpcoming: {},
      agreementEffectiveOn: {
        vendor_terms: { '1.0': null, '1.1': null, '1.2': null, '1.3': null, '1.4': DAY },
        managed_plan: { '1.0': null, '1.1': null },
      },
    };
    expect(isLegalFirstInForceVersion(row('vendor_terms', '1.4'), FIRST, maps)).toBe(true);
  });

  it('never counts a draft, even with a row', () => {
    // 1.3 is pinned null: every acceptance of it was given against a draft.
    expect(isLegalFirstInForceVersion(row('vendor_terms', '1.3'), FIRST, MAPS)).toBe(false);
    expect(isLegalFirstInForceVersion(row('privacy', '1.1'), FIRST, MAPS)).toBe(false);
  });

  it('never counts a row whose date moved after the publish', () => {
    const moved = row('vendor_terms', '1.4', MOMENT + 86_400_000);
    expect(isLegalFirstInForceVersion(moved, [moved], MAPS)).toBe(false);
  });

  it('never counts a version with no upcoming entry and no committed day', () => {
    expect(isLegalFirstInForceVersion(row('privacy', '1.2'), FIRST, MAPS)).toBe(false);
    expect(isLegalFirstInForceVersion(row('review_guidelines', '1.1'), FIRST, MAPS)).toBe(false);
  });
});

describe('legalFirstInForceAt', () => {
  it('groups every first version taking effect at that moment, and nothing else', () => {
    const later = row('privacy', '1.2', LATER);
    const maps: LegalInForceMaps = {
      ...MAPS,
      readerUpcoming: {
        terms: { version: '1.2', effectiveOn: DAY },
        privacy: { version: '1.2', effectiveOn: LATER_DAY },
      },
    };
    const published = [...FIRST, later];
    expect(legalFirstInForceAt(published, MOMENT, maps)).toEqual(FIRST);
    expect(legalFirstInForceAt(published, LATER, maps)).toEqual([later]);
    expect(legalFirstInForceAt(published, MOMENT + 1, maps)).toEqual([]);
  });

  it('carries extra fields through', () => {
    const withId = FIRST.map((r, i) => ({ ...r, id: `lv-${i}` }));
    expect(legalFirstInForceAt(withId, MOMENT, MAPS).map((r) => r.id)).toEqual([
      'lv-0',
      'lv-1',
      'lv-2',
      'lv-3',
    ]);
  });
});

describe('legalFirstInForceMoments', () => {
  it('is empty before the moment, and lists it from the moment', () => {
    expect(legalFirstInForceMoments(FIRST, { sinceMs: 0, nowMs: MOMENT - 1 }, MAPS)).toEqual([]);
    expect(legalFirstInForceMoments(FIRST, { sinceMs: 0, nowMs: MOMENT }, MAPS)).toEqual([
      { effectiveAtMs: MOMENT, rows: FIRST },
    ]);
  });

  it('leaves out a moment at or before sinceMs', () => {
    expect(legalFirstInForceMoments(FIRST, { sinceMs: MOMENT, nowMs: LATER }, MAPS)).toEqual([]);
  });

  it('lists two moments oldest first', () => {
    const later = row('privacy', '1.2', LATER);
    const maps: LegalInForceMaps = {
      ...MAPS,
      readerUpcoming: {
        terms: { version: '1.2', effectiveOn: DAY },
        privacy: { version: '1.2', effectiveOn: LATER_DAY },
      },
    };
    const moments = legalFirstInForceMoments([later, ...FIRST], { sinceMs: 0, nowMs: LATER }, maps);
    expect(moments.map((m) => [m.effectiveAtMs, m.rows.length])).toEqual([
      [MOMENT, 4],
      [LATER, 1],
    ]);
  });

  it('finds nothing in the committed data today: every version is a draft', () => {
    expect(
      legalFirstInForceMoments([row('vendor_terms', '1.3'), row('terms', '1.1')], {
        sinceMs: 0,
        nowMs: Date.parse('2099-01-01T00:00:00Z'),
      }),
    ).toEqual([]);
  });
});
