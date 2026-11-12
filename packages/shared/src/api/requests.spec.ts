import { describe, expect, it } from 'vitest';

import { AdminClaimSchema } from './admin-claims';
import { AdminVendorRequestSchema } from './admin-requests';
import {
  claimantTitle,
  ClaimFormSchema,
  ClaimRequestSchema,
  ConfirmRequestResponseSchema,
  ConfirmRequestSchema,
  ListingRequestSchema,
  RequestSubmitResponseSchema,
  StoredClaimRequestSchema,
  StoredListingRequestSchema,
} from './requests';

const claim = {
  submitter_name: 'Ada Lovelace',
  submitter_email: 'ada@example.com',
  submitter_role: 'Product manager',
  submitter_title: 'VP Product',
  company_legal_name: 'Acme, Inc.',
  accepted_terms: true,
};

// AECI-1705: a listing request carries no vendor terms box, and names the company's country.
const { accepted_terms: _terms, ...claimant } = claim;
const listing = {
  ...claimant,
  listing_name: 'Site Diary Pro',
  website: 'https://sitediary.example.com',
  company_country: 'GB',
};

// AECI-1365 retired the plan question. An old client may still send the key: it
// must validate, and Zod must strip it so nothing downstream can store it.
describe('ClaimFormSchema without the plan question (AECI-1365)', () => {
  it('defaults body to "" when the key is absent', () => {
    const parsed = ClaimRequestSchema.parse({ ...claim, target_type: 'product', slug: 'p' });
    expect(parsed.body).toBe('');
  });

  it('accepts and strips a retired plan_interest key', () => {
    const parsed = ClaimFormSchema.parse({ ...claim, plan_interest: 'managed' });
    expect(parsed).not.toHaveProperty('plan_interest');
  });

  it('keeps the 2,000 character cap on body (the "Additional comments")', () => {
    expect(ClaimFormSchema.safeParse({ ...claim, body: 'x'.repeat(2000) }).success).toBe(true);
    expect(ClaimFormSchema.safeParse({ ...claim, body: 'x'.repeat(2001) }).success).toBe(false);
  });
});

// AECI-1366: "I have read and accept the Vendor Terms" is required.
describe('accepted_terms (AECI-1366)', () => {
  const { accepted_terms: _omit, ...withoutTerms } = claim;

  it('ClaimFormSchema accepts only the literal true', () => {
    expect(ClaimFormSchema.safeParse(claim).success).toBe(true);
    for (const value of [false, 'true', 1, null]) {
      const result = ClaimFormSchema.safeParse({ ...claim, accepted_terms: value });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['accepted_terms']);
    }
  });

  // AECI-1705: a listing request is not a claim, so it asks for no terms.
  it('ListingRequestSchema needs no accepted_terms, and strips one a stale bundle sends', () => {
    expect(ListingRequestSchema.safeParse(listing).success).toBe(true);
    for (const value of [true, false]) {
      const parsed = ListingRequestSchema.parse({ ...listing, accepted_terms: value });
      expect(parsed).not.toHaveProperty('accepted_terms');
    }
  });

  it('refuses a body that omits the key, as a stale client would send', () => {
    const result = ClaimRequestSchema.safeParse({
      ...withoutTerms,
      target_type: 'vendor',
      slug: 'acme',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['accepted_terms']);
  });
});

// AECI-1364: a claim is on the company, but the wire still takes a product target.
// The API normalises it; the schema must keep accepting both so shipped forms work.
describe('ClaimRequestSchema target (AECI-1364)', () => {
  it.each(['product', 'vendor'])('accepts target_type %s', (targetType) => {
    const parsed = ClaimRequestSchema.parse({ ...claim, target_type: targetType, slug: 'acme' });
    expect(parsed.target_type).toBe(targetType);
  });

  it('rejects any other target type', () => {
    expect(
      ClaimRequestSchema.safeParse({ ...claim, target_type: 'integration', slug: 'acme' }).success,
    ).toBe(false);
  });
});

