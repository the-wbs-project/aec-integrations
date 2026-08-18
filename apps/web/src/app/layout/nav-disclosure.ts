import { Directive, signal } from '@angular/core';

/**
 * Open/close behaviour shared by every dropdown in the desktop primary nav —
 * the four taxonomy flyouts (`nav-flyout-trigger.ts`) and the "More" overflow
 * menu (`nav-more-trigger.ts`). Factored out so all five behave identically; a
 * row where one dropdown opens on hover and another only on click reads as a
 * bug.
 *
 * The contract:
 *   - pointer: hovering the host opens, leaving closes (each panel keeps a
 *     transparent `pt-2` bridge so the trigger→panel path stays inside the host
 *     and there is no dead gap to fall through);
 *   - keyboard: the trigger button toggles (native Enter/Space), Escape closes
 *     and returns focus to that button, and focus leaving the host closes.
 *
 * A selector-less `@Directive` purely for inheritance — Angular carries the
 * `host` listeners down to the subclass, so subclasses declare only their own
 * host classes. Never add this to an `imports` array.
 *
 * Implementors must render exactly one `button[aria-haspopup]` inside the host
 * (the disclosure trigger) so Escape can return focus to it.
 */
@Directive({
  host: {
    '(mouseenter)': 'open()',
    '(mouseleave)': 'close()',
    '(focusout)': 'onFocusOut($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export abstract class NavDisclosure {
  private readonly openSig = signal(false);
  protected readonly isOpen = this.openSig.asReadonly();

  protected open(): void {
    this.openSig.set(true);
  }

  protected close(): void {
    this.openSig.set(false);
  }

  protected toggle(): void {
    this.openSig.update((v) => !v);
  }

  /** Close when focus leaves the host entirely (e.g. Tab past the last link). */
  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget as HTMLElement;
    if (!host.contains(event.relatedTarget as Node | null)) this.close();
  }

  /** Escape closes the panel and returns focus to the disclosure button. */
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    this.close();
    const host = event.currentTarget as HTMLElement;
    host.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
  }
}
