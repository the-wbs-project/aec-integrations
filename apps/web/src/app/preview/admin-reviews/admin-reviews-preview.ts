import { Component, Injectable } from '@angular/core';

import type {
  AdminReview,
  ListPendingReviewsQuery,
  ListPendingReviewsResponse,
  ModerateReviewInput,
  ModerateReviewResponse,
} from '@aeci/shared';

import { AdminReviewsApi } from '../../admin/reviews/admin-reviews-api';
import { ReviewQueue } from '../../admin/reviews/review-queue';

/**
 * AECI-1643: the `/admin/reviews` queue, fed synthetic rows through a
 * component-provided fake of {@link AdminReviewsApi}, so every status tab, the
 * remove form and its confirm can be reviewed and axe-scanned without an admin
 * session (the real route is behind the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). Decisions resolve locally and write nothing.
 */
const DAY = 86_400_000;
const days = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function review(over: Partial<AdminReview> & { id: string }): AdminReview {
  return {
    product: { id: uuid(10), slug: 'dynamo-for-revit', name: 'Dynamo for Revit' },
    reviewer_email: 'reviewer@firm.example',
    reviewer_firm: null,
    rating_overall: 4,
    rating_onboarding: 3,
    title: 'Great for scripting, rough on large models',
    body: 'Dynamo saves us hours on repetitive tagging. On models over 2 GB the graph stalls, and we had to split the work by level.',
    role_at_company: 'practitioner',
    years_using: 3,
    would_recommend: 'yes',
    locale: 'en-US',
    status: 'pending',
    toxicity_score: 6,
    rejection_reason: null,
    moderated_at: null,
    removed_at: null,
    removal_reason: null,
    created_at: days(-2),
    ...over,
  };
}

const REVIEWS: readonly AdminReview[] = [
  review({ id: uuid(701) }),
  review({ id: uuid(702), toxicity_score: 84, reviewer_email: null }),
  review({ id: uuid(703), status: 'approved', moderated_at: days(-20), created_at: days(-21) }),
  review({
    id: uuid(704),
    status: 'approved',
    product: { id: uuid(11), slug: 'bluebeam-revu', name: 'Bluebeam Revu' },
    moderated_at: days(-9),
    created_at: days(-10),
  }),
  review({
    id: uuid(705),
    status: 'rejected',
    rejection_reason: 'The review names a member of the vendor team.',
    moderated_at: days(-4),
  }),
  review({
    id: uuid(706),
    status: 'removed',
    moderated_at: days(-30),
    removed_at: days(-1),
    removal_reason: 'Written by an employee of a competing vendor.',
    created_at: days(-31),
  }),
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminReviewsApi extends AdminReviewsApi {
  override async listPending(
    query: Partial<ListPendingReviewsQuery> = {},
  ): Promise<ListPendingReviewsResponse> {
    const rows = REVIEWS.filter((r) => r.status === (query.status ?? 'pending'));
    return { data: structuredClone([...rows]), page: 1, perPage: 100, total: rows.length };
  }
  override async moderate(id: string, input: ModerateReviewInput): Promise<ModerateReviewResponse> {
    const row = REVIEWS.find((r) => r.id === id) ?? review({ id });
    const to =
      input.action === 'approve' ? 'approved' : input.action === 'reject' ? 'rejected' : 'removed';
    return { review: { ...row, status: to }, repeat_offender: null };
  }
}

@Component({
  selector: 'app-admin-reviews-preview',
  imports: [ReviewQueue],
  providers: [{ provide: AdminReviewsApi, useClass: PreviewAdminReviewsApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminReviews.heading"
      >
        Admin: reviews (preview)
      </h1>
      <aec-review-queue />
    </div>
  `,
})
export class AdminReviewsPreview {}
