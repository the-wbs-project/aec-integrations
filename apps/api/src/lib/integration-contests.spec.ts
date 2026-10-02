import { describe, expect, it } from 'vitest';

import { acceptOverwritesVendorField } from './integration-contests';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SUBMITTER = '00000000-0000-4000-8000-000000000002';
const CLAIMED = { builtByVendorId: OWNER, claimedAt: '2026-09-01T00:00:00.000Z' };
const UNCLAIMED = { builtByVendorId: OWNER, claimedAt: null };
const by = (field: string, proposedValue: string | null, submitterVendorId = SUBMITTER) => ({
  field,
  proposedValue,
  submitterVendorId,
});

describe('acceptOverwritesVendorField (AECI-1191)', () => {
  it.each([
    ['a content field on a claimed row', by('description', 'x'), CLAIMED, true],
    ['the submitter taking the claim from the holder', by('owner', SUBMITTER), CLAIMED, true],
    ['an owner set to neither on a claimed row', by('owner', null), CLAIMED, true],
    // The reassign branch runs and clears claimed_at, so the holder loses its claim.
    ['proposing the holder, filed by someone else', by('owner', OWNER), CLAIMED, true],
    ['the holder proposing itself', by('owner', OWNER, OWNER), CLAIMED, false],
    ['a content field on an unclaimed row', by('description', 'x'), UNCLAIMED, false],
    ['an owner contest on an unclaimed row', by('owner', SUBMITTER), UNCLAIMED, false],
  ] as const)('%s -> %s', (_label, row, integration, expected) => {
    expect(acceptOverwritesVendorField(row, integration)).toBe(expected);
  });
});
