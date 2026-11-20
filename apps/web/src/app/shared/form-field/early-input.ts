import { DOCUMENT } from '@angular/common';
import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/**
 * What the visitor typed or chose in a server-rendered field before the app loaded
 * (AECI-1720). Recorded by the inline script in `src/index.html`.
 */
export interface EarlyInputValue {
  readonly value: string;
  readonly checked: boolean;
}

type EarlyControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The `window` key the inline recorder in `src/index.html` defines. */
export const EARLY_INPUT_KEY = '__aeciEarlyInput';

/** The recorder's surface: read one element's value once, and stop for good. */
interface EarlyInputRecorder {
  take(el: object): EarlyInputValue | undefined;
  stop(): void;
}

function recorderOf(win: Window | null | undefined): EarlyInputRecorder | undefined {
  const rec = (win as unknown as Record<string, unknown> | null | undefined)?.[EARLY_INPUT_KEY] as
    | Partial<EarlyInputRecorder>
    | undefined;
  return typeof rec?.take === 'function' && typeof rec.stop === 'function'
    ? (rec as EarlyInputRecorder)
    : undefined;
}

/**
 * A checkbox is never carried, whatever it is for. Every checkbox in a form here is a
 * consent or opt-in box (the Vendor Terms, the `/auth/terms` box, the portal
 * acceptances, the launch-updates opt-in), so the safe default is the rule: a new box
 * cannot be forgotten. A consent box also carries `aecConsent`, which keeps it
 * disabled until the app is live (`consent-box.ts`).
 */
export function isNeverCarried(el: Pick<Element, 'hasAttribute'>): boolean {
  return (
    (el instanceof HTMLInputElement && el.type === 'checkbox') || el.hasAttribute('aecConsent')
  );
}

/**
 * The value the recorder kept for this element, removed so it is applied once.
 * Undefined when the field was never changed, the recorder is absent or stopped, or
 * the element is one that is never carried.
 */
export function takeEarlyInput(
  win: Window | null | undefined,
  el: Pick<Element, 'hasAttribute'>,
): EarlyInputValue | undefined {
  if (isNeverCarried(el)) return undefined;
  return recorderOf(win)?.take(el);
}

/** Remove the recorder's listeners and its global, once the app is stable. */
export function stopEarlyInput(win: Window | null | undefined): void {
  recorderOf(win)?.stop();
}

/**
 * Put the visitor's value back on the control and announce it the way the browser
 * did: `input`, then `change`. Signal Forms' `[formField]` reads the control on
 * `input`, so the form model takes the value. Returns false, and fires nothing, when
 * the control is never carried or already shows the value.
 */
export function restoreEarlyInput(el: EarlyControl, early: EarlyInputValue): boolean {
  if (isNeverCarried(el)) return false;
  if (el instanceof HTMLInputElement && el.type === 'radio') {
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
 * Keeps what a visitor typed before hydration (AECI-1720).
 *
 * A claim page is server-rendered and cached, so a visitor on a slow phone can fill
 * the form before the scripts load. On hydration Signal Forms writes the model's
 * starting value over every bound control, and its own listener is added in code, so
 * event replay never hands it the early events. The answers were wiped. Measured on
 * the routed claim pages, on `main` and on the redesign.
 *
 * This directive sits on every native `[formField]` control. After the field's first
 * render, the one in which hydration wrote the model's value, it reads the value the
 * inline recorder in `src/index.html` kept for this element and puts it back, so the
 * form model learns it from the same `input` event a keystroke sends. A field nobody
 * changed has no entry and is left alone.
 *
 * What the recorder keeps. It keeps the last value of each text field, select or
 * radio group from `input` and `change` events the browser dispatched, whether the
 * visitor, an extension or a script's `click()` caused them. A script's
 * `dispatchEvent` is not kept. So it carries nothing that the same action after
 * hydration would not have put in the form anyway.
 *
 * Consent is never carried. No checkbox is ever restored (`isNeverCarried`), so a tick
 * made before hydration is wiped by hydration and never reaches a model. A consent box
 * is disabled in the server HTML until the app is live (`AecConsentBox`), so a visitor
 * cannot tick it early and watch it untick.
 *
 * Every component that imports `FormField` imports this too
 * (`early-input-coverage.spec.ts`).
 */
@Directive({
  // It must sit on every Signal Forms control without a second attribute to forget.
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'input[formField]:not([type=checkbox]), textarea[formField], select[formField]',
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
