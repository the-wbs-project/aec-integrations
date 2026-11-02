import { Component, computed, input } from '@angular/core';

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
  template: `
    <span
      class="inline-flex items-center gap-1.5 text-xs font-bold"
      [class.text-(--status-error)]="value() === 'no_match'"
      [class.text-(--text-primary)]="value() !== 'no_match'"
      data-testid="domain-match-signal"
    >
      @if (value() === 'no_match') {
        <svg
          class="size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          data-testid="domain-match-x"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      } @else if (value() === 'match') {
        <svg
          class="size-4 shrink-0 text-(--accent-primary)"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          data-testid="domain-match-check"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
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
