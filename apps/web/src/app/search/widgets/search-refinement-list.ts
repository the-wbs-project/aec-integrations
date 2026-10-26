import { Component, computed, input, output, signal } from '@angular/core';

import type { RefinementItem } from '../../shared/facets/refinement-item';

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
 */
/** Per-instance id for `aria-controls`. Deterministic per render (SSR-safe). */
let nextListId = 0;

@Component({
  selector: 'aec-search-refinement-list',
  template: `
    @if (items().length) {
      <fieldset class="min-w-0 border-0 p-0">
        <legend
          class="mb-2 text-xs font-semibold tracking-[0.08em] text-(--text-secondary) uppercase"
        >
          {{ label() }}
        </legend>
        <ul class="space-y-1" [id]="listId">
          @for (item of visibleItems(); track item.value) {
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
                <span class="min-w-0 truncate">{{ displayLabel(item) }}</span>
                <span class="shrink-0 text-xs tabular-nums text-(--text-secondary)"
                  >({{ item.count }})</span
                >
              </label>
            </li>
          }
        </ul>
        @if (canToggle()) {
          <button
            type="button"
            class="mt-1 rounded-(--radius-sm) px-1 text-sm text-(--accent-primary) underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
  /**
   * For a boolean facet, the localized `[trueLabel, falseLabel]` to show instead
   * of the raw `true`/`false` facet values. `null` for normal string facets.
   */
  readonly booleanLabels = input<readonly [string, string] | null>(null);
  /** Emits the facet value to toggle. */
  readonly refine = output<string>();
  /** Values shown before "Show more". */
  readonly collapsedLimit = input(10);

  protected readonly listId = `aec-refinement-list-${nextListId++}`;
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

  protected displayLabel(item: RefinementItem): string {
    const bl = this.booleanLabels();
    if (bl) {
      if (item.value === 'true') return bl[0];
      if (item.value === 'false') return bl[1];
    }
    return item.label;
  }
}
