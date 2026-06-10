import { Component, input, output } from '@angular/core';

import type { RefinementItem } from '../search-controller';

/**
 * Generic refinement-list facet widget (AECI-142): a checkbox group bound to a
 * `connectRefinementList` render-state slice exposed by `SearchController`. The
 * facet heading (`label`) is localized by the page — this widget is i18n-free
 * chrome. Facet VALUES are data (taxonomy names, vendor/product names) and
 * render verbatim; the one exception is a boolean facet (`has_api_docs`), whose
 * `true`/`false` values map to the localized `booleanLabels` the page passes.
 *
 * a11y: `<fieldset>` + `<legend>` names the group; each `<input type="checkbox">`
 * is wrapped in its `<label>` so it has an accessible name. Renders nothing when
 * there are no values (keeps the facet rail clean for an empty index).
 */
@Component({
  selector: 'aec-search-refinement-list',
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
                  type="checkbox"
                  class="h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  [checked]="item.isRefined"
                  (change)="refine.emit(item.value)"
                />
                <span class="min-w-0 flex-1 truncate">{{ displayLabel(item) }}</span>
                <span class="shrink-0 text-xs tabular-nums text-(--text-secondary)">{{
                  item.count
                }}</span>
              </label>
            </li>
          }
        </ul>
      </fieldset>
    }
  `,
})
export class SearchRefinementList {
  /** Localized facet heading (e.g. "Categories"). */
  readonly label = input.required<string>();
  /** Current render-state items for this facet attribute. */
  readonly items = input.required<readonly RefinementItem[]>();
  /**
   * For a boolean facet, the localized `[trueLabel, falseLabel]` to show instead
   * of the raw `true`/`false` facet values. `null` for normal string facets.
   */
  readonly booleanLabels = input<readonly [string, string] | null>(null);
  /** Emits the facet value to toggle. */
  readonly refine = output<string>();

  protected displayLabel(item: RefinementItem): string {
    const bl = this.booleanLabels();
    if (bl) {
      if (item.value === 'true') return bl[0];
      if (item.value === 'false') return bl[1];
    }
    return item.label;
  }
}
