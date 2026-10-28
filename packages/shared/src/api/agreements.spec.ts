import { describe, expect, it } from 'vitest';

import {
  isKnownLegalAgreementVersion,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
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
