import { Component, computed, input, output, signal } from '@angular/core';

import {
  FILTER_COUNT_CLASS,
  FILTER_INPUT_CLASS,
  FILTER_LABEL_CLASS,
  FILTER_LEGEND_CLASS,
  FILTER_LINK_CLASS,
  FILTER_ROW_CLASS,
} from '../../shared/facets/filter-row';
import type { RefinementItem } from '../../shared/facets/refinement-item';

/**
 * Generic refinement-list facet widget (AECI-142): a checkbox group bound to a
 * `connectRefinementList` render-state slice exposed by `SearchController`. The
 * facet heading (`label`) is localized by the page — this widget is i18n-free
 * chrome. Facet VALUES are data (taxonomy names, vendor/product names) and
 * render verbatim. There is no boolean facet since AECI-534 removed
 * `has_api_docs`, so the widget carries no value-label mapping.
 *
 * a11y: `<fieldset>` + `<legend>` names the group; each `<input type="checkbox">`
 * is wrapped in its `<label>` so it has an accessible name. Renders nothing when
 * there are no values (keeps the facet rail clean for an empty index).
 *
 * `min-w-0` on the fieldset: a fieldset defaults to `min-inline-size:
 * min-content`, so a long facet value pushed the rail wider than its column
 * instead of truncating. The numeric-menu and range widgets carry it too.
 *
 * **Top 10, then "Show more" (2026-10-26).** Both `/search` and the `/products`
 * sidebar render their lists here, so they collapse alike: the first
 * `collapsedLimit` values in the order given, plus any checked value further
 * down, so a selection never hides. "Show more" reveals the rest in place and
 * becomes "Show fewer". The toggle text is the one localized string here.
 *
 * **Rows (AECI-1793, mock-up 10).** Each row is a 44px label with a 20px
 * checkbox and the count on the end edge; the parts are the shared
 * `shared/facets/filter-row.ts` constants, so `/search` and `/products` draw
 * the same row.
 */
/** Per-instance id for `aria-controls`. Deterministic per render (SSR-safe). */
let nextListId = 0;

@Component({
  selector: 'aec-search-refinement-list',
  template: `
    @if (items().length) {
      <fieldset class="min-w-0 border-0 p-0">
        <legend [class]="legendClass">{{ label() }}</legend>
        <ul [id]="listId">
          @for (item of visibleItems(); track item.value) {
            <li>
              <label [class]="rowClass">
                <input
                  type="checkbox"
                  [class]="inputClass"
                  [checked]="item.isRefined"
                  (change)="refine.emit(item.value)"
                />
                <span [class]="labelClass">{{ item.label }}</span>
                <span [class]="countClass">({{ item.count }})</span>
              </label>
            </li>
          }
        </ul>
        @if (canToggle()) {
          <button
            type="button"
            [class]="linkClass"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="listId"
            (click)="expanded.set(!expanded())"
          >
            @if (expanded()) {
              <span i18n="@@facets.showFewer">Show fewer</span>
            } @else {
              <span i18n="@@facets.showMore">Show more ({{ hiddenCount() }})</span>
            }
          </button>
        }
      </fieldset>
    }
  `,
})
export class SearchRefinementList {
  /** Localized facet heading (e.g. "Categories"). */
  readonly label = input.required<string>();
  /** Current render-state items for this facet attribute. */
  readonly items = input.required<readonly RefinementItem[]>();
  /** Emits the facet value to toggle. */
  readonly refine = output<string>();
  /** Values shown before "Show more". */
  readonly collapsedLimit = input(10);

  protected readonly listId = `aec-refinement-list-${nextListId++}`;
  protected readonly legendClass = FILTER_LEGEND_CLASS;
  protected readonly rowClass = FILTER_ROW_CLASS;
  protected readonly inputClass = FILTER_INPUT_CLASS;
  protected readonly labelClass = FILTER_LABEL_CLASS;
  protected readonly countClass = FILTER_COUNT_CLASS;
  protected readonly linkClass = FILTER_LINK_CLASS;
  protected readonly expanded = signal(false);

  /** The first `collapsedLimit` values, plus any checked value past them. */
  private readonly collapsedItems = computed(() => {
    const limit = this.collapsedLimit();
    return this.items().filter((item, index) => index < limit || item.isRefined);
  });

  protected readonly canToggle = computed(() => this.collapsedItems().length < this.items().length);
  protected readonly hiddenCount = computed(
    () => this.items().length - this.collapsedItems().length,
  );
  protected readonly visibleItems = computed(() =>
    this.expanded() ? this.items() : this.collapsedItems(),
  );
}
