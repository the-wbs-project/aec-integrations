import { Directive } from '@angular/core';

/**
 * `aecKeepClearOfSaveBar`, on a portal form that renders a sticky save bar
 * (`PORTAL_SAVE_BAR_CLASS` or `PORTAL_NESTED_SAVE_BAR_CLASS`, `portal-form.ts`). WCAG
 * 2.4.11: a control that takes focus must not sit under the bar. Built by AECI-1811 for
 * the integration detail page, moved here by AECI-1812, which added it to the
 * integrations list's create, edit and connector mapping forms, and to "Add a product".
 *
 * `PORTAL_FORM_CLASS` gives every control a bottom scroll margin taller than the bar. Chrome only applies that margin when it scrolls, and it
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
