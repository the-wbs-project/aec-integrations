import { DestroyRef, Directive, inject, signal } from '@angular/core';

/**
 * Open/close behaviour shared by the nav dropdowns: the public Browse menu
 * (`browse-menu.ts`, AECI-1774) and the admin console's row
 * (`admin/admin-nav-dropdown.ts`). Factored out so they behave alike; a row where
 * one dropdown opens on hover and another only on click reads as a bug. A future
 * row dropdown must extend it (DESIGN.md §5 "Portal and admin rows").
 *
 * The contract:
 *   - pointer: hovering the host opens, leaving closes. An implementor may set
 *     `openDelayMs` and `closeGraceMs`. The grace lets the pointer cross a gap
 *     between the trigger and the panel (WCAG 1.4.13 "hoverable"). Both default
 *     to 0, which is the admin row's shipped behaviour;
 *   - keyboard: Escape closes and returns focus to the trigger element (link or
 *     button), and focus leaving the host closes.
 *
 * A selector-less `@Directive` purely for inheritance — Angular carries the
 * `host` listeners down to the subclass, so subclasses declare only their own
 * host classes. Never add this to an `imports` array.
 *
 * Implementors must render the trigger control (the link or button carrying
 * `aria-expanded`) as the first `[aria-expanded]` element inside the host, so
 * Escape can return focus to it. The selector does not use `aria-haspopup`:
 * the Browse trigger is disclosure navigation and carries none (DESIGN.md §5).
 */
@Directive({
  host: {
    '(mouseenter)': 'onPointerEnter()',
    '(mouseleave)': 'onPointerLeave()',
    '(focusout)': 'onFocusOut($event)',
    '(pointerdown)': 'pressInside = true',
    '(pointerup)': 'pressInside = false',
    '(pointercancel)': 'pressInside = false',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export abstract class NavDisclosure {
  private readonly openSig = signal(false);
  protected readonly isOpen = this.openSig.asReadonly();

  /**
   * True between a pointer press inside the host and its release. Safari never
   * focuses a link or button on click: the mousedown blurs whatever had focus
   * and focus goes to `<body>` (`relatedTarget` null). With focus on the trigger
   * (after a Tab), that blur closed the panel within the press, so the release
   * landed on whatever was under it and the click on a panel link was lost.
   */
  protected pressInside = false;

  /** Hover-open delay. 0 opens at once. */
  protected readonly openDelayMs: number = 0;
  /** Close grace after the pointer leaves the host. 0 closes at once. */
  protected readonly closeGraceMs: number = 0;

  private hoverTimer: ReturnType<typeof setTimeout> | undefined;

  /** A pending hover timer never outlives the component. */
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => this.clearHoverTimer());
  }

  protected open(): void {
    this.clearHoverTimer();
    this.openSig.set(true);
  }

  protected close(): void {
    this.clearHoverTimer();
    this.pressInside = false;
    this.openSig.set(false);
  }

  protected toggle(): void {
    this.clearHoverTimer();
    this.openSig.update((v) => !v);
  }

  /** Pointer entered the host: open, after the delay if one is set. */
  protected onPointerEnter(): void {
    this.clearHoverTimer();
    if (this.isOpen() || this.openDelayMs <= 0) {
      this.open();
      return;
    }
    this.hoverTimer = setTimeout(() => this.open(), this.openDelayMs);
  }

  /** Pointer left the host: close, after the grace if one is set. */
  protected onPointerLeave(): void {
    this.clearHoverTimer();
    if (this.closeGraceMs <= 0) {
      this.close();
      return;
    }
    this.hoverTimer = setTimeout(() => this.close(), this.closeGraceMs);
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer !== undefined) clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
  }

  /**
   * Close when focus leaves the host entirely (e.g. Tab past the last link). A
   * blur to nowhere during a press inside the host is Safari's click behaviour
   * (see `pressInside`), not focus leaving, so it keeps the panel open.
   */
  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget as HTMLElement;
    const to = event.relatedTarget as Node | null;
    if (to === null && this.pressInside) return;
    if (!host.contains(to)) this.close();
  }

  /** Escape closes the panel and returns focus to the disclosure trigger. */
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    this.close();
    const host = event.currentTarget as HTMLElement;
    host.querySelector<HTMLElement>('[aria-expanded]')?.focus();
  }
}
