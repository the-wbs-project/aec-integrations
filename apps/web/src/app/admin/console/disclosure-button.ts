import {
  Component,
  afterNextRender,
  booleanAttribute,
  input,
  isDevMode,
  output,
} from '@angular/core';

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
 *
 * USAGE NOTES, visible words (AECI-1729). A toggle whose words are shown beside the
 * chevron sets `withLabel` and projects them, each in its own `i18n` element, and
 * passes `[label]="null"`: the visible words are the accessible name. `label` stays
 * required in both modes, so a consumer cannot forget it, and an icon-only button
 * with an empty `label` logs a dev-mode error. `describedBy`
 * points the button at another element (the row's header), so a column of the same
 * words can be told apart. The audit trail's "Show changes" / "Hide changes" is the
 * user (`admin/audit/audit-trail.html`). In that mode the words do change with the
 * state, because they are what the reader sees.
 *
 * ```html
 * <aec-admin-disclosure-button withLabel [label]="null" [expanded]="open()" controls="d-1" describedBy="row-1" (toggled)="flip()">
 *   @if (open()) { <span i18n="@@x.hide">Hide changes</span> } @else { <span i18n="@@x.show">Show changes</span> }
 * </aec-admin-disclosure-button>
 * ```
 */
@Component({
  selector: 'aec-admin-disclosure-button',
  imports: [AecButton, AecIcon],
  template: `
    <button
      aecButton
      variant="ghost"
      [iconOnly]="!withLabel()"
      [compact]="withLabel()"
      type="button"
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="controls()"
      [attr.aria-describedby]="describedBy()"
      (click)="toggled.emit()"
    >
      <span
        class="inline-flex text-(--text-secondary) transition-transform duration-fast ease-standard motion-reduce:transition-none"
        [class.rotate-180]="expanded()"
        ><aec-icon name="chevron-down" decorative
      /></span>
      @if (withLabel()) {
        <ng-content />
      } @else {
        <span class="sr-only">{{ label() }}</span>
      }
    </button>
  `,
  host: { class: 'inline-flex' },
})
export class AdminDisclosureButton {
  readonly expanded = input.required<boolean>();
  /** The id of the detail row this button opens. */
  readonly controls = input.required<string>();
  /**
   * The button's accessible name: what the row opens, localised, no verb. Required, so
   * no consumer can leave it out. `null` only with `withLabel`, where the projected
   * words are the name.
   */
  readonly label = input.required<string | null>();
  /** Show the projected words beside the chevron instead of an icon-only button. */
  readonly withLabel = input(false, { transform: booleanAttribute });
  /** The id of an element that describes the button (`aria-describedby`). */
  readonly describedBy = input<string | null>(null);
  readonly toggled = output<void>();

  constructor() {
    // Dev only: production registers no render callback per disclosure.
    if (!isDevMode()) return;
    afterNextRender(() => {
      if (!this.withLabel() && !this.label()?.trim()) {
        console.error(
          'aec-admin-disclosure-button: an icon-only disclosure needs a non-empty label, or set withLabel and project the words.',
        );
      }
    });
  }
}
