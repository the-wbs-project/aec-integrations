import { describe, expect, it } from 'vitest';

import {
  companyFactCorrectionColumns,
  companyFactProvenanceWrites,
  effectiveOwnershipType,
  publicPrivateFor,
} from './company-facts';

const NOW = '2026-11-05T10:00:00.000Z';

describe('publicPrivateFor', () => {
  it('maps only public to public, because nothing else trades', () => {
    expect(publicPrivateFor('public')).toBe('public');
    expect(publicPrivateFor('private')).toBe('private');
    expect(publicPrivateFor('subsidiary')).toBe('private');
    expect(publicPrivateFor('nonprofit')).toBe('private');
    expect(publicPrivateFor(null)).toBeNull();
  });
});

describe('effectiveOwnershipType', () => {
  it('prefers ownership_type', () => {
    expect(effectiveOwnershipType({ ownershipType: 'nonprofit', publicPrivate: 'private' })).toBe(
      'nonprofit',
    );
  });

  it('falls back to public_private on a row written before the column existed', () => {
    expect(effectiveOwnershipType({ ownershipType: null, publicPrivate: 'public' })).toBe('public');
    expect(effectiveOwnershipType({ ownershipType: null, publicPrivate: null })).toBeNull();
  });
});

describe('companyFactProvenanceWrites', () => {
  it('clears the source and stamps the date on a changed fact', () => {
    expect(
      companyFactProvenanceWrites({ companySize: '1-10' }, { companySize: '11-50' }, NOW),
    ).toEqual({ companySizeSourceUrl: null, companySizeCheckedAt: NOW });
  });

  it('leaves the source standing when the stored value is re-saved', () => {
    expect(
      companyFactProvenanceWrites({ headquarters: 'Oslo' }, { headquarters: 'Oslo' }, NOW),
    ).toEqual({});
    expect(
      companyFactProvenanceWrites({ parentCompany: null }, { parentCompany: null }, NOW),
    ).toEqual({});
  });

  it('moves on a clear', () => {
    expect(
      companyFactProvenanceWrites({ fundingStage: 'Seed' }, { fundingStage: null }, NOW),
    ).toEqual({
      fundingSourceUrl: null,
      fundingCheckedAt: NOW,
    });
  });

  it('files ownership_type under the public_private pair, reading the older column', () => {
    expect(
      companyFactProvenanceWrites(
        { ownershipType: null, publicPrivate: 'private' },
        { ownershipType: 'private', publicPrivate: 'private' },
        NOW,
      ),
    ).toEqual({});
    expect(
      companyFactProvenanceWrites(
        { ownershipType: null, publicPrivate: 'private' },
        { ownershipType: 'subsidiary', publicPrivate: 'private' },
        NOW,
      ),
    ).toEqual({ publicPrivateSourceUrl: null, publicPrivateCheckedAt: NOW });
  });

  it('ignores a column that is not a fact', () => {
    expect(companyFactProvenanceWrites({ website: 'a' }, { website: 'b' }, NOW)).toEqual({});
  });
});

describe('companyFactCorrectionColumns', () => {
  it('clears the source on a corrected fact', () => {
    expect(companyFactCorrectionColumns('foundedYear', 2001, NOW)).toEqual({
      foundedYearSourceUrl: null,
      foundedYearCheckedAt: NOW,
    });
  });

  it('keeps public_private in step with a corrected ownership', () => {
    expect(companyFactCorrectionColumns('ownershipType', 'public', NOW)).toEqual({
      publicPrivateSourceUrl: null,
      publicPrivateCheckedAt: NOW,
      publicPrivate: 'public',
    });
  });

  it('adds nothing for a field that is not a fact', () => {
    expect(companyFactCorrectionColumns('website', 'https://x.example', NOW)).toEqual({});
  });
});
