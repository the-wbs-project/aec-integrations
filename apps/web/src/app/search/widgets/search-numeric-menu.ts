import { Component, input, output } from '@angular/core';

import {
  FILTER_INPUT_CLASS,
  FILTER_LABEL_CLASS,
  FILTER_LEGEND_CLASS,
  FILTER_ROW_CLASS,
} from '../../shared/facets/filter-row';
import type { NumericMenuItem } from '../search-controller';

/**
 * Generic numeric-menu facet widget (AECI-142): a radio group over count buckets
 * (§7.2 `0 / 1–10 / 11–50 / 51+`) bound to a `connectNumericMenu` render-state
 * slice. The bucket labels are numeric data; the single empty-label item is the
 * "no filter" option and renders the localized `allLabel` the page passes.
 *
 * a11y: `<fieldset>`/`<legend>` names the group; radios share a `name` (the page
 * passes a tab-unique value so the products and vendors `integration_count`
 * menus never collapse into one group). Each radio is wrapped in its `<label>`.
 */
@Component({
  selector: 'aec-search-numeric-menu',
  template: `
    @if (items().length) {
      <fieldset class="min-w-0 border-0 p-0">
        <legend [class]="legendClass">{{ label() }}</legend>
        <ul>
          @for (item of items(); track item.value) {
            <li>
              <label [class]="rowClass">
                <input
                  type="radio"
                  [class]="inputClass"
                  [name]="name()"
                  [checked]="item.isRefined"
                  (change)="refine.emit(item.value)"
                />
                <span [class]="labelClass">{{ item.label || allLabel() }}</span>
              </label>
            </li>
          }
        </ul>
      </fieldset>
    }
  `,
})
export class SearchNumericMenu {
  /** Localized facet heading (e.g. "Integrations"). */
  readonly label = input.required<string>();
  /** Unique radio-group name (page passes e.g. `products:integration_count`). */
  readonly name = input.required<string>();
  /** Localized "all / no filter" label for the empty-label bucket. */
  readonly allLabel = input.required<string>();
  /** Current render-state buckets. */
  readonly items = input.required<readonly NumericMenuItem[]>();
  /** Emits the encoded bucket value to select. */
  readonly refine = output<string>();

  /** The shared filter-row parts (AECI-1793), as on the checkbox lists. */
  protected readonly legendClass = FILTER_LEGEND_CLASS;
  protected readonly rowClass = FILTER_ROW_CLASS;
  protected readonly inputClass = FILTER_INPUT_CLASS;
  protected readonly labelClass = FILTER_LABEL_CLASS;
}
