/**
 * AECI-1689: bump day is cleanup, on the API side. Once a published upcoming Vendor Terms
 * version's moment has come, every API answer must already be what the bump-day change
 * (current version bumped, `LEGAL_AGREEMENT_KNOWN_VERSIONS` appended,
 * `LEGAL_AGREEMENT_EFFECTIVE_ON` dated, upcoming entry removed) will give. The web half,
 * the pages and the noindex set, is `apps/web/src/app/legal/legal-bump-equivalence.spec.ts`.
 *
 * The `legal_versions` row stays after the bump: rows are never deleted.
 */
import {
  isRecordableLegalAgreementVersion,
  legalEffectiveAtMs,
  legalVersionsInForce,
  type LegalInForceMaps,
} from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  effectiveAtMsOf,
  finalVersions,
  inForceVersions,
  pendingAcceptances,
  requiredVendorTermsVersion,
  type PublishedVersionLite,
} from './legal-acceptance';

const DAY = '2027-03-31';
const MOMENT = legalEffectiveAtMs(DAY);
const DRAFTS = { '1.0': null, '1.1': null, '1.2': null, '1.3': null };

const ANNOUNCED: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: { vendor_terms: { version: '1.4', effectiveOn: DAY } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: {},
  agreementKnown: { vendor_terms: ['1.0', '1.1', '1.2', '1.3'], managed_plan: ['1.0', '1.1'] },
  agreementEffectiveOn: { vendor_terms: DRAFTS, managed_plan: { '1.0': null, '1.1': null } },
};
const BUMPED: LegalInForceMaps = {
  ...ANNOUNCED,
  agreementCurrent: { vendor_terms: '1.4', managed_plan: '1.1' },
  agreementUpcoming: {},
  agreementKnown: {
    ...ANNOUNCED.agreementKnown!,
    vendor_terms: ['1.0', '1.1', '1.2', '1.3', '1.4'],
  },
  agreementEffectiveOn: {
    ...ANNOUNCED.agreementEffectiveOn!,
    vendor_terms: { ...DRAFTS, '1.4': DAY },
  },
};

const ROWS: PublishedVersionLite[] = [
  {
    document: 'vendor_terms',
    version: '1.4',
    effectiveAt: MOMENT,
    requiresAcceptance: true,
    summaryJson: '["A change."]',
  },
];
const VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'];

describe.each([MOMENT, MOMENT + 13 * 86_400_000])('at %s, announced equals bumped', (now) => {
  it('the version a new acceptance stamps', () => {
    expect(legalVersionsInForce(ROWS, now, ANNOUNCED)).toEqual(
      legalVersionsInForce(ROWS, now, BUMPED),
    );
  });

  it('every effective moment, final version and version in force (EFFECTIVE_ON)', () => {
    for (const v of VERSIONS) {
      expect(effectiveAtMsOf('vendor_terms', v, ROWS, ANNOUNCED), v).toBe(
        effectiveAtMsOf('vendor_terms', v, ROWS, BUMPED),
      );
    }
    expect(finalVersions('vendor_terms', ROWS, ANNOUNCED)).toEqual(
      finalVersions('vendor_terms', ROWS, BUMPED),
    );
    expect(inForceVersions('vendor_terms', ROWS, now, ANNOUNCED)).toEqual(
      inForceVersions('vendor_terms', ROWS, now, BUMPED),
    );
  });

  it('what the acceptance screen asks', () => {
    for (const accepted of [[], [{ document: 'vendor_terms', version: '1.4' }]]) {
      expect(requiredVendorTermsVersion(ROWS, accepted, now, ANNOUNCED)).toBe(
        requiredVendorTermsVersion(ROWS, accepted, now, BUMPED),
      );
      const input = { published: ROWS, accepted, monthlyCard: true };
      expect(pendingAcceptances(input, now, ANNOUNCED)).toEqual(
        pendingAcceptances(input, now, BUMPED),
      );
    }
  });

  it('which versions a checkout or grant may record (KNOWN_VERSIONS)', () => {
    for (const v of VERSIONS) {
      expect(isRecordableLegalAgreementVersion('vendor_terms', v, ANNOUNCED), v).toBe(
        isRecordableLegalAgreementVersion('vendor_terms', v, BUMPED),
      );
    }
  });
});

// `/admin/legal` lists upcoming entries only. Before the cleanup the 1.4 card names
// `current_version` 1.3, the version it replaces, also after the moment; the cleanup
// removes the entry and so the card. That is a difference by design: the card is the
// publish record of an announcement, not a statement of what is in force, and the
// acceptance status section below it reads the version in force from the rows.
describe('/admin/legal current_version', () => {
  it('names the replaced build version while the entry exists, and no card after', () => {
    expect(ANNOUNCED.agreementCurrent.vendor_terms).toBe('1.3');
    expect(ANNOUNCED.agreementUpcoming.vendor_terms?.version).toBe('1.4');
    expect(BUMPED.agreementUpcoming.vendor_terms).toBeUndefined();
  });
});