describe('AdminClaimSchema.context_product (AECI-1364)', () => {
  it('is required and nullable, so a missed construction site fails validation', () => {
    const shape = AdminClaimSchema.shape.context_product;
    expect(shape.safeParse(null).success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(false);
    expect(
      shape.safeParse({ id: '00000000-0000-4000-8000-000000000001', name: 'Revit', slug: 'revit' })
        .success,
    ).toBe(true);
  });
});

describe('ListingRequestSchema (AECI-1293)', () => {
  it('accepts a typed-in listing with the claim fields', () => {
    const parsed = ListingRequestSchema.parse({ ...listing, plan_interest: 'managed' });
    expect(parsed.listing_name).toBe('Site Diary Pro');
    expect(parsed).not.toHaveProperty('plan_interest');
    expect(parsed.submitter_linkedin_url).toBe('');
  });

  it('trims the name and requires it', () => {
    expect(ListingRequestSchema.parse({ ...listing, listing_name: '  X  ' }).listing_name).toBe(
      'X',
    );
    expect(ListingRequestSchema.safeParse({ ...listing, listing_name: '   ' }).success).toBe(false);
    expect(
      ListingRequestSchema.safeParse({ ...listing, listing_name: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not a URL', 'sitediary.example.com'],
    ['http', 'http://sitediary.example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['credentials', 'https://user:pw@sitediary.example.com'],
    ['over 500 characters', `https://example.com/${'a'.repeat(500)}`],
  ])('rejects a website that is %s', (_label, website) => {
    expect(ListingRequestSchema.safeParse({ ...listing, website }).success).toBe(false);
  });

  it('keeps the LinkedIn host allowlist', () => {
    expect(
      ListingRequestSchema.safeParse({
        ...listing,
        submitter_linkedin_url: 'https://example.com/in/ada',
      }).success,
    ).toBe(false);
    expect(
      ListingRequestSchema.safeParse({
        ...listing,
        submitter_linkedin_url: 'https://www.linkedin.com/in/ada',
      }).success,
    ).toBe(true);
  });

  it('keeps the claim identity rules (name, title, email required)', () => {
    expect(ListingRequestSchema.safeParse({ ...listing, submitter_title: '' }).success).toBe(false);
    expect(ListingRequestSchema.safeParse({ ...listing, submitter_email: 'nope' }).success).toBe(
      false,
    );
  });
});

// AECI-1705: the company's country, required on a new listing request.
describe('ListingRequestSchema company_country (AECI-1705)', () => {
  it('requires it', () => {
    const { company_country: _c, ...without } = listing;
    const result = ListingRequestSchema.safeParse(without);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['company_country']);
  });

  it.each([
    ['blank', ''],
    ['free text', 'United Kingdom'],
    ['an alpha-3 code', 'GBR'],
    ['an unassigned code', 'ZZ'],
    ['a reserved code', 'UK'],
  ])('rejects %s', (_label, company_country) => {
    expect(ListingRequestSchema.safeParse({ ...listing, company_country }).success).toBe(false);
  });

  it('takes an assigned code, trimmed and upper-cased', () => {
    expect(
      ListingRequestSchema.parse({ ...listing, company_country: ' de ' }).company_country,
    ).toBe('DE');
  });

  it('a pending payload from before the field still parses at confirm', () => {
    const { company_country: _c, ...old } = listing;
    expect(StoredListingRequestSchema.parse({ ...old, accepted_terms: true })).not.toHaveProperty(
      'accepted_terms',
    );
    expect(StoredListingRequestSchema.parse(old).company_country).toBeUndefined();
  });
});

describe('admin request schemas', () => {
  it('no longer carries plan_interest on the vendor request row (AECI-1365)', () => {
    expect(AdminVendorRequestSchema.shape).not.toHaveProperty('plan_interest');
  });
});

describe('the emailed confirmation (AECI-1435)', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('requires confirmation_required on every submit response', () => {
    expect(RequestSubmitResponseSchema.safeParse({ request_id: ID, message: 'ok' }).success).toBe(
      false,
    );
    expect(
      RequestSubmitResponseSchema.parse({
        request_id: ID,
        message: 'ok',
        confirmation_required: true,
      }),
    ).toMatchObject({ confirmation_required: true });
  });

  it('takes a trimmed, non-empty, bounded token', () => {
    expect(ConfirmRequestSchema.parse({ token: '  abc  ' })).toEqual({ token: 'abc' });
    expect(ConfirmRequestSchema.safeParse({ token: '   ' }).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({}).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ token: 'x'.repeat(201) }).success).toBe(false);
  });

  it('answers confirmed or already_confirmed, for a claim or a listing', () => {
    const ok = {
      status: 'confirmed',
      kind: 'claim',
      request_id: ID,
      routed: true,
      company_name: 'Acme',
    };
    expect(ConfirmRequestResponseSchema.parse(ok)).toEqual(ok);
    expect(ConfirmRequestResponseSchema.safeParse({ ...ok, status: 'expired' }).success).toBe(
      false,
    );
    expect(ConfirmRequestResponseSchema.safeParse({ ...ok, kind: 'correction' }).success).toBe(
      false,
    );
  });

  it('answers rejected for a claim only, with a reason and the other company', () => {
    const rejected = {
      status: 'rejected',
      kind: 'claim',
      request_id: ID,
      routed: false,
      company_name: 'Acme',
      reason: 'other_vendor',
      vendor_name: 'Globex',
    };
    expect(ConfirmRequestResponseSchema.parse(rejected)).toEqual(rejected);
    const admin = { ...rejected, reason: 'already_admin', vendor_name: null };
    expect(ConfirmRequestResponseSchema.parse(admin)).toEqual(admin);
    for (const bad of [
      { ...rejected, reason: 'banned' },
      { ...rejected, kind: 'listing' },
      { ...rejected, routed: true },
      { status: 'rejected', kind: 'claim', request_id: ID, routed: false, company_name: 'Acme' },
    ]) {
      expect(ConfirmRequestResponseSchema.safeParse(bad).success).toBe(false);
    }
  });
});

// AECI-1617 (counsel Q11): the signer's title and the company's legal name.
describe('the signer fields', () => {
  const body = { ...claim, target_type: 'vendor', slug: 'acme' };

  it.each([
    ['a missing title', { submitter_title: undefined }],
    ['a blank title', { submitter_title: '   ' }],
    ['a long title', { submitter_title: 'x'.repeat(101) }],
    ['a missing legal name', { company_legal_name: undefined }],
    ['a blank legal name', { company_legal_name: '   ' }],
    ['a long legal name', { company_legal_name: 'x'.repeat(201) }],
  ])('refuses %s on a new submit', (_label, over) => {
    expect(ClaimRequestSchema.safeParse({ ...body, ...over }).success).toBe(false);
  });

  it('trims both', () => {
    const parsed = ClaimRequestSchema.parse({
      ...body,
      submitter_title: '  VP Product ',
      company_legal_name: ' Acme, Inc. ',
    });
    expect(parsed.submitter_title).toBe('VP Product');
    expect(parsed.company_legal_name).toBe('Acme, Inc.');
  });

  it('a stored payload from before the fields still parses, and only the confirm uses that schema', () => {
    const { submitter_title: _t, company_legal_name: _l, ...old } = body;
    expect(ClaimRequestSchema.safeParse(old).success).toBe(false);
    expect(StoredClaimRequestSchema.safeParse(old).success).toBe(true);
    const { accepted_terms: _a, ...oldListing } = old;
    const listing = {
      ...oldListing,
      listing_name: 'Acme Field',
      website: 'https://acme.example.com',
      company_country: 'US',
    };
    expect(ListingRequestSchema.safeParse(listing).success).toBe(false);
    expect(StoredListingRequestSchema.safeParse(listing).success).toBe(true);
  });
});

// AECI-1649: the title replaced the role field.
describe('the role field is gone (AECI-1649)', () => {
  const body = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_title: 'VP Partnerships',
    company_legal_name: 'Acme, Inc.',
    accepted_terms: true,
  } as const;

  it('a new submit needs no role, and a stale bundle that sends one has it stripped', () => {
    expect(ClaimRequestSchema.safeParse(body).success).toBe(true);
    const stale = ClaimRequestSchema.parse({ ...body, submitter_role: 'Head of Partnerships' });
    expect('submitter_role' in stale).toBe(false);
  });

  it('a pending payload stored with a role keeps it through the confirm schema', () => {
    const stored = StoredClaimRequestSchema.parse({ ...body, submitter_role: ' Founder ' });
    expect(stored.submitter_role).toBe('Founder');
  });

  it('claimantTitle prefers the title and falls back to the role', () => {
    expect(claimantTitle('VP Partnerships', 'Founder')).toBe('VP Partnerships');
    expect(claimantTitle(null, ' Founder ')).toBe('Founder');
    expect(claimantTitle('  ', '')).toBeNull();
    expect(claimantTitle(undefined, null)).toBeNull();
  });
});
