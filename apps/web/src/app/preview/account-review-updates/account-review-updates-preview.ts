import { Component, Injectable } from '@angular/core';

import type {
  AccountReview,
  SubmitReviewUpdateInput,
  SubmitReviewUpdateResponse,
} from '@aeci/shared';

import { AccountApi } from '../../account/account-api';
import { ReviewUpdatePanel } from '../../account/review-update-panel';

/**
 * AECI-1613: the `/account` "Your reviews" update panel over synthetic rows and a
 * component-provided fake of {@link AccountApi}, so the form, the update list and
 * every badge can be reviewed and axe-scanned without a signed-in session.
 * Dev-only, like every `/preview` route. Submits resolve locally and write nothing.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const REVIEWS: readonly AccountReview[] = [
  {
    id: uuid(701),
    product: { id: uuid(10), name: 'Dynamo for Revit', slug: 'dynamo-for-revit' },
    rating_overall: 2,
    rating_onboarding: 2,
    title: 'Graphs broke on every Revit upgrade',
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-08-20T09:00:00.000Z',
    updates: [
      {
        id: uuid(801),
        status: 'rejected',
        body: 'The vendor sent me a gift card to update this review, so here is my update.',
        rating_overall: 5,
        rating_onboarding: 5,
        rejection_reason: 'An update may not follow an incentive from the vendor.',
        published_at: null,
        moderated_at: '2026-09-02T10:00:00.000Z',
        created_at: '2026-09-01T09:00:00.000Z',
      },
      {
        id: uuid(802),
        status: 'approved',
        body: 'Dynamo 3.2 fixed the upgrade breakage for us.\nOur graphs came through the last two Revit releases with no rework.',
        rating_overall: 4,
        rating_onboarding: 4,
        rejection_reason: null,
        published_at: '2026-09-20T10:00:00.000Z',
        moderated_at: '2026-09-20T10:00:00.000Z',
        created_at: '2026-09-19T09:00:00.000Z',
      },
    ],
  },
  {
    id: uuid(702),
    product: { id: uuid(11), name: 'Procore', slug: 'procore' },
    rating_overall: 3,
    rating_onboarding: 3,
    title: 'Fine for small teams',
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-08-21T09:00:00.000Z',
    updates: [
      {
        id: uuid(803),
        status: 'pending',
        body: 'The 3.2 release made large graphs much faster. We now run our whole workflow in one graph.',
        rating_overall: null,
        rating_onboarding: null,
        rejection_reason: null,
        published_at: null,
        moderated_at: null,
        created_at: '2026-10-01T09:00:00.000Z',
      },
    ],
  },
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAccountApi extends AccountApi {
  override async submitReviewUpdate(
    _reviewId: string,
    input: SubmitReviewUpdateInput,
  ): Promise<SubmitReviewUpdateResponse> {
    return {
      update: {
        id: uuid(899),
        status: 'pending',
        body: input.body,
        rating_overall: input.rating_overall ?? null,
        rating_onboarding: input.rating_onboarding ?? null,
        rejection_reason: null,
        published_at: null,
        moderated_at: null,
        created_at: new Date().toISOString(),
      },
    };
  }
}

@Component({
  selector: 'app-account-review-updates-preview',
  imports: [ReviewUpdatePanel],
  providers: [{ provide: AccountApi, useClass: PreviewAccountApi }],
  template: `
    <div class="mx-auto max-w-3xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.accountReviewUpdates.heading"
      >
        Account: review updates (preview)
      </h1>
      <ul class="divide-y divide-(--border-default) border-t border-(--border-default)">
        @for (r of reviews; track r.id) {
          <li class="py-4">
            <p class="text-sm font-medium text-(--text-primary)">{{ r.product.name }}</p>
            <p class="text-sm text-(--text-secondary)">{{ r.title }}</p>
            <aec-review-update-panel [review]="r" />
          </li>
        }
      </ul>
    </div>
  `,
})
export class AccountReviewUpdatesPreview {
  protected readonly reviews = REVIEWS;
}
