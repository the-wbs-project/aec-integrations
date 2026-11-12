import { describe, expect, it } from 'vitest';

import {
  isKnownLegalAgreementVersion,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_EFFECTIVE_ON,
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
  portalAcceptanceLabel,
  AGREEMENT_CHECKBOX_LABELS,
} from './agreements';
import { compareLegalVersions, legalEffectiveAtMs } from './legal-versions';

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

// AECI-1677 (counsel Q42): how the API Worker knows a version is in force.
describe('LEGAL_AGREEMENT_EFFECTIVE_ON (AECI-1677)', () => {
  it('dates exactly the known versions of each agreement', () => {
    for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
      expect(Object.keys(LEGAL_AGREEMENT_EFFECTIVE_ON[document])).toEqual([
        ...LEGAL_AGREEMENT_KNOWN_VERSIONS[document],
      ]);
      for (const day of Object.values(LEGAL_AGREEMENT_EFFECTIVE_ON[document])) {
        if (day !== null) expect(Number.isNaN(legalEffectiveAtMs(day))).toBe(false);
      }
    }
  });

  // Every acceptance of these was given against a page marked "draft, not yet in force".
  // They may never count as acceptances of a version in force, so they stay null for good:
  // the effective-date change bumps to a new version instead.
  it.each([
    ['vendor_terms', ['1.0', '1.1', '1.2', '1.3']],
    ['managed_plan', ['1.0', '1.1']],
  ] as const)('keeps the draft versions of %s undated for good', (document, drafts) => {
    const map = LEGAL_AGREEMENT_EFFECTIVE_ON[document] as Record<string, string | null>;
    for (const version of drafts) {
      expect(
        map[version],
        `${document} ${version} was accepted as a draft; ship the final text as a new version number, see the legal README "Bump day"`,
      ).toBeNull();
    }
  });
});

describe('portalAcceptanceLabel (AECI-1677)', () => {
  it('is the claim box wording, naming the version and the company', () => {
    expect(portalAcceptanceLabel('vendor_terms', '1.4', 'Bentley')).toBe(
      AGREEMENT_CHECKBOX_LABELS.vendor_terms.text
        .replace('the Vendor Terms', 'the Vendor Terms, version 1.4,')
        .replace('the company named above', 'Bentley'),
    );
    expect(portalAcceptanceLabel('managed_plan', '1.2', 'Bentley')).toBe(
      'I have read and accept the Managed plan agreement, version 1.2, on behalf of Bentley.',
    );
  });
});

describe('compareLegalVersions (AECI-1677)', () => {
  it('orders by number, part by part', () => {
    expect(compareLegalVersions('1.10', '1.9')).toBe(1);
    expect(compareLegalVersions('1.9', '1.10')).toBe(-1);
    expect(compareLegalVersions('1.3', '1.3.0')).toBe(0);
    expect(compareLegalVersions('2.0', '1.99')).toBe(1);
  });
});
