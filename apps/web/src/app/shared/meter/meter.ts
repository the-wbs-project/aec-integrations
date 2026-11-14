import {
  Component,
  ChangeDetectionStrategy,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';

/** `forest` is the one hue. `onboarding` is Clay deep, allowed only for the onboarding series. */
export type MeterTone = 'forest' | 'onboarding';

/**
 * `aec-meter` (AECI-1767; DESIGN.md §5 Meter, clash 19).
 *
 * The one public bar meter. A horizontal bar, one hue, no gradient, no
 * animation. The number is always printed beside the bar as text, so the bar is
 * a second way to read it and never the only one.
 *
 * Accessibility follows the WAI-ARIA meter pattern (DESIGN.md left the form open):
 * the host is `role="meter"` with `aria-valuemin`, `aria-valuemax`,
 * `aria-valuenow`, an accessible name (`label`) and `aria-valuetext` set to the
 * printed text. Chromium still exposes a meter's text children, so a screen
 * reader would hear the number twice. The visible label and number are
 * `aria-hidden` for that reason: the meter alone carries both. They stay in the
 * DOM as text for sighted readers and for every non-AT consumer.
 *
 * `onboarding` paints Clay deep and always shows the visible label, so the
 * colour is never the only cue (clash 4). The fill is 6px high with a pill end.
 * In forced-colours mode the track takes a system edge and the fill `Highlight`
 * (`styles.css`, `.aec-meter-*`).
 *
 * Presentation only. The component never computes, rounds or thresholds a score:
 * the caller passes the value and, when it wants other wording, the printed text.
 */
@Component({
  selector: 'aec-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-wrap items-center gap-x-3 gap-y-1',
    role: 'meter',
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'now()',
    '[attr.aria-valuetext]': 'printed()',
  },
  template: `
    @if (labelVisible()) {
      <span class="text-t-14 basis-full text-(--text-secondary)" aria-hidden="true">{{
        label()
      }}</span>
    }
    <span class="aec-meter-track min-w-24 flex-1" aria-hidden="true">
      <span class="aec-meter-fill" [attr.data-tone]="tone()" [style.width.%]="percent()"></span>
    </span>
    <span class="text-t-14 tabular-nums text-(--text-primary)" aria-hidden="true">{{
      printed()
    }}</span>
  `,
})
export class AecMeter {
  /** The value the bar stands for. */
  readonly value = input.required<number>();
  readonly min = input(0);
  readonly max = input(100);
  /** The accessible name, for example "Product quality". */
  readonly label = input.required<string>();
  /** The printed number. Defaults to the value as given, never rounded here. */
  readonly text = input<string | null>(null);
  readonly tone = input<MeterTone>('forest');
  /** Show the label as text before the bar. Always on for the onboarding tone. */
  readonly showLabel = input(false, { transform: booleanAttribute });

  protected readonly now = computed(() => this.clamp(this.value()));
  protected readonly printed = computed(() => this.text() ?? String(this.value()));
  protected readonly labelVisible = computed(
    () => this.showLabel() || this.tone() === 'onboarding',
  );
  protected readonly percent = computed(() => {
    const span = this.max() - this.min();
    return span > 0 ? ((this.now() - this.min()) / span) * 100 : 0;
  });

  private clamp(v: number): number {
    if (!Number.isFinite(v)) return this.min();
    return Math.min(Math.max(v, this.min()), this.max());
  }
}
