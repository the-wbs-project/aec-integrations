import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ReviewStatus, ReviewUpdateStatus } from '@aeci/shared';

import { Chip, type ChipTone } from '../shared/chip/chip';

/**
 * Status pill for a review in the signed-in user's own list (`/account`,
 * AECI-225). Communicates where each review stands in moderation: `pending`
 * (awaiting review), `approved` (live), `rejected` (declined — paired with the
 * reason in the parent card).
 *
 * A dense `aec-chip` (AECI-1763). Bordered, not a fill (DESIGN.md "Borders-Not-Shadows"); sentence case.
 * Status is conveyed by a tinted border + text token AND the text label itself —
 * never colour alone (WCAG 1.4.1). Light theme only (Stage 1 / AECI-226). The
 * accent ramp carries `approved`; `rejected` borrows the same danger treatment
 * the destructive account actions use; `pending` is the neutral chip.
 *
 * AECI-1613 reuses it for a reviewer's updates, whose statuses add `removed`
 * (taken off the product page by AECi). It wears the `rejected` treatment.
 * Since AECI-1643 a review can be `removed` too, with the same label: an `approved`
 * review AECi later took down. The parent card shows the reason.
 */
@Component({
  selector: 'aec-review-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Chip],
  template: ` <aec-chip density="dense" [tone]="tone()">{{ label() }}</aec-chip> `,
})
export class ReviewStatusBadge {
  readonly status = input.required<ReviewStatus | ReviewUpdateStatus>();

  protected readonly label = computed<string>(() => {
    switch (this.status()) {
      case 'approved':
        return $localize`:@@account.reviews.status.approved:Approved`;
      case 'rejected':
        return $localize`:@@account.reviews.status.rejected:Not published`;
      case 'removed':
        return $localize`:@@account.reviews.status.removed:Removed`;
      default:
        return $localize`:@@account.reviews.status.pending:Pending review`;
    }
  });

  protected readonly tone = computed<ChipTone>(() => {
    switch (this.status()) {
      case 'approved':
        return 'forest';
      case 'rejected':
      case 'removed':
        return 'strong';
      default:
        return 'sunken';
    }
  });
}
