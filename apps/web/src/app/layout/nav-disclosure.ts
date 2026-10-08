import { Directive, signal } from '@angular/core';

/**
 * Open/close behaviour shared by every dropdown in the desktop primary nav — the
 * four taxonomy flyouts (`nav-flyout-trigger.ts`). Factored out so all four
 * behave identically; a row where one dropdown opens on hover and another only
 * on click reads as a bug. It had a fifth implementor, the "More" overflow menu,
 * until that menu was retired; the base stays because the contract is what keeps
 * the four facets consistent, and a future row dropdown must extend it.
 *
 * The contract:
 *   - pointer: hovering the host opens, leaving closes (each panel keeps a
 *     transparent `pt-2` bridge so the trigger→panel path stays inside the host
 *     and there is no dead gap to fall through);
 *   - keyboard: Escape closes and returns focus to the trigger element (link or
 *     button), and focus leaving the host closes.
 *
 * A selector-less `@Directive` purely for inheritance — Angular carries the
 * `host` listeners down to the subclass, so subclasses declare only their own
 * host classes. Never add this to an `imports` array.
 *
 * Implementors must render a trigger control (`a[aria-haspopup]` or
 * `button[aria-haspopup]`) inside the host so Escape can return focus to it.
 */
@Directive({
  host: {
    '(mouseenter)': 'open()',
    '(mouseleave)': 'close()',
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

  protected open(): void {
    this.openSig.set(true);
  }

  protected close(): void {
    this.pressInside = false;
    this.openSig.set(false);
  }

  protected toggle(): void {
    this.openSig.update((v) => !v);
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
    host.querySelector<HTMLElement>('a[aria-haspopup], button[aria-haspopup]')?.focus();
  }
}
