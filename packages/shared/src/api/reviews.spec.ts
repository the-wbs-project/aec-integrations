import { describe, expect, it } from 'vitest';

import { AccountReviewSchema } from './account';
import {
  AdminReviewSchema,
  ModerateReviewSchema,
  REVIEW_DECISIONS,
  REVIEW_REASON_MAX,
  ReviewStatusSchema,
  reviewDecisionsFor,
} from './reviews';

/** AECI-1643: the admin review state machine, as data. */
describe('the review decision table', () => {
  it('gives each action one from-state, and purges only on a visibility change', () => {
    expect(REVIEW_DECISIONS).toEqual({
      approve: { from: 'pending', to: 'approved', purges: true },
      reject: { from: 'pending', to: 'rejected', purges: false },
      remove: { from: 'approved', to: 'removed', purges: true },
    });
    expect(reviewDecisionsFor('pending')).toEqual(['approve', 'reject']);
    expect(reviewDecisionsFor('approved')).toEqual(['remove']);
    expect(reviewDecisionsFor('rejected')).toEqual([]);
    expect(reviewDecisionsFor('removed')).toEqual([]);
  });

  it('admits removed as a status', () => {
    expect(ReviewStatusSchema.options).toEqual(['pending', 'approved', 'rejected', 'removed']);
  });
});

describe('ModerateReviewSchema', () => {
  it('needs a reason to reject or remove, none to approve', () => {
    expect(ModerateReviewSchema.safeParse({ action: 'approve' }).success).toBe(true);
    for (const action of ['reject', 'remove'] as const) {
      expect(ModerateReviewSchema.safeParse({ action }).success).toBe(false);
      const blank = ModerateReviewSchema.safeParse({ action, rejection_reason: '   ' });
      expect(blank.success).toBe(false);
      expect(blank.error?.issues[0]?.path).toEqual(['rejection_reason']);
      expect(ModerateReviewSchema.safeParse({ action, rejection_reason: 'Breach' }).success).toBe(
        true,
      );
    }
  });

  it('caps the reason at REVIEW_REASON_MAX', () => {
    const long = 'x'.repeat(REVIEW_REASON_MAX + 1);
    expect(
      ModerateReviewSchema.safeParse({ action: 'remove', rejection_reason: long }).success,
    ).toBe(false);
    expect(
      ModerateReviewSchema.safeParse({
        action: 'remove',
        rejection_reason: long.slice(1),
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown action', () => {
    expect(ModerateReviewSchema.safeParse({ action: 'archive' }).success).toBe(false);
  });
});

describe('deploy skew', () => {
  it('parses an admin and an account review that predate removed_at / removal_reason', () => {
    const admin = AdminReviewSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      product: { id: '00000000-0000-4000-8000-000000000002', name: 'P', slug: 'p' },
      reviewer_email: null,
      reviewer_firm: null,
      rating_overall: 4,
      rating_onboarding: 4,
      title: 't',
      body: 'b',
      role_at_company: null,
      years_using: null,
      would_recommend: null,
      locale: 'en-US',
      status: 'approved',
      toxicity_score: null,
      rejection_reason: null,
      moderated_at: null,
      created_at: '2026-11-01T00:00:00.000Z',
    });
    expect(admin.success).toBe(true);
    const account = AccountReviewSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      product: { id: '00000000-0000-4000-8000-000000000002', name: 'P', slug: 'p' },
      rating_overall: 4,
      rating_onboarding: 4,
      title: 't',
      status: 'removed',
      rejection_reason: null,
      created_at: '2026-11-01T00:00:00.000Z',
    });
    expect(account.success).toBe(true);
  });
});
