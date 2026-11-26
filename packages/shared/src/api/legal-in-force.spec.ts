/**
 * AECI-1689: the one rule for the version in force (`legal-in-force.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  LEGAL_POLICY_UPCOMING_VERSIONS,
  LEGAL_READER_CURRENT_VERSIONS,
  LEGAL_READER_UPCOMING_VERSIONS,
} from './agreements';
import {
  isRecordableLegalAgreementVersion,
  legalAgreementVersionInForce,
  legalInForceNeedsPublished,
  legalMomentReached,
  legalNoticeIsFirstInForce,
  legalPolicyVersionInForce,
  legalNextEffectiveMomentMs,
  legalPublishableUpcoming,
  legalPublishedLiteOf,
  legalPublishedRowMismatched,
  legalReaderVersionInForce,
  legalVersionsInForce,
  LEGAL_IN_FORCE_MAPS,
  type LegalInForceMaps,
} from './legal-in-force';
import { legalEffectiveAtMs } from './legal-moment';

const DAY = '2027-03-31';
const MOMENT = legalEffectiveAtMs(DAY);

const MAPS: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: { vendor_terms: { version: '1.4', effectiveOn: DAY } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: { listing_accuracy: { version: '1.1', effectiveOn: DAY } },
};

const PUBLISHED = [{ document: 'vendor_terms', version: '1.4', effectiveAt: MOMENT }];

describe('legalMomentReached', () => {
  it('is in force AT the moment, not a millisecond before', () => {
    expect(legalMomentReached(MOMENT, MOMENT - 1)).toBe(false);
    expect(legalMomentReached(MOMENT, MOMENT)).toBe(true);
  });

  it('a non-finite moment never comes', () => {
    expect(legalMomentReached(Number.NaN, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("today's data: every answer is the build's current version", () => {
  it('has no upcoming entry, so no read is ever needed', () => {
    expect(LEGAL_AGREEMENT_UPCOMING_VERSIONS).toEqual({});
    expect(LEGAL_POLICY_UPCOMING_VERSIONS).toEqual({});
    for (const now of [0, Date.parse('2026-11-12T00:00:00Z'), Date.parse('2099-01-01T00:00:00Z')]) {
      expect(legalInForceNeedsPublished(now)).toBe(false);
      expect(legalVersionsInForce([], now)).toEqual({
        agreements: LEGAL_AGREEMENT_CURRENT_VERSIONS,
        policies: LEGAL_POLICY_CURRENT_VERSIONS,
      });
    }
  });

  it('a stray row changes nothing while no upcoming entry names it', () => {
    const stray = [{ document: 'vendor_terms', version: '9.9', effectiveAt: 0 }];
    for (const d of LEGAL_AGREEMENT_DOCUMENTS) {
      expect(legalAgreementVersionInForce(d, stray, Date.now())).toBe(
        LEGAL_AGREEMENT_CURRENT_VERSIONS[d],
      );
    }
  });

  it('the default maps are the shared constants', () => {
    expect(LEGAL_IN_FORCE_MAPS.agreementCurrent).toBe(LEGAL_AGREEMENT_CURRENT_VERSIONS);
    expect(LEGAL_IN_FORCE_MAPS.policyCurrent).toBe(LEGAL_POLICY_CURRENT_VERSIONS);
  });
});

describe('an agreement switches only when published', () => {
  it('a published version takes over exactly at its moment', () => {
    expect(legalAgreementVersionInForce('vendor_terms', PUBLISHED, MOMENT - 1, MAPS)).toBe('1.3');
    expect(legalAgreementVersionInForce('vendor_terms', PUBLISHED, MOMENT, MAPS)).toBe('1.4');
  });

  it('an unpublished upcoming version never switches, at any moment', () => {
    for (const now of [MOMENT - 1, MOMENT, MOMENT + 365 * 86_400_000]) {
      expect(legalAgreementVersionInForce('vendor_terms', [], now, MAPS)).toBe('1.3');
    }
  });

  it('a row for another document or version does not count', () => {
    const others = [
      { document: 'managed_plan', version: '1.4', effectiveAt: MOMENT },
      { document: 'vendor_terms', version: '1.5', effectiveAt: MOMENT },
    ];
    expect(legalAgreementVersionInForce('vendor_terms', others, MOMENT, MAPS)).toBe('1.3');
  });

  it('a row whose moment is not the manifest moment does not switch (fail safe)', () => {
    const moved = [{ document: 'vendor_terms', version: '1.4', effectiveAt: MOMENT - 86_400_000 }];
    expect(legalAgreementVersionInForce('vendor_terms', moved, MOMENT, MAPS)).toBe('1.3');
  });

  it('an agreement with no upcoming entry stays on its build version', () => {
    expect(legalAgreementVersionInForce('managed_plan', PUBLISHED, MOMENT, MAPS)).toBe('1.1');
  });

  it('needs the published read only once an upcoming agreement moment has come', () => {
    expect(legalInForceNeedsPublished(MOMENT - 1, MAPS)).toBe(false);
    expect(legalInForceNeedsPublished(MOMENT, MAPS)).toBe(true);
  });
});

// AECI-1969, ruling 54 (counsel Q68): a policy switches like an agreement, only once a
// `legal_versions` row published it, which emailed every claimed company.
describe('a policy switches only when published', () => {
  const POLICY_ROW = [{ document: 'listing_accuracy', version: '1.1', effectiveAt: MOMENT }];

  it('a published version takes over exactly at its moment', () => {
    expect(legalPolicyVersionInForce('listing_accuracy', POLICY_ROW, MOMENT - 1, MAPS)).toBe('1.0');
    expect(legalPolicyVersionInForce('listing_accuracy', POLICY_ROW, MOMENT, MAPS)).toBe('1.1');
    expect(legalPolicyVersionInForce('review_guidelines', POLICY_ROW, MOMENT, MAPS)).toBe('1.0');
  });

  it('with no row it never switches, whatever the date', () => {
    for (const now of [MOMENT, MOMENT + 365 * 86_400_000]) {
      expect(legalPolicyVersionInForce('listing_accuracy', [], now, MAPS)).toBe('1.0');
    }
  });

  it('a row for the other policy, or a moved date, does not count', () => {
    const other = [{ document: 'review_guidelines', version: '1.1', effectiveAt: MOMENT }];
    expect(legalPolicyVersionInForce('listing_accuracy', other, MOMENT, MAPS)).toBe('1.0');
    const moved = [
      { document: 'listing_accuracy', version: '1.1', effectiveAt: MOMENT + 86_400_000 },
    ];
    expect(legalPolicyVersionInForce('listing_accuracy', moved, MOMENT + 86_400_000, MAPS)).toBe(
      '1.0',
    );
    expect(legalPublishedRowMismatched(moved[0]!, MAPS)).toBe(true);
  });

  it('a policy moment makes the published read needed', () => {
    const only: LegalInForceMaps = { ...MAPS, agreementUpcoming: {} };
    expect(legalInForceNeedsPublished(MOMENT - 1, only)).toBe(false);
    expect(legalInForceNeedsPublished(MOMENT, only)).toBe(true);
  });
});

// AECI-1637, ruling 2 of 2026-11-13: the Terms and the Privacy Policy switch like the
// agreements, only once a `legal_versions` row published the version.
describe('a reader document switches only when published', () => {
  const READER_MAPS: LegalInForceMaps = {
    ...MAPS,
    readerCurrent: { terms: '1.1', privacy: '1.1' },
    readerUpcoming: { terms: { version: '1.2', effectiveOn: DAY } },
  };
  const TERMS_ROW = [{ document: 'terms', version: '1.2', effectiveAt: MOMENT }];

  it("today's data: no reader entry, every answer is the build version", () => {
    expect(LEGAL_READER_UPCOMING_VERSIONS).toEqual({});
    expect(LEGAL_IN_FORCE_MAPS.readerCurrent).toBe(LEGAL_READER_CURRENT_VERSIONS);
    for (const now of [0, Date.parse('2099-01-01T00:00:00Z')]) {
      expect(legalReaderVersionInForce('terms', TERMS_ROW, now)).toBe('1.1');
      expect(legalReaderVersionInForce('privacy', [], now)).toBe('1.1');
    }
  });

  it('a published version takes over exactly at its moment', () => {
    expect(legalReaderVersionInForce('terms', TERMS_ROW, MOMENT - 1, READER_MAPS)).toBe('1.1');
    expect(legalReaderVersionInForce('terms', TERMS_ROW, MOMENT, READER_MAPS)).toBe('1.2');
  });

  it('with no row it never switches, whatever the date', () => {
    for (const now of [MOMENT, MOMENT + 365 * 86_400_000]) {
      expect(legalReaderVersionInForce('terms', [], now, READER_MAPS)).toBe('1.1');
    }
  });

  it('a row for the other reader document, or a moved date, does not count', () => {
    const privacy = [{ document: 'privacy', version: '1.2', effectiveAt: MOMENT }];
    expect(legalReaderVersionInForce('terms', privacy, MOMENT, READER_MAPS)).toBe('1.1');
    const moved = [{ document: 'terms', version: '1.2', effectiveAt: MOMENT + 86_400_000 }];
    expect(legalReaderVersionInForce('terms', moved, MOMENT + 86_400_000, READER_MAPS)).toBe('1.1');
    expect(legalPublishedRowMismatched(moved[0]!, READER_MAPS)).toBe(true);
    expect(legalPublishedRowMismatched(TERMS_ROW[0]!, READER_MAPS)).toBe(false);
  });

  it('a reader moment makes the published read needed, and is the next moment', () => {
    const only: LegalInForceMaps = { ...READER_MAPS, agreementUpcoming: {}, policyUpcoming: {} };
    expect(legalInForceNeedsPublished(MOMENT - 1, only)).toBe(false);
    expect(legalInForceNeedsPublished(MOMENT, only)).toBe(true);
    expect(legalNextEffectiveMomentMs(MOMENT - 1, only)).toBe(MOMENT);
  });

  it('lists the publishable upcoming entries, agreements first, policies last', () => {
    expect(legalPublishableUpcoming(READER_MAPS).map((e) => e.document)).toEqual([
      'vendor_terms',
      'terms',
      'listing_accuracy',
    ]);
  });
});

describe('legalVersionsInForce', () => {
  it('answers every document at one moment', () => {
    expect(legalVersionsInForce(PUBLISHED, MOMENT, MAPS)).toEqual({
      agreements: { vendor_terms: '1.4', managed_plan: '1.1' },
      policies: { listing_accuracy: '1.0', review_guidelines: '1.0' },
    });
    const withPolicy = [
      ...PUBLISHED,
      { document: 'listing_accuracy', version: '1.1', effectiveAt: MOMENT },
    ];
    expect(legalVersionsInForce(withPolicy, MOMENT, MAPS).policies).toEqual({
      listing_accuracy: '1.1',
      review_guidelines: '1.0',
    });
  });
});

describe('legalPublishedLiteOf', () => {
  it('reads the ISO moment back to the epoch ms the rule compares', () => {
    const rows = legalPublishedLiteOf([
      { document: 'vendor_terms', version: '1.4', effective_at: new Date(MOMENT).toISOString() },
    ]);
    expect(rows).toEqual(PUBLISHED);
    expect(legalAgreementVersionInForce('vendor_terms', rows, MOMENT, MAPS)).toBe('1.4');
  });
});

describe('isRecordableLegalAgreementVersion', () => {
  it('accepts a known version and the upcoming one, and nothing else', () => {
    expect(isRecordableLegalAgreementVersion('vendor_terms', '1.2', MAPS)).toBe(true);
    expect(isRecordableLegalAgreementVersion('vendor_terms', '1.4', MAPS)).toBe(true);
    expect(isRecordableLegalAgreementVersion('vendor_terms', '1.5', MAPS)).toBe(false);
    expect(isRecordableLegalAgreementVersion('managed_plan', '1.4', MAPS)).toBe(false);
  });
});

// AECI-2234: the change notice of a first in-force version names no current or earlier one.
describe('legalNoticeIsFirstInForce', () => {
  const EARLIER = MOMENT - 365 * 86_400_000;

  it("today's data: every publishable document's next version is its first", () => {
    for (const document of [
      'vendor_terms',
      'managed_plan',
      'terms',
      'privacy',
      'listing_accuracy',
      'review_guidelines',
    ] as const) {
      expect(legalNoticeIsFirstInForce(document, '9.9', [], MOMENT - 1)).toBe(true);
    }
  });

  it('this row alone, or rows of another document, keep it first', () => {
    const rows = [...PUBLISHED, { document: 'managed_plan', version: '1.1', effectiveAt: EARLIER }];
    expect(legalNoticeIsFirstInForce('vendor_terms', '1.4', rows, MOMENT - 1, MAPS)).toBe(true);
  });

  it('an earlier row already in force makes it not first', () => {
    const rows = [...PUBLISHED, { document: 'vendor_terms', version: '1.3', effectiveAt: EARLIER }];
    expect(legalNoticeIsFirstInForce('vendor_terms', '1.4', rows, MOMENT - 1, MAPS)).toBe(false);
    expect(legalNoticeIsFirstInForce('vendor_terms', '1.4', rows, EARLIER - 1, MAPS)).toBe(true);
  });

  it('a policy is judged on its rows alone', () => {
    const rows = [{ document: 'listing_accuracy', version: '1.0', effectiveAt: EARLIER }];
    expect(legalNoticeIsFirstInForce('listing_accuracy', '1.1', rows, MOMENT - 1, MAPS)).toBe(
      false,
    );
    expect(legalNoticeIsFirstInForce('listing_accuracy', '1.1', [], MOMENT - 1, MAPS)).toBe(true);
  });

  it('a mismatched row is in force nowhere, so it does not count', () => {
    const moved = [{ document: 'vendor_terms', version: '1.4', effectiveAt: EARLIER }];
    expect(legalNoticeIsFirstInForce('vendor_terms', '1.5', moved, MOMENT, MAPS)).toBe(true);
  });

  it('a dated build current version makes it not first', () => {
    const dated: LegalInForceMaps = {
      ...MAPS,
      agreementEffectiveOn: {
        vendor_terms: { '1.3': '2026-12-31' },
        managed_plan: { '1.1': null },
      },
      readerCurrent: { terms: '1.1', privacy: '1.1' },
      readerEffectiveOn: { terms: { '1.1': '2026-12-31' }, privacy: { '1.1': null } },
    };
    expect(legalNoticeIsFirstInForce('vendor_terms', '1.4', [], MOMENT - 1, dated)).toBe(false);
    expect(legalNoticeIsFirstInForce('managed_plan', '1.2', [], MOMENT - 1, dated)).toBe(true);
    expect(legalNoticeIsFirstInForce('terms', '1.2', [], MOMENT - 1, dated)).toBe(false);
    expect(legalNoticeIsFirstInForce('privacy', '1.2', [], MOMENT - 1, dated)).toBe(true);
  });
});
