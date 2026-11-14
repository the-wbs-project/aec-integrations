import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core';

/**
 * `aec-figure` (AECI-1767; DESIGN.md §3 Figure, §5 Score Display and
 * Integration stat, clashes 8 and 25).
 *
 * One large number: Source Serif 600 in Forest at `--t-fig` (28 to 40px),
 * with a label and optional supporting text. One per band.
 *
 * A zero is honest, never hidden. It renders only with supporting text in the
 * same block (clash 25). At zero the numeral is `aria-hidden` and the `label`
 * is the sentence, so a screen reader hears it once. The caller passes the
 * legal-reviewed words as `label` and `support` (PLAN.md section 5.2). A zero
 * with no `support` renders nothing, because a bare 0 is never allowed. Project
 * content (a "Know of one?" link) goes after the text.
 *
 * Presentation only: the value is printed as given.
 */
@Component({
  selector: 'aec-figure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.hidden]': '!renders()' },
  template: `
    @if (renders()) {
      <div class="flex flex-col gap-1">
        <span
          class="aec-figure-value font-display text-t-fig font-semibold tracking-[-0.01em] tabular-nums text-(--accent-primary)"
          [attr.aria-hidden]="isZero() ? 'true' : null"
          >{{ value() }}</span
        >
        <p class="text-t-16 text-(--text-primary)">{{ label() }}</p>
        @if (support(); as s) {
          <p class="text-t-14 text-(--text-secondary)">{{ s }}</p>
        }
        <ng-content />
      </div>
    }
  `,
})
export class AecFigure {
  readonly value = input.required<number>();
  /** What the number counts. At zero, the whole honest sentence. */
  readonly label = input.required<string>();
  /** The supporting text. Required in practice at zero. */
  readonly support = input<string | null>(null);

  protected readonly isZero = computed(() => this.value() === 0);
  protected readonly renders = computed(() => !this.isZero() || !!this.support());
}
