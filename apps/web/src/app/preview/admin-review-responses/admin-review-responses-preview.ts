import { Component, Injectable } from '@angular/core';

import type {
  AdminReviewResponse,
  DecideReviewResponseInput,
  ListAdminReviewResponsesQuery,
  ListAdminReviewResponsesResponse,
} from '@aeci/shared';

import { AdminReviewResponsesApi } from '../../admin/review-responses/admin-review-responses-api';
import { ReviewResponseQueue } from '../../admin/review-responses/review-response-queue';

/**
 * AECI-1177 — the `/admin/review-responses` queue, fed synthetic rows through a
 * component-provided fake of {@link AdminReviewResponsesApi}, so every card state
 * and the reason form can be reviewed, axe-scanned and `impeccable detect`-ed
 * without an admin session (the real route is behind the SSR admin gate, which a
 * dev server cannot pass without minting a real session).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). Decisions resolve locally and write nothing. The fake
 * takes the real request shape, `expected_updated_at` included, and never answers
 * `409 REVIEW_RESPONSE_CHANGED`: no vendor edits a synthetic row.
 */
const DAY = 86_400_000;
const days = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const REVIEW: AdminReviewResponse['review'] = {
  id: uuid(30),
  status: 'approved',
  title: 'Great for scripting, rough on large models',
  body: 'Dynamo saves us hours on repetitive tagging. On models over 2 GB the graph stalls, and we had to split the work by level.',
  rating_overall: 4,
  rating_onboarding: 3,
  created_at: days(-20),
};

function reply(over: Partial<AdminReviewResponse> & { id: string }): AdminReviewResponse {
  return {
    status: 'pending',
    body: 'Thank you for the detailed review.\nThe large-model stall was fixed in Dynamo 3.2, which ships with Revit 2026.1. If you still see it, the release notes list a workaround.',
    rejection_reason: null,
    vendor: { id: uuid(1), slug: 'autodesk', name: 'Autodesk' },
    vendor_owns_product: true,
    author_email: 'product-team@autodesk.example',
    product: { id: uuid(10), slug: 'dynamo-for-revit', name: 'Dynamo for Revit', logo_url: null },
    review: REVIEW,
    moderated_at: null,
    published_at: null,
    created_at: days(-3),
    updated_at: days(-2),
    ...over,
  };
}

const REPLIES: readonly AdminReviewResponse[] = [
  reply({ id: uuid(501) }),
  reply({
    id: uuid(502),
    vendor: { id: uuid(2), slug: 'bentley', name: 'Bentley Systems' },
    vendor_owns_product: false,
    author_email: null,
    body: 'We are sorry to hear that. Our team would like to help.',
    updated_at: days(-1),
  }),
  reply({
    id: uuid(503),
    status: 'published',
    published_at: days(-5),
    moderated_at: days(-5),
  }),
  reply({
    id: uuid(504),
    status: 'rejected',
    rejection_reason: 'The reply guesses at who the reviewer is. Remove the name and resubmit.',
    moderated_at: days(-4),
  }),
  reply({ id: uuid(505), status: 'withdrawn' }),
  reply({
    id: uuid(506),
    status: 'removed',
    rejection_reason: 'The reply asks the reviewer to contact sales and change their rating.',
    moderated_at: days(-6),
  }),
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminReviewResponsesApi extends AdminReviewResponsesApi {
  override async listReplies(
    query: Partial<ListAdminReviewResponsesQuery> = {},
  ): Promise<ListAdminReviewResponsesResponse> {
    const rows = REPLIES.filter((r) => r.status === (query.status ?? 'pending'));
    return { data: structuredClone([...rows]), page: 1, perPage: 100, total: rows.length };
  }
  override async decide(
    id: string,
    input: DecideReviewResponseInput,
  ): Promise<AdminReviewResponse> {
    const row = REPLIES.find((r) => r.id === id) ?? reply({ id });
    return {
      ...row,
      status:
        input.decision === 'approve'
          ? 'published'
          : input.decision === 'reject'
            ? 'rejected'
            : 'removed',
      rejection_reason: input.decision === 'approve' ? null : input.reason,
    };
  }
}

@Component({
  selector: 'app-admin-review-responses-preview',
  imports: [ReviewResponseQueue],
  providers: [{ provide: AdminReviewResponsesApi, useClass: PreviewAdminReviewResponsesApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminReviewResponses.heading"
      >
        Admin: review replies (preview)
      </h1>
      <aec-review-response-queue />
    </div>
  `,
})
export class AdminReviewResponsesPreview {}
