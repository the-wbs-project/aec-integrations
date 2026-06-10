import { Component, input, output } from '@angular/core';

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
      <fieldset class="border-0 p-0">
        <legend
          class="mb-2 text-xs font-semibold tracking-[0.08em] text-(--text-secondary) uppercase"
        >
          {{ label() }}
        </legend>
        <ul class="space-y-1">
          @for (item of items(); track item.value) {
            <li>
              <label
                class="flex cursor-pointer items-center gap-2 rounded-(--radius-sm) px-1 py-0.5 text-sm text-(--text-primary) hover:bg-(--surface-muted)"
              >
                <input
                  type="radio"
                  class="h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  [name]="name()"
                  [checked]="item.isRefined"
                  (change)="refine.emit(item.value)"
                />
                <span class="min-w-0 flex-1 truncate">{{ item.label || allLabel() }}</span>
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
}
