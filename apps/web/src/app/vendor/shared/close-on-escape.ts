import { Directive, input, output } from '@angular/core';

/**
 * `aecCloseOnEscape`: in a portal nested form, Escape does exactly what the form's
 * Cancel button does (AECI-2133, ruled 2026-11-25). The admin console's inline forms
 * already treat Escape and Cancel as one act; this makes the portal match.
 *
 * Usage, on the element that holds the form's fields and its Cancel button (usually
 * the `<form>`):
 *
 * ```html
 * <form aecCloseOnEscape [escapeBusy]="sending()" (escapeCancel)="cancel()" …>
 *   …
 *   <button aecButton variant="secondary" type="button" [disabled]="sending()"
 *     (click)="cancel()">Cancel</button>
 * </form>
 * ```
 *
 * - **Bind `(escapeCancel)` to the handler Cancel's click calls.** Not a copy of it: the
 *   two must stay one act, including where focus goes (back to the form's opener) and
 *   whether the draft is kept.
 * - **Bind `[escapeBusy]` to whatever disables Cancel** (the request in flight). While it
 *   is true, Escape does nothing, as the disabled Cancel does nothing.
 * - Not for a form inside a modal dialog: the dialog owns Escape.
 *
 * Escape is ignored, and left for others to handle, when:
 * - an input-method composition is in progress (`isComposing`, or the legacy
 *   `keyCode` 229 some browsers send while composing), because Escape then cancels the
 *   composition, not the form;
 * - a control inside the form already handled it (`defaultPrevented`): an open popup,
 *   a tooltip or a picker takes the first Escape, and only the next one closes the form;
 * - it comes from a combobox whose popup is open (`role="combobox"` with
 *   `aria-expanded="true"`), for a combobox that closes its popup without marking the
 *   event handled;
 * - it comes from a native `<select>` whose option list is open (`:open`). Chromium
 *   still sends that Escape to the page, unmarked, as it closes the list.
 *
 * When the form acts on Escape (or swallows it while busy), it
 * stops propagation and marks the event handled, so a parent row, panel or dialog with
 * its own Escape does not also close.
 */
@Directive({
  selector: '[aecCloseOnEscape]',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class CloseOnEscape {
  /** True while the form's request is in flight: Escape does nothing, as Cancel does. */
  readonly escapeBusy = input(false);
  /** Escape was pressed: call the form's Cancel handler. */
  readonly escapeCancel = output<void>();

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.defaultPrevented) return;
    if (fromOpenPopup(event.target)) return;
    // The form owns this Escape now, busy or not: a parent must not close around it.
    event.stopPropagation();
    event.preventDefault();
    if (this.escapeBusy()) return;
    this.escapeCancel.emit();
  }
}

function fromOpenPopup(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target.getAttribute('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true')
    return true;
  return target.tagName === 'SELECT' && matchesOpen(target);
}

/** `:open` on a native select whose option list is showing. A browser without the
 *  pseudo-class throws on it, and then the select is treated as closed. */
function matchesOpen(el: Element): boolean {
  try {
    return el.matches(':open');
  } catch {
    return false;
  }
}
