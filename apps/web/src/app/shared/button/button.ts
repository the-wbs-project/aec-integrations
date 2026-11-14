import {
  Directive,
  ElementRef,
  afterNextRender,
  booleanAttribute,
  computed,
  inject,
  input,
  isDevMode,
} from '@angular/core';

/**
 * The five button looks (DESIGN.md §5 "Buttons").
 *
 * - `primary`: Forest fill, white text. The surface's one main action.
 * - `on-brand`: Bone fill, Forest text. The main action on a Forest ground.
 * - `secondary`: raised fill, a 1px `--border-strong` edge.
 * - `ghost`: no fill, no visible edge. Tertiary actions in dense surfaces.
 * - `danger`: error fill, white text. A destructive action, always with a text label.
 *
 * Clay never fills a button (clash 3). No variant is a pill (clash 20).
 */
export type AecButtonVariant = 'primary' | 'on-brand' | 'secondary' | 'ghost' | 'danger';

export interface AecButtonOptions {
  /** 16px side padding instead of 24px. Same 44px height. Ghost is always compact. */
  readonly compact?: boolean;
  /** A 44 by 44px square for a lone icon. The caller gives it an accessible name. */
  readonly iconOnly?: boolean;
}

/**
 * Shared by every variant: 44px minimum height (a wrapped label grows it), 12px
 * radius, 14px label at 600, a 1px edge, no shadow. The edge colour comes from the
 * unlayered `.aec-btn` and `.aec-btn-secondary` rules in `styles.css`, because a
 * `border-(--x)` utility loses to the unlayered `* { border-color }` rule.
 *
 * Focus is a 3px outline at a 3px offset. Its colour is Forest from the
 * `@layer base` `:focus-visible` rule, and Bone on the `on-brand` variant. It is
 * an outline, not a shadow, so forced-colours mode keeps it.
 *
 * Press moves the button down 1px and to 98% (clash 37) over the fast step. The
 * move is `motion-safe:` only, and the global reduced-motion block zeroes the
 * transition as well.
 *
 * Disabled is 60% opacity with no pointer events, and no colour change. A link
 * cannot be `disabled`, so `aria-disabled="true"` gives it the same look.
 */
const BUTTON_BASE =
  'aec-btn inline-flex min-h-11 items-center justify-center gap-2 rounded-control border text-center text-t-14 font-semibold no-underline transition duration-fast ease-standard focus-visible:outline-3 focus-visible:outline-offset-3 motion-safe:active:translate-y-px motion-safe:active:scale-98 disabled:pointer-events-none disabled:opacity-60 aria-disabled:pointer-events-none aria-disabled:opacity-60';

// Whole class names, so Tailwind's scanner sees every one.
const BUTTON_VARIANT: Record<AecButtonVariant, string> = {
  primary: 'bg-(--accent-primary) text-(--surface-base) hover:bg-(--accent-primary-hover)',
  'on-brand':
    'bg-(--accent-warm) text-(--accent-primary) hover:bg-(--surface-on-brand-hover) focus-visible:outline-(--focus-ring-on-brand)',
  secondary:
    'aec-btn-secondary bg-(--surface-raised) text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary)',
  ghost: 'bg-transparent text-(--text-primary) hover:text-(--accent-primary)',
  danger: 'bg-(--status-error) text-(--surface-base) hover:bg-(--status-error-hover)',
};

const BUTTON_SIZE = {
  default: 'px-6 py-2',
  compact: 'px-4 py-2',
  iconOnly: 'size-11 shrink-0 p-0',
} as const;

/**
 * The class recipe behind `aecButton`. Use the directive in templates. This
 * function exists for the shared constants (`BUTTON_PRIMARY_CLASS`,
 * `BUTTON_SECONDARY_CLASS`) and the callers that still bind `[class]` to them.
 */
export function buttonClass(
  variant: AecButtonVariant = 'primary',
  options: AecButtonOptions = {},
): string {
  // Ghost always takes the compact side padding (DESIGN.md `button-ghost`).
  const size = options.iconOnly
    ? BUTTON_SIZE.iconOnly
    : options.compact || variant === 'ghost'
      ? BUTTON_SIZE.compact
      : BUTTON_SIZE.default;
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${size}`;
}

/**
 * `aecButton` (AECI-1758): the one button on public, portal and admin pages.
 *
 * `<button aecButton type="submit" i18n="…">Save</button>` is a primary button.
 * `<a aecButton variant="secondary" routerLink="/x">…</a>` is a link that looks
 * like a secondary button. Layout classes (`w-full`, `sm:me-auto`) still go on the
 * element. Height, radius, fill, edge and text colour never do.
 *
 * One filled button per surface (clash 21) is a usage rule. The directive does
 * not count them.
 *
 * ACCESSIBILITY
 * An `iconOnly` button has no visible text, so it needs `aria-label`,
 * `aria-labelledby` or visually hidden text. Dev mode logs an error when it has
 * none. A decorative `<aec-icon>` inside it does not count as a name.
 */
@Directive({
  selector: 'button[aecButton], a[aecButton]',
  host: {
    '[class]': 'classes()',
    '[attr.data-variant]': 'variant()',
  },
})
export class AecButton {
  readonly variant = input<AecButtonVariant>('primary');
  readonly compact = input(false, { transform: booleanAttribute });
  readonly iconOnly = input(false, { transform: booleanAttribute });

  protected readonly classes = computed(() =>
    buttonClass(this.variant(), { compact: this.compact(), iconOnly: this.iconOnly() }),
  );

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const host = this.host;
    afterNextRender(() => {
      if (isDevMode() && this.iconOnly() && !hasAccessibleName(host)) {
        console.error(
          'aecButton: an iconOnly button needs aria-label, aria-labelledby or visually hidden text.',
          host,
        );
      }
    });
  }
}

/** A name from an ARIA attribute, a title, or any text inside the element. */
export function hasAccessibleName(el: HTMLElement): boolean {
  if (el.getAttribute('aria-label')?.trim()) return true;
  if (el.getAttribute('aria-labelledby')?.trim()) return true;
  if (el.getAttribute('title')?.trim()) return true;
  if (el.querySelector('[role="img"][aria-label]')) return true;
  return (el.textContent ?? '').trim().length > 0;
}
