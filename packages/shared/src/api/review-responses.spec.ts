import { describe, expect, it } from 'vitest';

import { ApiErrorCode } from '../errors/codes';
import { VendorRevisionsSchema, VENDOR_PORTAL_SCOPES } from './vendor-updates';
import {
  ListVendorReviewsQuerySchema,
  PublicVendorResponseSchema,
  REVIEW_REPLY_STATUS_FILTERS,
  REVIEW_RESPONSE_BODY_MAX,
  REVIEW_RESPONSE_STATUSES,
  ReviewResponseBodySchema,
  VendorReviewItemSchema,
  VendorReviewResponseSchema,
} from './review-responses';
import { PublicReviewSchema } from './reviews';

/** AECI-1176 — the vendor review-reply wire shapes (`API_CONTRACTS.md` §6.14). */

const UUID = '00000000-0000-4000-8000-000000000001';

describe('the reply vocabulary (§11c.6)', () => {
  it('has exactly the five statuses, in spec order', () => {
    expect(REVIEW_RESPONSE_STATUSES).toEqual([
      'pending',
      'published',
      'rejected',
      'withdrawn',
      'removed',
    ]);
  });

  it('filters on none plus the five statuses', () => {
    expect(REVIEW_REPLY_STATUS_FILTERS).toEqual(['none', ...REVIEW_RESPONSE_STATUSES]);
  });

  it('registers the four error codes', () => {
    expect(ApiErrorCode.REVIEW_RESPONSE_EXISTS).toBe('REVIEW_RESPONSE_EXISTS');
    expect(ApiErrorCode.REVIEW_RESPONSE_REMOVED).toBe('REVIEW_RESPONSE_REMOVED');
    expect(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE).toBe('REVIEW_RESPONSE_WRONG_STATE');
    expect(ApiErrorCode.REVIEW_RESPONSE_NO_CHANGE).toBe('REVIEW_RESPONSE_NO_CHANGE');
  });
});

describe('ReviewResponseBodySchema (§11c.5)', () => {
  it('trims, then keeps the line breaks inside', () => {
    expect(ReviewResponseBodySchema.parse({ body: '  one\ntwo  ' })).toEqual({ body: 'one\ntwo' });
  });

  it('refuses an empty or whitespace-only body', () => {
    expect(ReviewResponseBodySchema.safeParse({ body: '' }).success).toBe(false);
    expect(ReviewResponseBodySchema.safeParse({ body: ' \n\t ' }).success).toBe(false);
    expect(ReviewResponseBodySchema.safeParse({}).success).toBe(false);
  });

  it('caps the trimmed body at 2,000 characters', () => {
    expect(REVIEW_RESPONSE_BODY_MAX).toBe(2000);
    expect(ReviewResponseBodySchema.safeParse({ body: 'x'.repeat(2000) }).success).toBe(true);
    expect(ReviewResponseBodySchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    // Padding does not count against the cap: it is trimmed first.
    expect(ReviewResponseBodySchema.safeParse({ body: ` ${'x'.repeat(2000)} ` }).success).toBe(
      true,
    );
  });

  it('strips any vendor id or status a client sends', () => {
    const parsed = ReviewResponseBodySchema.parse({
      body: 'Hi.',
      vendor_id: UUID,
      status: 'published',
    });
    expect(parsed).toEqual({ body: 'Hi.' });
  });
});

describe('ListVendorReviewsQuerySchema', () => {
  it('defaults the page and accepts the two filters', () => {
    expect(ListVendorReviewsQuerySchema.parse({})).toEqual({ page: 1, perPage: 24 });
    expect(
      ListVendorReviewsQuerySchema.parse({ product_id: UUID, reply_status: 'none', page: '2' }),
    ).toEqual({ page: 2, perPage: 24, product_id: UUID, reply_status: 'none' });
  });

  it('refuses an unknown reply_status and a non-uuid product_id', () => {
    expect(ListVendorReviewsQuerySchema.safeParse({ reply_status: 'approved' }).success).toBe(
      false,
    );
    expect(ListVendorReviewsQuerySchema.safeParse({ product_id: 'revit' }).success).toBe(false);
  });
});

describe('the read shapes', () => {
  const response = {
    id: UUID,
    status: 'rejected',
    body: 'A reply.',
    rejection_reason: 'Off topic.',
    published_at: null,
    moderated_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };

  it('carries the reason to the vendor, and no author or moderator', () => {
    const parsed = VendorReviewResponseSchema.parse({
      ...response,
      author_profile_id: UUID,
      moderated_by: UUID,
    });
    expect(parsed.rejection_reason).toBe('Off topic.');
    expect(parsed).not.toHaveProperty('author_profile_id');
    expect(parsed).not.toHaveProperty('moderated_by');
  });

  it('parses a list item with a co-owner reply', () => {
    const item = VendorReviewItemSchema.parse({
      review: {
        id: UUID,
        rating_overall: 4,
        rating_onboarding: 3,
        title: 'T',
        body: 'B',
        role_at_company: null,
        years_using: null,
        would_recommend: null,
        verified_work_email: false,
        created_at: '2026-08-01T00:00:00.000Z',
      },
      product: { id: UUID, slug: 'revit', name: 'Revit', logo_url: null },
      response,
      other_responses: [
        {
          vendor_slug: 'bentley',
          vendor_name: 'Bentley',
          body: 'Co-owner.',
          published_at: '2026-09-02T00:00:00.000Z',
        },
      ],
      can_reply: false,
    });
    expect(item.other_responses).toHaveLength(1);
  });

  it('strips vendor_responses from the list item review, so a reply is never said twice', () => {
    const item = VendorReviewItemSchema.parse({
      review: {
        id: UUID,
        rating_overall: 4,
        rating_onboarding: 3,
        title: 'T',
        body: 'B',
        role_at_company: null,
        years_using: null,
        would_recommend: null,
        verified_work_email: false,
        created_at: '2026-08-01T00:00:00.000Z',
        vendor_responses: [
          {
            vendor_slug: 'a',
            vendor_name: 'A',
            body: 'x',
            published_at: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
      product: { id: UUID, slug: 'revit', name: 'Revit', logo_url: null },
      response: null,
      other_responses: [],
      can_reply: true,
    });
    expect(item.review).not.toHaveProperty('vendor_responses');
  });

  it('defaults PublicReview.vendor_responses to [] for deploy skew (AECI-1178)', () => {
    const parsed = PublicReviewSchema.parse({
      id: UUID,
      rating_overall: 4,
      rating_onboarding: 3,
      title: 'T',
      body: 'B',
      role_at_company: null,
      years_using: null,
      would_recommend: null,
      verified_work_email: false,
      created_at: '2026-08-01T00:00:00.000Z',
    });
    expect(parsed.vendor_responses).toEqual([]);
  });

  it('requires a datetime published_at on a public reply', () => {
    expect(
      PublicVendorResponseSchema.safeParse({
        vendor_slug: 'a',
        vendor_name: 'A',
        body: 'x',
        published_at: 'yesterday',
      }).success,
    ).toBe(false);
  });
});

describe('the reviews cursor scope (§11c.13)', () => {
  it('is a ninth scope that defaults to null for deploy skew', () => {
    expect(VENDOR_PORTAL_SCOPES).toContain('reviews');
    expect(VENDOR_PORTAL_SCOPES).toHaveLength(9);
    const old = {
      profile: null,
      entitlement: null,
      products: null,
      integrations: null,
      notifications: null,
      requests: null,
    };
    expect(VendorRevisionsSchema.parse(old).reviews).toBeNull();
  });
});
