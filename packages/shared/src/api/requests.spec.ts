import { describe, expect, it } from 'vitest';

import { AdminClaimSchema } from './admin-claims';
import {
  AdminListingRequestSchema,
  AdminVendorRequestSchema,
  ListListingRequestsQuerySchema,
} from './admin-requests';
import {
  ClaimFormSchema,
  ClaimRequestSchema,
  ListingRequestSchema,
  PlanInterestSchema,
} from './requests';

const claim = {
  submitter_name: 'Ada Lovelace',
  submitter_email: 'ada@example.com',
  submitter_role: 'Product manager',
};

const listing = {
  ...claim,
  listing_name: 'Site Diary Pro',
  website: 'https://sitediary.example.com',
};

describe('PlanInterestSchema (AECI-1293)', () => {
  it.each(['free', 'managed', 'not_sure'])('accepts %s', (value) => {
    expect(PlanInterestSchema.parse(value)).toBe(value);
  });

  it('rejects anything else', () => {
    expect(PlanInterestSchema.safeParse('enterprise').success).toBe(false);
  });
});

describe('ClaimFormSchema.plan_interest (AECI-1293)', () => {
  it('defaults to "" when the key is absent, so a body that predates the field validates', () => {
    const parsed = ClaimRequestSchema.parse({ ...claim, target_type: 'product', slug: 'p' });
    expect(parsed.plan_interest).toBe('');
    expect(parsed.body).toBe('');
  });

  it.each(['', 'free', 'managed', 'not_sure'])('accepts %j', (value) => {
    expect(ClaimFormSchema.parse({ ...claim, plan_interest: value }).plan_interest).toBe(value);
  });

  it('rejects a value outside the vocabulary', () => {
    expect(ClaimFormSchema.safeParse({ ...claim, plan_interest: 'paid' }).success).toBe(false);
  });

  it('keeps the 2,000 character cap on body (the "Additional comments")', () => {
    expect(ClaimFormSchema.safeParse({ ...claim, body: 'x'.repeat(2000) }).success).toBe(true);
    expect(ClaimFormSchema.safeParse({ ...claim, body: 'x'.repeat(2001) }).success).toBe(false);
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
    expect(parsed.plan_interest).toBe('managed');
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

  it('keeps the claim identity rules (name, role, email required)', () => {
    expect(ListingRequestSchema.safeParse({ ...listing, submitter_role: '' }).success).toBe(false);
    expect(ListingRequestSchema.safeParse({ ...listing, submitter_email: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('admin listing request schemas (AECI-1293)', () => {
  it('defaults the queue to open', () => {
    expect(ListListingRequestsQuerySchema.parse({}).status).toBe('open');
  });

  it('parses a row with a null plan interest', () => {
    const row = AdminListingRequestSchema.parse({
      id: '11111111-2222-4333-8444-555555555555',
      status: 'open',
      listing_name: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
      submitter_email: 'ada@example.com',
      submitter_name: 'Ada',
      submitter_role: 'PM',
      submitter_linkedin_url: null,
      plan_interest: null,
      body: '',
      created_at: '2026-10-12T08:00:00.000Z',
      resolved_at: null,
      resolved_by: null,
    });
    expect(row.plan_interest).toBeNull();
  });

  it('carries plan_interest on the vendor request row', () => {
    expect(AdminVendorRequestSchema.shape.plan_interest.safeParse('managed').success).toBe(true);
    expect(AdminVendorRequestSchema.shape.plan_interest.safeParse(null).success).toBe(true);
    expect(AdminVendorRequestSchema.shape.plan_interest.safeParse('x').success).toBe(false);
  });
});
