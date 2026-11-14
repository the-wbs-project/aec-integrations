import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  PLATFORM_ID,
  Renderer2,
  afterNextRender,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  isDevMode,
} from '@angular/core';

import { isReplayedEvent } from '../../core/event-replay';

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
 * TYPE
 * A `<button aecButton>` with no `type` attribute gets `type="button"`, so it
 * never submits a form by accident. An explicit `type="submit"` is kept.
 *
 * DISABLED
 * Use the `disabled` input: `<button aecButton [disabled]="busy()">` or
 * `<a aecButton [disabled]="!ready()">`. On a `<button>` it sets the native
 * `disabled` attribute. A link has no native disabled state, so on an `<a>` it
 * sets `aria-disabled="true"` and `tabindex="-1"` and cancels clicks (Enter on a
 * link fires a click too). Re-enabling restores the link's own `tabindex`. A
 * caller that writes `aria-disabled` by hand gets the dimmed look only: the link
 * still takes focus and still navigates.
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
    // A link has no `disabled` attribute. A button drops it when re-enabled.
    '[attr.disabled]': 'isButton && disabled() ? "" : null',
  },
})
export class AecButton {
  readonly variant = input<AecButtonVariant>('primary');
  readonly compact = input(false, { transform: booleanAttribute });
  readonly iconOnly = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly classes = computed(() =>
    buttonClass(this.variant(), { compact: this.compact(), iconOnly: this.iconOnly() }),
  );

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly renderer = inject(Renderer2);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly isButton = this.host.tagName === 'BUTTON';

  /** The link's own tabindex, kept while disabled so re-enabling restores it. */
  private savedTabindex: string | null = null;
  private linkDisabled = false;

  /**
   * Cancels a click on a disabled link. Added with `addEventListener`, only
   * while the link is disabled, and never through a template or host listener.
   * The style guide's anchor rule ("an `<a href>` that relies on its native
   * default carries no listener of its own") exists because a host listener
   * puts the anchor in Angular's event-replay cache, which then cancels later
   * clicks. A code listener is not in that cache and is gone once the link is
   * enabled. Capture phase, so it runs before `RouterLink`'s own click listener.
   */
  private readonly blockClick = (event: Event): void => {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  constructor() {
    // Static attributes are already on the element when the directive is made.
    if (this.isButton && !this.host.hasAttribute('type')) {
      this.renderer.setAttribute(this.host, 'type', 'button');
    }

    if (!this.isButton) {
      effect(() => this.setLinkDisabled(this.disabled()));
      this.destroyRef.onDestroy(() => {
        this.host.removeEventListener('click', this.blockClick, true);
      });
    }

    // Dev only: production registers no render callback per button.
    if (!isDevMode()) return;
    const host = this.host;
    afterNextRender(() => {
      if (this.iconOnly() && !hasAccessibleName(host)) {
        console.error(
          'aecButton: an iconOnly button needs aria-label, aria-labelledby or visually hidden text.',
          host,
        );
      }
    });
  }

  private setLinkDisabled(disabled: boolean): void {
    if (disabled === this.linkDisabled) return;
    this.linkDisabled = disabled;
    const el = this.host;
    if (disabled) {
      this.savedTabindex = el.getAttribute('tabindex');
      this.renderer.setAttribute(el, 'aria-disabled', 'true');
      this.renderer.setAttribute(el, 'tabindex', '-1');
      if (this.isBrowser) el.addEventListener('click', this.blockClick, true);
    } else {
      this.renderer.removeAttribute(el, 'aria-disabled');
      if (this.savedTabindex === null) this.renderer.removeAttribute(el, 'tabindex');
      else this.renderer.setAttribute(el, 'tabindex', this.savedTabindex);
      if (this.isBrowser) el.removeEventListener('click', this.blockClick, true);
    }
  }
}

/**
 * A name from an ARIA attribute, a title, a labelled image, or text inside the
 * element. Text inside an `aria-hidden="true"` subtree does not count.
 */
export function hasAccessibleName(el: HTMLElement): boolean {
  if (el.getAttribute('aria-label')?.trim()) return true;
  if (el.getAttribute('aria-labelledby')?.trim()) return true;
  if (el.getAttribute('title')?.trim()) return true;
  const images = Array.from(el.querySelectorAll('[role="img"][aria-label]'));
  if (images.some((img) => !img.closest('[aria-hidden="true"]'))) return true;
  return visibleText(el).trim().length > 0;
}

function visibleText(node: Node): string {
  let text = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) text += child.textContent ?? '';
    else if (child.nodeType === 1 && (child as Element).getAttribute('aria-hidden') !== 'true') {
      text += visibleText(child);
    }
  }
  return text;
}
