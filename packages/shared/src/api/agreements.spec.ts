import { describe, expect, it } from 'vitest';

import {
  isKnownLegalAgreementVersion,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
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

// `legal-page.component.spec.ts` (apps/web) pins this map equal to the web
// manifest. These checks hold whatever it contains.
describe('LEGAL_AGREEMENT_UPCOMING_VERSIONS (AECI-1610)', () => {
  it('names only known documents, a version never yet current, and a YYYY-MM-DD day', () => {
    for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
      const upcoming = LEGAL_AGREEMENT_UPCOMING_VERSIONS[document];
      if (!upcoming) continue;
      expect(upcoming.effectiveOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(isKnownLegalAgreementVersion(document, upcoming.version)).toBe(false);
    }
    expect(
      Object.keys(LEGAL_AGREEMENT_UPCOMING_VERSIONS).every((d) =>
        (LEGAL_AGREEMENT_DOCUMENTS as readonly string[]).includes(d),
      ),
    ).toBe(true);
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
