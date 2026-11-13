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
} from './agreements';
import {
  isRecordableLegalAgreementVersion,
  legalAgreementVersionInForce,
  legalInForceNeedsPublished,
  legalMomentReached,
  legalPolicyVersionInForce,
  legalPublishedLiteOf,
  legalVersionsInForce,
  LEGAL_IN_FORCE_MAPS,
  type LegalInForceMaps,
} from './legal-in-force';
import { legalEffectiveAtMs } from './legal-versions';

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

describe('a policy switches by its date alone', () => {
  it('takes over exactly at its moment, with no row', () => {
    expect(legalPolicyVersionInForce('listing_accuracy', MOMENT - 1, MAPS)).toBe('1.0');
    expect(legalPolicyVersionInForce('listing_accuracy', MOMENT, MAPS)).toBe('1.1');
    expect(legalPolicyVersionInForce('review_guidelines', MOMENT, MAPS)).toBe('1.0');
  });
});

describe('legalVersionsInForce', () => {
  it('answers every document at one moment', () => {
    expect(legalVersionsInForce(PUBLISHED, MOMENT, MAPS)).toEqual({
      agreements: { vendor_terms: '1.4', managed_plan: '1.1' },
      policies: { listing_accuracy: '1.1', review_guidelines: '1.0' },
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
