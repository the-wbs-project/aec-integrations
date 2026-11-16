import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  isDevMode,
  input,
} from '@angular/core';

/** `forest` is the Forest numeral on a light ground. `on-brand` is for a Forest ground. */
export type FigureTone = 'forest' | 'on-brand';

/**
 * `fig` is the count figure at `--t-fig` (28 to 40px). `score` is the score figure
 * at a fixed `--t-48` (ruling A3, 2026-11-16), for the reviews band.
 */
export type FigureSize = 'fig' | 'score';

/**
 * The zero states the component owns. The words are fixed by legal review
 * (`PLAN.md` section 5.2, "Copy fixed by legal review") and live here, so no
 * caller passes its own.
 */
export type FigureZeroMode = 'integrations-not-on-record';

/**
 * The legal heading for a product with no integrations on record (`PLAN.md` §5.2). The
 * figure and the product page's zero-integration section (AECI-1786) both print it, so
 * one function owns the words and the one message id.
 */
export function integrationsZeroHeading(product: string): string {
  return $localize`:@@shared.figure.zero.integrations.heading:We have no integrations for ${product}:PRODUCT: on record`;
}

/** The legal caveat that always sits with `integrationsZeroHeading` (`PLAN.md` §5.2). */
export function integrationsZeroCaveat(): string {
  return $localize`:@@shared.figure.zero.integrations.caveat:Not on record means we have not found one. It is not proof that none exists.`;
}

/**
 * `aec-figure` (AECI-1767; DESIGN.md §3 Figure, §5 Score Display and
 * Integration stat, clashes 8 and 25).
 *
 * One large number: Source Serif 600 at `--t-fig` (28 to 40px), with a label and
 * optional supporting text. One per band, except the reviews band, which shows two
 * (ruling A4). `size="score"` sets a score figure at `--t-48` (48px, ruling A3).
 * Forest on a light ground, `on-brand` on a Forest ground.
 *
 * The component never rounds or formats. The caller passes the printed string as
 * `text` ("4.0", "12,345") and `suffix` (the small "/5"). `value` is read only to
 * detect zero.
 *
 * A zero is honest, never hidden, and the component owns its words. Set
 * `zero="integrations-not-on-record"` and `product`, and a zero renders the
 * legal heading "We have no integrations for {product} on record" and the
 * caveat "Not on record means we have not found one. It is not proof that none
 * exists." The numeral is `aria-hidden`, so a screen reader hears the sentence
 * once. Projected content (the "Know of one?" link) follows the text. A zero
 * with no zero mode logs an error in dev mode and, in production, renders as an
 * ordinary figure with the caller's `label` and `text`, never as nothing.
 */
@Component({
  selector: 'aec-figure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-1">
      @if (zeroState()) {
        <span class="aec-figure-value {{ numeralClass() }}" aria-hidden="true">{{ text() }}</span>
        <p class="text-t-16 {{ labelClass() }}">{{ zeroHeading() }}</p>
        <p class="text-t-14 {{ supportClass() }}">{{ zeroCaveat() }}</p>
      } @else {
        <span class="flex items-baseline gap-1">
          <span class="aec-figure-value {{ numeralClass() }}">{{ text() }}</span>
          @if (suffix(); as s) {
            <span class="aec-figure-suffix text-t-24 {{ supportClass() }}">{{ s }}</span>
          }
        </span>
        <p class="text-t-16 {{ labelClass() }}">{{ label() }}</p>
        @if (support(); as s) {
          <p class="text-t-14 {{ supportClass() }}">{{ s }}</p>
        }
      }
      <ng-content />
    </div>
  `,
})
export class AecFigure {
  /** Read only to detect zero. */
  readonly value = input.required<number>();
  /** The printed number, formatted by the caller. */
  readonly text = input.required<string>();
  /** A small suffix after the number, for example "/5". */
  readonly suffix = input<string | null>(null);
  /** What the number counts. */
  readonly label = input<string>('');
  /** Supporting text under the label, for a figure that is not zero. */
  readonly support = input<string | null>(null);
  readonly tone = input<FigureTone>('forest');
  /** `score` for a score figure at 48px. The default is the count figure at `--t-fig`. */
  readonly size = input<FigureSize>('fig');
  /** Opt in to the legal-reviewed zero state. */
  readonly zero = input<FigureZeroMode | null>(null);
  /** The product name for the zero heading. */
  readonly product = input<string | null>(null);

  protected readonly isZero = computed(() => this.value() === 0);
  protected readonly zeroState = computed(
    () => this.isZero() && this.zero() !== null && !!this.product(),
  );

  protected readonly zeroHeading = computed(() => integrationsZeroHeading(this.product() ?? ''));
  protected readonly zeroCaveat = computed(() => integrationsZeroCaveat());

  protected readonly numeralClass = computed(
    () =>
      'font-display font-semibold tracking-[-0.01em] tabular-nums ' +
      (this.size() === 'score' ? 'text-t-48 ' : 'text-t-fig ') +
      (this.tone() === 'on-brand' ? 'text-(--text-on-brand)' : 'text-(--accent-primary)'),
  );
  protected readonly labelClass = computed(() =>
    this.tone() === 'on-brand' ? 'text-(--text-on-brand-secondary)' : 'text-(--text-primary)',
  );
  protected readonly supportClass = computed(() =>
    this.tone() === 'on-brand' ? 'text-(--text-on-brand-secondary)' : 'text-(--text-secondary)',
  );

  constructor() {
    if (!isDevMode()) return;
    effect(() => {
      if (!this.isZero()) return;
      if (this.zero() === null) {
        console.error(
          'aec-figure: a zero needs a zero mode (zero="integrations-not-on-record"). A bare 0 is never allowed.',
        );
      } else if (!this.product()) {
        console.error('aec-figure: the zero heading needs the product name (product).');
      }
    });
  }
}
