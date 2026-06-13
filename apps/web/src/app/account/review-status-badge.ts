import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ReviewStatus } from '@aeci/shared';

/**
 * Status pill for a review in the signed-in user's own list (`/account`,
 * AECI-225). Communicates where each review stands in moderation: `pending`
 * (awaiting review), `approved` (live), `rejected` (declined — paired with the
 * reason in the parent card).
 *
 * Bordered chip, not a fill (DESIGN.md "Borders-Not-Shadows"); sentence case.
 * Status is conveyed by a tinted border + text token AND the text label itself —
 * never colour alone (WCAG 1.4.1). Light theme only (Stage 1 / AECI-226). The
 * accent ramp carries `approved`; `rejected` borrows the same danger treatment
 * the destructive account actions use; `pending` is the neutral chip.
 */
@Component({
  selector: 'aec-review-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]"
      [class]="toneClass()"
      >{{ label() }}</span
    >
  `,
})
export class ReviewStatusBadge {
  readonly status = input.required<ReviewStatus>();

  protected readonly label = computed<string>(() => {
    switch (this.status()) {
      case 'approved':
        return $localize`:@@account.reviews.status.approved:Approved`;
      case 'rejected':
        return $localize`:@@account.reviews.status.rejected:Not published`;
      default:
        return $localize`:@@account.reviews.status.pending:Pending review`;
    }
  });

  protected readonly toneClass = computed<string>(() => {
    switch (this.status()) {
      case 'approved':
        return 'border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)';
      case 'rejected':
        return 'border-(--border-strong) bg-(--surface-raised) text-(--text-primary)';
      default:
        return 'border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)';
    }
  });
}
