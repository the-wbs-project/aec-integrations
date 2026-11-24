import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
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
 *
 * The rest are the console's status tones ({@link ConsoleChipTone}).
 */
export type ChipTone =
  | 'neutral'
  | 'quiet'
  | 'sunken'
  | 'strong'
  | 'strong-sunken'
  | 'forest'
  | 'wash'
  | 'error'
  | ConsoleChipTone;

/**
 * The seven status tones of the admin console (AECI-1813, mock-up 14's legend).
 * Words always carry the state, so a tone is never the only signal. Contrast of
 * the text on its own fill:
 *
 * | Tone        | Look                                                    | Ratio   |
 * |-------------|---------------------------------------------------------|---------|
 * | `count`     | Forest fill, white text. A queue count, not a status    | 12.34:1 |
 * | `neutral`   | Raised fill, default edge, primary ink. A fact          | 18.97:1 |
 * | `waiting`   | White fill, strong edge, primary ink, a hollow ring     | 19.80:1 |
 * | `positive`  | Forest-soft fill, Forest edge and ink. Live or done     | 10.80:1 |
 * | `quiet`     | Raised fill, default edge, secondary ink. Closed        |  7.41:1 |
 * | `attention` | Raised fill, strong edge, Clay-deep ink. Look first     |  5.59:1 |
 * | `critical`  | White fill, error edge and ink. A fault. The only red   |  6.54:1 |
 *
 * `neutral` and `quiet` are the ladder's own steps. `positive` draws as `wash` and
 * `critical` as `error`. Which status takes which tone is one map:
 * `ADMIN_STATUS_TONES` in `admin/console/status-tones.ts`.
 */
export type ConsoleChipTone =
  | 'count'
  | 'neutral'
  | 'waiting'
  | 'positive'
  | 'quiet'
  | 'attention'
  | 'critical';

/**
 * `aec-chip` (AECI-1763; DESIGN.md §5 Badges, "The public chip", clash 22).
 *
 * The one chip recipe. The look lives in `styles.css` under `.aec-chip`, which is
 * unlayered. It was written while a `border-color` utility never reached an
 * element (the `*` rule won, until AECI-2088). This component only chooses the element and sets the data
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
        [disabled]="disabled()"
        (click)="activate()"
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
  // The four console tones the ladder lacks (AECI-1813). The ladder lives in
  // `styles.css`; these sit here so the chip stays the only file that owns its
  // tones. They set colour and edge only, so density still sets the size. The
  // count is the exception: a fixed 24px pill with tabular figures.
  styles: `
    :host {
      display: inline-flex;
      max-width: 100%;
    }
    .aec-chip[data-tone='positive'] {
      border-color: var(--accent-primary);
      background-color: var(--accent-primary-soft);
      color: var(--accent-primary);
    }
    .aec-chip[data-tone='critical'] {
      border-color: var(--status-error);
      background-color: var(--surface-base);
      color: var(--status-error);
    }
    .aec-chip[data-tone='waiting'] {
      gap: 0.5rem;
      border-color: var(--border-strong);
      background-color: var(--surface-base);
      color: var(--text-primary);
    }
    .aec-chip[data-tone='waiting']::before {
      content: '';
      flex: none;
      width: 0.5rem;
      height: 0.5rem;
      border: 2px solid var(--text-secondary);
      border-radius: 50%;
    }
    .aec-chip[data-tone='attention'] {
      border-color: var(--border-strong);
      background-color: var(--surface-raised);
      color: var(--accent-secondary-deep);
    }
    .aec-chip[data-tone='count'] {
      justify-content: center;
      min-width: 1.5rem;
      height: 1.5rem;
      padding: 0 0.5rem;
      border-color: transparent;
      background-color: var(--accent-primary);
      color: var(--surface-base);
      font-size: var(--t-13);
      font-weight: 600;
      line-height: 1;
      font-variant-numeric: tabular-nums;
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

  /**
   * A filter chip that would leave no rows (AECI-1783, ruled 2026-11-16). A native
   * `disabled`, so it cannot be pressed and leaves the tab order. The caller keeps a
   * pressed chip enabled, so the reader can always release it. Only a filter chip reads it.
   */
  readonly disabled = input(false, { transform: booleanAttribute });

  /** Fires when a filter chip (a `selected` chip) is clicked. */
  readonly activated = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /**
   * Emit, then keep the reader's place. Releasing a chip whose count is 0 disables it
   * (AECI-1783), and a native `disabled` drops focus to the page body. When that
   * happens the chip's `role="group"` takes focus (`tabindex="-1"`, set only then), so a keyboard reader stays in the
   * same chip row and Tab moves on from there.
   */
  protected activate(): void {
    this.activated.emit();
    afterNextRender(
      () => {
        const button = this.host.nativeElement.querySelector('button');
        if (!button?.disabled) return;
        // Chrome moves focus to the body; another engine may leave it on the dead button.
        const active = button.ownerDocument.activeElement;
        if (active !== button && active !== button.ownerDocument.body) return;
        const group = this.host.nativeElement.closest<HTMLElement>('[role="group"]');
        if (!group) return;
        if (!group.hasAttribute('tabindex')) group.setAttribute('tabindex', '-1');
        group.focus();
      },
      { injector: this.injector },
    );
  }

  protected readonly face = computed(() => (this.label() ? 'label' : null));
  protected readonly hasIcon = computed(() =>
    this.icon() !== null || this.selected() === true ? '' : null,
  );
  protected readonly effectiveTone = computed<ChipTone | null>(() =>
    this.selected() === true ? 'wash' : this.tone(),
  );
}
