import { NgTemplateOutlet } from '@angular/common';
import { Component, booleanAttribute, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecIcon } from '../icon/icon';
import type { AecIconName } from '../icon/icon-registry';

/** Row density. `default` is the public chip, `dense` sits inside a card or a table row. */
export type ChipDensity = 'default' | 'dense';

/**
 * The tonal ladder. `neutral` is the resting chip. `quiet` steps the text to
 * secondary. `sunken`, `strong` and `strong-sunken` are the quiet status steps.
 * `forest` is Forest text and edge on the raised ground. `wash` is the
 * Forest-soft fill with Forest text and a Forest edge (a selected filter chip,
 * or "Confirmed by both companies"). `error` is the one red.
 */
export type ChipTone =
  | 'neutral'
  | 'quiet'
  | 'sunken'
  | 'strong'
  | 'strong-sunken'
  | 'forest'
  | 'wash'
  | 'error';

/**
 * `aec-chip` (AECI-1763; DESIGN.md §5 Badges, "The public chip", clash 22).
 *
 * The one chip recipe. The look lives in `styles.css` under `.aec-chip`, which is
 * unlayered because a `border-color` utility never reaches an element (the `*`
 * rule wins). This component only chooses the element and sets the data
 * attributes the CSS keys off.
 *
 * Three elements, one look:
 *   - static (default): a `<span>`. It has no hover, no pointer and no focus
 *     stop, so it never looks clickable.
 *   - `link`: an `<a>` (a taxonomy chip). Hover takes a strong edge and Forest text.
 *   - `selected` set to `true` or `false`: a `<button aria-pressed>` (a filter chip).
 *     A selected one takes the Forest-soft wash, a Forest edge AND a tick, so
 *     selection is never colour alone (clash 5). `activated` fires on click.
 *
 * Interactive chips have a 24px minimum target (the rest height is about 31px)
 * and a 3px focus ring at 3px offset. In forced-colours mode a selected chip maps
 * to `Highlight` and `HighlightText`.
 *
 * Chips never take Clay and never take a shadow. Sentence case. Light theme only.
 */
@Component({
  selector: 'aec-chip',
  imports: [NgTemplateOutlet, RouterLink, AecIcon],
  template: `
    <ng-template #body>
      @if (selected() === true) {
        <aec-icon name="check" decorative [size]="3.5" />
      } @else if (icon(); as name) {
        <aec-icon [name]="name" decorative [size]="3.5" />
      }
      <ng-content />
    </ng-template>
    @if (link(); as target) {
      <a
        class="aec-chip"
        [routerLink]="target"
        [attr.aria-label]="ariaLabel()"
        [attr.data-density]="density()"
        [attr.data-tone]="effectiveTone()"
        [attr.data-face]="face()"
        [attr.data-icon]="hasIcon()"
      >
        <ng-container [ngTemplateOutlet]="body" />
      </a>
    } @else if (selected() !== null) {
      <button
        type="button"
        class="aec-chip"
        [attr.aria-pressed]="selected()"
        [attr.aria-label]="ariaLabel()"
        [attr.data-density]="density()"
        [attr.data-tone]="effectiveTone()"
        [attr.data-face]="face()"
        [attr.data-icon]="hasIcon()"
        (click)="activated.emit()"
      >
        <ng-container [ngTemplateOutlet]="body" />
      </button>
    } @else {
      <span
        class="aec-chip"
        [attr.aria-label]="ariaLabel()"
        [attr.data-density]="density()"
        [attr.data-tone]="effectiveTone()"
        [attr.data-face]="face()"
        [attr.data-icon]="hasIcon()"
      >
        <ng-container [ngTemplateOutlet]="body" />
      </span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      max-width: 100%;
    }
  `,
})
export class Chip {
  readonly density = input<ChipDensity>('default');
  /** Unset takes the density's own look: raised and bordered, or sunken with no edge. */
  readonly tone = input<ChipTone | null>(null);
  /** `true` or `false` makes a filter chip (a toggle button). `null` is not a toggle. */
  readonly selected = input<boolean | null>(null);
  /** Optional leading icon, 14px. A selected chip shows the tick in its place. */
  readonly icon = input<AecIconName | null>(null);
  /** A router target. Makes the chip a link. */
  readonly link = input<string | readonly unknown[] | null>(null);
  /** Explicit accessible name, when the visible text is not the whole name. */
  readonly ariaLabel = input<string | null>(null);
  /**
   * The 12px, weight 500 face that only the maintenance marker and the agreement
   * badge keep (DESIGN.md §3, §5). Nothing else sets it.
   */
  readonly label = input(false, { transform: booleanAttribute });

  /** Fires when a filter chip (a `selected` chip) is clicked. */
  readonly activated = output<void>();

  protected readonly face = computed(() => (this.label() ? 'label' : null));
  protected readonly hasIcon = computed(() =>
    this.icon() !== null || this.selected() === true ? '' : null,
  );
  protected readonly effectiveTone = computed<ChipTone | null>(() =>
    this.selected() === true ? 'wash' : this.tone(),
  );
}
