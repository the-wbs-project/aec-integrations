import { Component, Injectable } from '@angular/core';

import type {
  AdminReviewUpdate,
  DecideReviewUpdateInput,
  ListAdminReviewUpdatesQuery,
  ListAdminReviewUpdatesResponse,
} from '@aeci/shared';

import { AdminReviewUpdatesApi } from '../../admin/review-updates/admin-review-updates-api';
import { ReviewUpdateQueue } from '../../admin/review-updates/review-update-queue';

/**
 * AECI-1613: the `/admin/review-updates` queue, fed synthetic rows through a
 * component-provided fake of {@link AdminReviewUpdatesApi}, so every card state
 * and the reason form can be reviewed and axe-scanned without an admin session
 * (the real route is behind the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). Decisions resolve locally and write nothing.
 */
const DAY = 86_400_000;
const days = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const REVIEW: AdminReviewUpdate['review'] = {
  id: uuid(30),
  status: 'approved',
  title: 'Great for scripting, rough on large models',
  body: 'Dynamo saves us hours on repetitive tagging. On models over 2 GB the graph stalls, and we had to split the work by level.',
  rating_overall: 3,
  rating_onboarding: 3,
  created_at: days(-60),
};

function update(over: Partial<AdminReviewUpdate> & { id: string }): AdminReviewUpdate {
  return {
    status: 'pending',
    body: 'Dynamo 3.2 fixed the large-model stall for us.\nWe now run the tagging graph on the whole model in one pass, so I am raising my rating.',
    rating_overall: 5,
    rating_onboarding: 4,
    rejection_reason: null,
    toxicity_score: 4,
    reviewer_email: 'reviewer@firm.example',
    product: { id: uuid(10), slug: 'dynamo-for-revit', name: 'Dynamo for Revit', logo_url: null },
    review: REVIEW,
    moderated_at: null,
    published_at: null,
    created_at: days(-2),
    updated_at: days(-2),
    ...over,
  };
}

const UPDATES: readonly AdminReviewUpdate[] = [
  update({ id: uuid(601) }),
  update({
    id: uuid(602),
    body: 'Support answered my ticket within a day this time. The rest of my review still stands.',
    rating_overall: null,
    rating_onboarding: null,
    toxicity_score: null,
    reviewer_email: null,
    review: { ...REVIEW, status: 'archived' },
  }),
  update({ id: uuid(603), toxicity_score: 82 }),
  update({
    id: uuid(604),
    status: 'approved',
    published_at: days(-5),
    moderated_at: days(-5),
  }),
  update({
    id: uuid(605),
    status: 'rejected',
    rejection_reason:
      'The update names a member of the vendor team. Remove the name and add it again.',
    moderated_at: days(-4),
  }),
  update({
    id: uuid(606),
    status: 'removed',
    rejection_reason: 'The update describes a different product.',
    moderated_at: days(-6),
  }),
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminReviewUpdatesApi extends AdminReviewUpdatesApi {
  override async listUpdates(
    query: Partial<ListAdminReviewUpdatesQuery> = {},
  ): Promise<ListAdminReviewUpdatesResponse> {
    const rows = UPDATES.filter((u) => u.status === (query.status ?? 'pending'));
    return { data: structuredClone([...rows]), page: 1, perPage: 100, total: rows.length };
  }
  override async decide(id: string, input: DecideReviewUpdateInput): Promise<AdminReviewUpdate> {
    const row = UPDATES.find((u) => u.id === id) ?? update({ id });
    return {
      ...row,
      status:
        input.action === 'approve'
          ? 'approved'
          : input.action === 'reject'
            ? 'rejected'
            : 'removed',
      rejection_reason: input.action === 'approve' ? null : input.reason,
    };
  }
}

@Component({
  selector: 'app-admin-review-updates-preview',
  imports: [ReviewUpdateQueue],
  providers: [{ provide: AdminReviewUpdatesApi, useClass: PreviewAdminReviewUpdatesApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminReviewUpdates.heading"
      >
        Admin: review updates (preview)
      </h1>
      <aec-review-update-queue />
    </div>
  `,
})
export class AdminReviewUpdatesPreview {}
