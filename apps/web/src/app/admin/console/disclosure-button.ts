import { Component, input, output } from '@angular/core';

import { AecButton } from '../../shared/button/button';
import { AecIcon } from '../../shared/icon/icon';

/**
 * The one leading disclosure of an expandable console table row (AECI-1813, the
 * console table recipe, `console-table.ts`). A 44px ghost icon button whose
 * chevron turns when the row is open. `aria-expanded` and `aria-controls` tie it
 * to the detail row. The parent owns the open state.
 *
 * ```html
 * <td [class]="t.disclosure">
 *   <aec-admin-disclosure-button [expanded]="open()" controls="r1-x" [label]="openLabel" (toggled)="flip()" />
 * </td>
 * ```
 *
 * `label` names what the row opens, already localised, with no verb: "Review of
 * Fieldline Takeoff", never "Open the review of …". The name stays the same open
 * and closed, and `aria-expanded` says which, so a verb would be wrong in one of
 * the two states. The piece carries no English of its own.
 */
@Component({
  selector: 'aec-admin-disclosure-button',
  imports: [AecButton, AecIcon],
  template: `
    <button
      aecButton
      variant="ghost"
      iconOnly
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="controls()"
      (click)="toggled.emit()"
    >
      <span
        class="inline-flex text-(--text-secondary) transition-transform duration-fast ease-standard motion-reduce:transition-none"
        [class.rotate-180]="expanded()"
        ><aec-icon name="chevron-down" decorative
      /></span>
      <span class="sr-only">{{ label() }}</span>
    </button>
  `,
  host: { class: 'inline-flex' },
})
export class AdminDisclosureButton {
  readonly expanded = input.required<boolean>();
  /** The id of the detail row this button opens. */
  readonly controls = input.required<string>();
  /** The button's accessible name: what the row opens, localised, no verb. */
  readonly label = input.required<string>();
  readonly toggled = output<void>();
}
