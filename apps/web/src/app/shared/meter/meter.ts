import {
  Component,
  ChangeDetectionStrategy,
  booleanAttribute,
  computed,
  effect,
  isDevMode,
  input,
} from '@angular/core';

/** `forest` is the one hue. `onboarding` is Clay deep, allowed only for the onboarding series. */
export type MeterTone = 'forest' | 'onboarding';

/** `inline` is label, bar and number on one row. `stacked` is the bar over its text (the load bar). */
export type MeterLayout = 'inline' | 'stacked';

/**
 * `aec-meter` (AECI-1767; DESIGN.md §5 Meter, clash 19).
 *
 * The one public bar meter. A horizontal bar, one hue, no gradient, no
 * animation. The number is always printed beside the bar as text, so the bar is
 * a second way to read it and never the only one.
 *
 * Accessibility is the plain pattern, not `role="meter"` (which JAWS, VoiceOver
 * on iOS, NVDA and TalkBack do not read reliably). The label and the number are
 * real text in the accessibility tree. The bar is `aria-hidden`. There is no
 * `aria-value*`.
 *
 *   - `label`: the meter's own visible name. Rendered before the bar.
 *   - `labelledBy`: an element id. For a caller whose own heading already names
 *     the score. The meter renders no label of its own and becomes a labelled
 *     group, so the heading names it.
 *   - `decorative`: hides the whole meter from assistive tech. For a block that
 *     already prints the number as text (the reviews band).
 *
 * The `onboarding` tone is Clay deep and always has a visible name, its own or
 * the caller's, so the colour is never the only cue (clash 4). A meter with no
 * name and not decorative logs an error in dev mode.
 *
 * Presentation only. The component never computes, rounds or thresholds a
 * score: the caller passes the value and, when it wants other wording, the
 * printed text. The bar clamps to the range. A value outside it logs an error in
 * dev mode.
 *
 * The CSS lives here, not in `styles.css`, so no page pays for it until it uses
 * the meter. In forced-colours mode the track takes a system edge and the fill
 * `Highlight`.
 */
@Component({
  selector: 'aec-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
    '[attr.aria-hidden]': "decorative() ? 'true' : null",
    '[attr.role]': "labelledBy() && !decorative() ? 'group' : null",
    '[attr.aria-labelledby]': 'labelledBy() && !decorative() ? labelledBy() : null',
  },
  template: `
    @if (showLabel()) {
      <span class="text-t-14 basis-full text-(--text-secondary)">{{ label() }}</span>
    }
    <span class="aec-meter-track min-w-24 flex-1" aria-hidden="true">
      <span class="aec-meter-fill" [attr.data-tone]="tone()" [style.width.%]="percent()"></span>
    </span>
    <span class="text-t-14 tabular-nums text-(--text-primary)">{{ printed() }}</span>
  `,
  styles: `
    .aec-meter-track {
      display: block;
      height: 0.375rem;
      border-radius: var(--radius-pill);
      background-color: var(--surface-sunken);
      overflow: hidden;
    }
    .aec-meter-fill {
      display: block;
      height: 100%;
      border-radius: var(--radius-pill);
      background-color: var(--accent-primary);
    }
    .aec-meter-fill[data-tone='onboarding'] {
      background-color: var(--accent-secondary-deep);
    }
    /* Forced colours replaces background colours, which would erase the bar. Opt
       out and paint system colours: a Canvas track with a text edge, a Highlight
       fill. */
    @media (forced-colors: active) {
      .aec-meter-track {
        forced-color-adjust: none;
        background-color: Canvas;
        outline: 1px solid CanvasText;
      }
      .aec-meter-fill {
        forced-color-adjust: none;
        background-color: Highlight;
      }
    }
  `,
})
export class AecMeter {
  /** The value the bar stands for. */
  readonly value = input.required<number>();
  readonly min = input(0);
  readonly max = input(100);
  /** The meter's own visible name, for example "Product quality". */
  readonly label = input<string>('');
  /** An element id: the caller's own heading names the score, so no label renders here. */
  readonly labelledBy = input<string | null>(null);
  /** Hide the whole meter from assistive tech: the same block already prints the number. */
  readonly decorative = input(false, { transform: booleanAttribute });
  /** The printed number. Defaults to the value as given, never rounded here. */
  readonly text = input<string | null>(null);
  readonly tone = input<MeterTone>('forest');
  readonly layout = input<MeterLayout>('inline');

  protected readonly printed = computed(() => this.text() ?? String(this.value()));
  /** Own label renders when there is one and the caller's heading is not the name. */
  protected readonly showLabel = computed(() => !this.labelledBy() && this.label() !== '');
  protected readonly hostClass = computed(() =>
    this.layout() === 'stacked'
      ? 'flex w-full max-w-[260px] flex-col items-stretch gap-3 text-center'
      : 'flex flex-wrap items-center gap-x-3 gap-y-1',
  );
  protected readonly percent = computed(() => {
    const span = this.max() - this.min();
    return span > 0 ? ((this.clamp(this.value()) - this.min()) / span) * 100 : 0;
  });

  constructor() {
    if (!isDevMode()) return;
    effect(() => {
      const v = this.value();
      if (!Number.isFinite(v) || v < this.min() || v > this.max()) {
        console.error(
          `aec-meter: value ${v} is outside ${this.min()} to ${this.max()}. The bar is clamped.`,
        );
      }
    });
    effect(() => {
      const named = this.label() !== '' || !!this.labelledBy();
      if (!named && !this.decorative()) {
        console.error('aec-meter: set label or labelledBy, or mark it decorative.');
      }
      if (!named && this.tone() === 'onboarding') {
        console.error('aec-meter: the onboarding tone needs a visible name (label or labelledBy).');
      }
    });
  }

  private clamp(v: number): number {
    if (!Number.isFinite(v)) return this.min();
    return Math.min(Math.max(v, this.min()), this.max());
  }
}
