import { Directive } from '@angular/core';

/**
 * `aecKeepClearOfSaveBar`, on a form that renders the nested save bar
 * (`NESTED_SAVE_BAR`, sticky at the bottom of the viewport). WCAG 2.4.11: a control
 * that takes focus must not sit under the bar.
 *
 * `PORTAL_FORM_CLASS` (carried by `FORM_PANEL`) gives every control a bottom scroll
 * margin taller than the bar. Chrome only applies that margin when it scrolls, and it
 * does not scroll on focus when the control is already inside the viewport, even if
 * the bar covers it. A nested form often opens near the foot of the viewport, so its
 * later fields start there. On focus this asks for the nearest scroll that shows the
 * control with its margin: nothing moves when the control is already clear of the
 * bar, and a covered one lifts above it.
 *
 * Controls inside the bar itself are left alone. Instant, so reduced motion holds.
 */
@Directive({
  selector: 'form[aecKeepClearOfSaveBar]',
  host: { '(focusin)': 'keepClear($event)' },
})
export class KeepClearOfSaveBar {
  protected keepClear(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('.aec-portal-save-bar')) return;
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
}
