import { DOCUMENT } from '@angular/common';
import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/**
 * What the visitor typed or ticked in a server-rendered field before the app loaded
 * (AECI-1720). Recorded by the inline script in `src/index.html`.
 */
export interface EarlyInputValue {
  readonly value: string;
  readonly checked: boolean;
}

type EarlyControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The `window` key the inline recorder in `src/index.html` writes. */
export const EARLY_INPUT_KEY = '__aeciEarlyInput';

/**
 * The value the recorder kept for this element, removed so it is applied once. Only
 * the visitor's own (trusted) `input` and `change` events write an entry. Undefined
 * when the visitor never changed the field, or when the recorder is absent.
 */
export function takeEarlyInput(
  win: Window | null | undefined,
  el: object,
): EarlyInputValue | undefined {
  const kept = (win as unknown as Record<string, unknown> | null | undefined)?.[EARLY_INPUT_KEY];
  if (!(kept instanceof WeakMap)) return undefined;
  const early = kept.get(el) as EarlyInputValue | undefined;
  kept.delete(el);
  return early;
}

/**
 * Put the visitor's value back on the control and announce it the way the browser
 * did: `input`, then `change`. Signal Forms' `[formField]` reads the control on
 * `input`, so the form model takes the value. A template `(change)` listener reads it
 * on `change`. Returns false, and fires nothing, when the control already shows the
 * value (the app wrote the same one).
 */
export function restoreEarlyInput(el: EarlyControl, early: EarlyInputValue): boolean {
  const choice = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  if (choice) {
    if (el.checked === early.checked) return false;
    el.checked = early.checked;
  } else {
    if (el.value === early.value) return false;
    el.value = early.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Keeps what a visitor typed or ticked before hydration (AECI-1720).
 *
 * A claim page is server-rendered and cached, so a visitor on a slow phone can fill
 * the form and tick the Vendor Terms box before the scripts load. On hydration
 * Signal Forms writes the model's starting value over every bound control, and its
 * own listener is added in code, so event replay never hands it the early events.
 * The tick and the answers were wiped: the box unticked itself and the fields
 * emptied. Measured on the routed claim pages, on `main` and on the redesign.
 *
 * This directive sits on every native `[formField]` control. After the field's first
 * render, the one in which hydration wrote the model's value, it reads the value the
 * inline recorder in `src/index.html` kept for this element and puts it back, so
 * the form model learns it from the same `input` event a keystroke sends. A field the
 * visitor never changed has no entry and is left alone. A control rendered only in
 * the browser has none either, so this does nothing after hydration.
 *
 * Consent (`docs/VENDOR_SIGNUP_PROCESS.md` §4). An entry exists only for an element
 * that received the browser's own `input` or `change` event, so only the visitor's
 * click, key press or tap on the box can carry a tick. A script's event, a value
 * the browser restored on Back, and this directive's own events are not trusted, so
 * the recorder ignores them. The value carried is the one the box showed after that
 * event: a box ticked and unticked again carries false.
 *
 * Every component that imports `FormField` imports this too
 * (`early-input-coverage.spec.ts`). A plain control with a template `(change)`
 * listener opts in with the `aecEarlyInput` attribute (`/auth/terms`).
 */
@Directive({
  selector: 'input[formField], textarea[formField], select[formField], input[aecEarlyInput]',
})
export class AecEarlyInput {
  private readonly el = inject<ElementRef<EarlyControl>>(ElementRef).nativeElement;
  private readonly win = inject(DOCUMENT).defaultView;

  constructor() {
    afterNextRender({
      write: () => {
        const early = takeEarlyInput(this.win, this.el);
        if (early) restoreEarlyInput(this.el, early);
      },
    });
  }
}
