import { describe, expect, it } from 'vitest';

import {
  isKnownLegalAgreementVersion,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  LEGAL_POLICY_DOCUMENTS,
  LEGAL_POLICY_KNOWN_VERSIONS,
  PLANS_PAGE_CURRENT_VERSION,
  PLANS_PAGE_KNOWN_VERSIONS,
  PLANS_PAGE_SHA256,
  isKnownLegalPolicyVersion,
  isKnownPlansPageVersion,
  plansPageSha256,
} from './agreements';

describe('LEGAL_AGREEMENT_KNOWN_VERSIONS (AECI-1500)', () => {
  it('ends with the current version of every agreement', () => {
    for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
      expect(LEGAL_AGREEMENT_KNOWN_VERSIONS[document].at(-1)).toBe(
        LEGAL_AGREEMENT_CURRENT_VERSIONS[document],
      );
    }
  });

  it('knows a published version and refuses one that never was', () => {
    expect(isKnownLegalAgreementVersion('managed_plan', '1.0')).toBe(true);
    expect(isKnownLegalAgreementVersion('managed_plan', '9.9')).toBe(false);
  });
});

describe('policy and Plans versions (AECI-1619)', () => {
  it('ends each policy list with its current version', () => {
    for (const policy of LEGAL_POLICY_DOCUMENTS) {
      expect(LEGAL_POLICY_KNOWN_VERSIONS[policy].at(-1)).toBe(
        LEGAL_POLICY_CURRENT_VERSIONS[policy],
      );
    }
    expect(isKnownLegalPolicyVersion('listing_accuracy', '1.0')).toBe(true);
    expect(isKnownLegalPolicyVersion('review_guidelines', '9.9')).toBe(false);
  });

  it('ends the Plans list with the current version and holds a hash for each', () => {
    expect(PLANS_PAGE_KNOWN_VERSIONS.at(-1)).toBe(PLANS_PAGE_CURRENT_VERSION);
    expect(Object.keys(PLANS_PAGE_SHA256).sort()).toEqual([...PLANS_PAGE_KNOWN_VERSIONS].sort());
    expect(isKnownPlansPageVersion(PLANS_PAGE_CURRENT_VERSION)).toBe(true);
    expect(isKnownPlansPageVersion('9.9')).toBe(false);
    expect(plansPageSha256('9.9')).toBeNull();
  });
});
