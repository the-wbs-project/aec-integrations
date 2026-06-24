import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core';

/**
 * AECI-201 — read-only star rating display for the product reviews section
 * (summary averages + individual review cards). Display-only: no listbox, no
 * selection, no keyboard interaction (that's the review *form*,
 * `reviews/review-form.html`). The five glyphs are decorative
 * (`aria-hidden`); the exact value is announced once via `role="img"` +
 * `aria-label` so assistive tech reads "Overall rating 4.3 out of 5" rather
 * than five separate stars.
 *
 * `rating` accepts decimals (the denormalized averages, e.g. 4.3) as well as
 * the integer per-review ratings; the glyphs round to the nearest whole star
 * while the label carries the precise value. Filled stars use `--accent-rating`
 * (Goldenrod #DAA520 — the gold-star fill); empty use `--border-strong` (a faint
 * light-gray track). Both are decorative (aria-hidden), so the AA small-text /
 * 3:1 graphic-contrast rules do not apply — the precise value is announced via
 * the `aria-label` and shown as the adjacent numeral.
 */
@Component({
  selector: 'aec-review-stars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <span class="inline-flex gap-0.5 leading-none" role="img" [attr.aria-label]="ariaLabel()">
      @for (n of positions; track n) {
        <span
          aria-hidden="true"
          class="text-sm"
          [style.color]="n <= filled() ? 'var(--accent-rating)' : 'var(--border-strong)'"
          >★</span
        >
      }
    </span>
  `,
})
export class ReviewStars {
  /** Rating to display, 1–5 (decimals allowed for averages). */
  readonly rating = input.required<number>();
  /** Which rating axis this is — drives the localized accessible label. */
  readonly kind = input.required<'overall' | 'onboarding'>();

  protected readonly positions = [1, 2, 3, 4, 5] as const;
  protected readonly filled = computed(() => Math.round(this.rating()));

  protected readonly ariaLabel = computed(() => {
    const value = this.format(this.rating());
    return this.kind() === 'overall'
      ? $localize`:@@products.detail.reviews.stars.overall:Overall rating ${value}:VALUE: out of 5`
      : $localize`:@@products.detail.reviews.stars.onboarding:Onboarding rating ${value}:VALUE: out of 5`;
  });

  private format(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}
