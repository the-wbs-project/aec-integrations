import { describe, expect, it } from 'vitest';

import {
  companyFactSource,
  toCompanyFacts,
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

describe('companyFactSource, the display rule', () => {
  const URL = 'https://acme.example/about';
  const AT = '2026-11-04T00:00:00.000Z';
  const base = { value: 'Oslo', sourceUrl: null, checkedAt: null, ownedAt: null };

  it('shows nothing for a null value, including a negative check', () => {
    expect(companyFactSource({ ...base, value: null })).toBeNull();
    expect(companyFactSource({ ...base, value: null, sourceUrl: URL, checkedAt: AT })).toBeNull();
  });

  it('names AECi with the correction date and its source when AECi corrected the field', () => {
    expect(
      companyFactSource({
        ...base,
        sourceUrl: URL,
        ownedAt: AT,
        correction: {
          field: 'headquarters',
          date: '2026-11-02T00:00:00.000Z',
          source_url: 'https://registry.example/acme',
        },
      }),
    ).toEqual({
      set_by: 'aeci',
      date: '2026-11-02T00:00:00.000Z',
      url: 'https://registry.example/acme',
    });
  });

  it('names AECi with the date and link for a sourced value, owned or not', () => {
    const want = { set_by: 'aeci', date: AT, url: URL };
    expect(companyFactSource({ ...base, sourceUrl: URL, checkedAt: AT })).toEqual(want);
    expect(companyFactSource({ ...base, sourceUrl: URL, checkedAt: AT, ownedAt: AT })).toEqual(
      want,
    );
  });

  it('names the vendor on an owned record with no source', () => {
    expect(companyFactSource({ ...base, ownedAt: AT })).toEqual({
      set_by: 'vendor',
      date: null,
      url: null,
    });
    expect(companyFactSource({ ...base, ownedAt: AT, checkedAt: AT })).toEqual({
      set_by: 'vendor',
      date: AT,
      url: null,
    });
  });

  it('hides a value with no source on a record the vendor does not own', () => {
    expect(companyFactSource(base)).toBeNull();
  });

  it('does not treat a non-http source as a source', () => {
    expect(companyFactSource({ ...base, sourceUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('accepts a stored SQLite date and drops an unreadable one', () => {
    expect(
      companyFactSource({ ...base, sourceUrl: URL, checkedAt: '2026-11-04 10:00:00Z' })?.date,
    ).toBe('2026-11-04T10:00:00.000Z');
    expect(companyFactSource({ ...base, sourceUrl: URL, checkedAt: 'soon' })?.date).toBeNull();
  });
});

describe('toCompanyFacts', () => {
  const empty = {
    headquarters: null,
    foundedYear: null,
    companySize: null,
    publicPrivate: null,
    ownershipType: null,
    parentCompany: null,
    fundingStage: null,
    headquartersSourceUrl: null,
    headquartersCheckedAt: null,
    foundedYearSourceUrl: null,
    foundedYearCheckedAt: null,
    companySizeSourceUrl: null,
    companySizeCheckedAt: null,
    publicPrivateSourceUrl: null,
    publicPrivateCheckedAt: null,
    parentCompanySourceUrl: null,
    parentCompanyCheckedAt: null,
    fundingSourceUrl: null,
    fundingCheckedAt: null,
    ownedAt: null,
  };

  it('is all null on a blank vendor', () => {
    expect(Object.values(toCompanyFacts(empty)).every((f) => f === null)).toBe(true);
  });

  it('files ownership under the public_private source and reads the older column', () => {
    const facts = toCompanyFacts({
      ...empty,
      publicPrivate: 'private',
      publicPrivateSourceUrl: 'https://acme.example/about',
    });
    expect(facts.ownership_type?.value).toBe('private');
    expect(facts.ownership_type?.source.url).toBe('https://acme.example/about');
  });

  it('applies a correction only to its own field', () => {
    const facts = toCompanyFacts(
      { ...empty, headquarters: 'Oslo', companySize: '1-10', ownedAt: NOW },
      [{ field: 'company_size', date: NOW, source_url: null }],
    );
    expect(facts.company_size?.source.set_by).toBe('aeci');
    expect(facts.headquarters?.source.set_by).toBe('vendor');
  });
});
