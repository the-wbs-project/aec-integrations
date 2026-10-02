/**
 * Fixtures for the portal Reviews tab (AECI-1179, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11c.16), shared by the dev-only preview (`/preview/vendor-dashboard`) and the
 * component specs.
 *
 * One review per reply state on the primary product, so the tab shows every state
 * without editing, plus one review a co-owner has answered. The second product has
 * two unanswered reviews, so the overview's "What needs you" row has two products
 * to count. Plan-free: the preview derives `can_reply` from the product's plan, as
 * the server does.
 */
import type { VendorReviewItem, VendorReviewResponse } from '@aeci/shared';

const PRIMARY = {
  id: '00000000-0000-4000-8000-000000005201',
  slug: 'summit-model-coordination',
  name: 'Summit Model Coordination',
  logo_url: null,
};

const SECONDARY = {
  id: '00000000-0000-4000-8000-000000005202',
  slug: 'summit-field-issues',
  name: 'Summit Field Issues',
  logo_url: null,
};

function review(
  n: number,
  title: string,
  body: string,
  overall: number,
  onboarding: number,
  createdAt: string,
): VendorReviewItem['review'] {
  return {
    id: `00000000-0000-4000-8000-0000000057${String(n).padStart(2, '0')}`,
    rating_overall: overall,
    rating_onboarding: onboarding,
    title,
    body,
    role_at_company: 'bim_manager',
    years_using: 2,
    would_recommend: overall >= 4 ? 'yes' : overall === 3 ? 'maybe' : 'no',
    verified_work_email: n % 2 === 0,
    created_at: createdAt,
  };
}

function reply(
  n: number,
  status: VendorReviewResponse['status'],
  body: string,
  extra: Partial<VendorReviewResponse> = {},
): VendorReviewResponse {
  return {
    id: `00000000-0000-4000-8000-0000000058${String(n).padStart(2, '0')}`,
    status,
    body,
    rejection_reason: null,
    published_at: null,
    moderated_at: null,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-22T10:00:00.000Z',
    ...extra,
  };
}

/** Every reply state on the primary product, newest review first. */
export const VENDOR_REVIEWS_FIXTURE: readonly VendorReviewItem[] = [
  {
    review: review(
      1,
      'Clash runs are fast, but the issue export drops comments',
      'Coordination meetings got shorter once we moved to Summit. The BCF export loses threaded comments, so we still paste them by hand.',
      4,
      3,
      '2026-09-28T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: null,
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      2,
      'Good federation, slow support',
      'The federated model is reliable. Support took a week to answer a licensing question.',
      3,
      2,
      '2026-09-24T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: reply(
      2,
      'pending',
      'Thank you for the detail. Licensing questions now go to a dedicated queue with a two-day target.',
    ),
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      3,
      'The best clash tool we have used',
      'Setup took an afternoon. Our trades picked it up without training.',
      5,
      5,
      '2026-09-18T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: reply(
      3,
      'published',
      'Thank you. The afternoon setup is what we aim for.\nRelease 4.2 adds saved clash sets, which several teams asked for.',
      { published_at: '2026-09-21T12:00:00.000Z', moderated_at: '2026-09-21T12:00:00.000Z' },
    ),
    other_responses: [
      {
        vendor_slug: 'northwind-estimating',
        vendor_name: 'Northwind Estimating',
        body: 'Glad the quantities flow through cleanly. The connector is maintained by our team.',
        published_at: '2026-09-20T12:00:00.000Z',
      },
    ],
    can_reply: true,
  },
  {
    review: review(
      4,
      'Licensing is confusing',
      'We were billed for seats we did not use.',
      2,
      2,
      '2026-09-12T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: reply(
      4,
      'rejected',
      'Please call our sales team at 555-0100 and we will make this right if you update your review.',
      {
        rejection_reason:
          'The reply asks the reviewer to change the review and moves the conversation off the page.',
        moderated_at: '2026-09-14T12:00:00.000Z',
      },
    ),
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      5,
      'Works, with a learning curve',
      'Took our team a month to trust the clash rules.',
      4,
      3,
      '2026-09-08T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: reply(5, 'withdrawn', 'We now ship a starter rule set for new teams.'),
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      6,
      'Stopped syncing for a week',
      'The sync to our authoring tool failed silently for a week.',
      1,
      2,
      '2026-09-02T09:00:00.000Z',
    ),
    product: PRIMARY,
    response: reply(6, 'removed', 'This reviewer is clearly from a competitor.', {
      rejection_reason: 'The reply guesses at who the reviewer is.',
      moderated_at: '2026-09-05T12:00:00.000Z',
    }),
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      7,
      'Field issues sync both ways',
      'Issues raised on site show up in the model the same day.',
      5,
      4,
      '2026-09-26T09:00:00.000Z',
    ),
    product: SECONDARY,
    response: null,
    other_responses: [],
    can_reply: true,
  },
  {
    review: review(
      8,
      'Photos upload slowly on site',
      'On a weak signal the photo upload stalls.',
      3,
      4,
      '2026-09-16T09:00:00.000Z',
    ),
    product: SECONDARY,
    response: null,
    other_responses: [],
    can_reply: true,
  },
];
