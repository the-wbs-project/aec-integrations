import { describe, expect, it } from 'vitest';

import { ApiErrorCode } from '../errors/codes';
import { VendorRevisionsSchema, VENDOR_PORTAL_SCOPES } from './vendor-updates';
import {
  DecideReviewResponseSchema,
  ListAdminReviewResponsesQuerySchema,
  REVIEW_RESPONSE_DECISIONS,
  reviewResponseDecisionsFor,
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

/** AECI-1177 — the admin half of the §11c.6 state machine. */
describe('the admin decision state machine (§11c.6)', () => {
  it('has exactly three decisions, each with one from-state and one to-state', () => {
    expect(REVIEW_RESPONSE_DECISIONS).toEqual({
      approve: { from: 'pending', to: 'published', purges: true },
      reject: { from: 'pending', to: 'rejected', purges: false },
      remove: { from: 'published', to: 'removed', purges: true },
    });
  });

  it('offers approve and reject on pending, remove on published, and nothing else', () => {
    expect(reviewResponseDecisionsFor('pending')).toEqual(['approve', 'reject']);
    expect(reviewResponseDecisionsFor('published')).toEqual(['remove']);
    expect(reviewResponseDecisionsFor('rejected')).toEqual([]);
    expect(reviewResponseDecisionsFor('withdrawn')).toEqual([]);
    expect(reviewResponseDecisionsFor('removed')).toEqual([]);
  });

  it('purges exactly when public visibility changes', () => {
    // A pending reply was never on the page, so rejecting it changes nothing a
    // visitor sees. Approve makes it appear; remove takes it down.
    for (const plan of Object.values(REVIEW_RESPONSE_DECISIONS)) {
      expect(plan.purges).toBe(plan.from === 'published' || plan.to === 'published');
    }
  });

  it('never moves a reply out of removed', () => {
    for (const plan of Object.values(REVIEW_RESPONSE_DECISIONS)) {
      expect(plan.from).not.toBe('removed');
    }
  });
});

describe('DecideReviewResponseSchema', () => {
  const v = { expected_updated_at: '2026-09-01T10:00:00.000Z' };

  it('takes approve with no reason', () => {
    expect(DecideReviewResponseSchema.parse({ decision: 'approve', ...v })).toEqual({
      decision: 'approve',
      ...v,
    });
  });

  it.each(['reject', 'remove'] as const)('requires a trimmed reason on %s', (decision) => {
    expect(DecideReviewResponseSchema.safeParse({ decision, ...v }).success).toBe(false);
    expect(DecideReviewResponseSchema.safeParse({ decision, reason: '  ', ...v }).success).toBe(
      false,
    );
    expect(DecideReviewResponseSchema.parse({ decision, reason: ' Why. ', ...v })).toEqual({
      decision,
      reason: 'Why.',
      ...v,
    });
    expect(
      DecideReviewResponseSchema.safeParse({ decision, reason: 'x'.repeat(1001), ...v }).success,
    ).toBe(false);
  });

  it.each([
    { decision: 'approve' },
    { decision: 'reject', reason: 'Why.' },
    { decision: 'remove', reason: 'Why.' },
  ])('requires expected_updated_at on $decision (§11c.7)', (body) => {
    expect(DecideReviewResponseSchema.safeParse(body).success).toBe(false);
    expect(DecideReviewResponseSchema.safeParse({ ...body, expected_updated_at: '' }).success).toBe(
      false,
    );
  });

  it('refuses any other decision', () => {
    expect(DecideReviewResponseSchema.safeParse({ decision: 'withdraw', ...v }).success).toBe(
      false,
    );
  });

  it('registers REVIEW_RESPONSE_CHANGED', () => {
    expect(ApiErrorCode.REVIEW_RESPONSE_CHANGED).toBe('REVIEW_RESPONSE_CHANGED');
  });
});

describe('ListAdminReviewResponsesQuerySchema', () => {
  it('defaults to the pending tab', () => {
    expect(ListAdminReviewResponsesQuerySchema.parse({}).status).toBe('pending');
  });
});
