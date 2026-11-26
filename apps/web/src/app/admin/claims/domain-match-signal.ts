import { Component, computed, input } from '@angular/core';

import { AecIcon } from '../../shared/icon/icon';

/**
 * The "Email domain" verification signal. Shared by `/admin/claims` and
 * `/admin/claims/:id` so the two screens show one claim the same way.
 *
 * A mismatch is a red X on red text, a match is a Forest check on primary text,
 * and the two undecided values stay plain. The words carry the meaning, so the
 * icons are hidden from a screen reader. Light only.
 */
@Component({
  selector: 'aec-domain-match-signal',
  imports: [AecIcon],
  template: `
    <span
      class="inline-flex items-center gap-2 text-t-14 font-semibold"
      [class.text-(--status-error)]="value() === 'no_match'"
      [class.text-(--text-primary)]="value() !== 'no_match'"
      data-testid="domain-match-signal"
    >
      @if (value() === 'no_match') {
        <span class="inline-flex shrink-0" data-testid="domain-match-x"
          ><aec-icon name="x" decorative [size]="4"
        /></span>
      } @else if (value() === 'match') {
        <span class="inline-flex shrink-0 text-(--accent-primary)" data-testid="domain-match-check"
          ><aec-icon name="check" decorative [size]="4"
        /></span>
      }
      {{ label() }}
    </span>
  `,
})
export class DomainMatchSignal {
  readonly value = input.required<string>();

  protected readonly label = computed(() => {
    switch (this.value()) {
      case 'match':
        return $localize`:@@admin.claims.domain.match:Domain matches`;
      case 'no_match':
        return $localize`:@@admin.claims.domain.noMatch:Domain mismatch`;
      case 'manual_review':
        return $localize`:@@admin.claims.domain.manualReview:Manual review`;
      default:
        return $localize`:@@admin.claims.domain.pending:Domain check pending`;
    }
  });
}
