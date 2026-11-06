import { describe, expect, it } from 'vitest';

import {
  DecideReviewUpdateSchema,
  REVIEW_UPDATE_DECISIONS,
  SubmitReviewUpdateSchema,
  reviewUpdateDecisionsFor,
} from './review-updates';
import { PublicReviewSchema } from './reviews';

const BODY = 'The vendor fixed the problem I described, so my experience has changed.';

describe('SubmitReviewUpdateSchema (AECI-1613)', () => {
  it('takes both ratings or neither', () => {
    expect(SubmitReviewUpdateSchema.safeParse({ body: BODY }).success).toBe(true);
    expect(
      SubmitReviewUpdateSchema.safeParse({
        body: BODY,
        rating_overall: null,
        rating_onboarding: null,
      }).success,
    ).toBe(true);
    expect(
      SubmitReviewUpdateSchema.safeParse({ body: BODY, rating_overall: 4, rating_onboarding: 5 })
        .success,
    ).toBe(true);
    const one = SubmitReviewUpdateSchema.safeParse({ body: BODY, rating_overall: 4 });
    expect(one.success).toBe(false);
    expect(one.error?.issues[0]?.path).toEqual(['rating_onboarding']);
    const other = SubmitReviewUpdateSchema.safeParse({ body: BODY, rating_onboarding: 4 });
    expect(other.error?.issues[0]?.path).toEqual(['rating_overall']);
  });

  it('trims the body and holds it to 50..2000', () => {
    expect(SubmitReviewUpdateSchema.parse({ body: `  ${BODY}  ` }).body).toBe(BODY);
    expect(SubmitReviewUpdateSchema.safeParse({ body: ' '.repeat(80) }).success).toBe(false);
    expect(SubmitReviewUpdateSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('the decision table', () => {
  it('needs a reason to reject or remove, none to approve', () => {
    expect(DecideReviewUpdateSchema.safeParse({ action: 'approve' }).success).toBe(true);
    expect(DecideReviewUpdateSchema.safeParse({ action: 'reject' }).success).toBe(false);
    expect(DecideReviewUpdateSchema.safeParse({ action: 'remove', reason: ' ' }).success).toBe(
      false,
    );
  });

  it('gives each action one from-state, and purges only on a visibility change', () => {
    expect(REVIEW_UPDATE_DECISIONS).toEqual({
      approve: { from: 'pending', to: 'approved', purges: true },
      reject: { from: 'pending', to: 'rejected', purges: false },
      remove: { from: 'approved', to: 'removed', purges: true },
    });
    expect(reviewUpdateDecisionsFor('pending')).toEqual(['approve', 'reject']);
    expect(reviewUpdateDecisionsFor('approved')).toEqual(['remove']);
    expect(reviewUpdateDecisionsFor('removed')).toEqual([]);
  });
});

describe('PublicReview.updates', () => {
  it('defaults to [] for a wire that predates it', () => {
    const parsed = PublicReviewSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      rating_overall: 4,
      rating_onboarding: 4,
      title: 't',
      body: 'b',
      role_at_company: null,
      years_using: null,
      would_recommend: null,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    expect(parsed.updates).toEqual([]);
  });
});
