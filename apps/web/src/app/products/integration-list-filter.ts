import { Component, computed, input, model } from '@angular/core';

/**
 * AECI-841 — the name filter in a product-detail integration section's heading
 * row. Moved into that row, and freed of its ten-row threshold, by AECI-848.
 *
 * Presentational and controlled: it renders the query it is given and emits
 * every keystroke. The section owns the query, because the same value also
 * drives which groups are open and whether the `@defer` cut applies.
 *
 * **It sits in the section header, right-aligned opposite the `<h2>`** (the
 * caller supplies that flex row). Below `sm` the host goes full width and drops
 * under the heading. Two things follow from living in the header rather than in
 * a band of its own: an idle filter costs zero vertical space, which is what
 * retired the ten-row threshold it originally shipped behind; and the row never
 * wraps internally, so the status text is `whitespace-nowrap` and the input
 * takes the remaining width.
 *
 * **The result count is a WCAG 4.1.3 status message**, so the `<p role="status">`
 * is in the DOM from first render with empty text, and gains text when a query
 * starts. A live region added to the page at the same moment its text arrives is
 * frequently not announced at all — the region has to exist first. It renders
 * nothing while the query is empty, so an idle section announces nothing. It is
 * never hidden with `[hidden]` or an `@if` for the same reason: both take the
 * region out of the accessibility tree, which is the state this is avoiding.
 *
 * `type="search"` earns the browser's native clear control, which is the whole
 * reason there is no bespoke clear button here.
 *
 * Labels and placeholder come in already localized. There are two callers with
 * two different nouns ("integrations", "connections"), and keeping the strings
 * with the sections keeps every `@@products.detail.*` id greppable from the copy
 * it belongs to.
 */
@Component({
  selector: 'aec-integration-list-filter',
  // The host IS the row, so there is no wrapper div to collapse margins
  // against. `w-full` below `sm` makes it a full-width second line under the
  // heading; from `sm` up it shrinks to its content and the caller's
  // `justify-between` pushes it to the right edge.
  host: { class: 'flex w-full items-center justify-end gap-3 sm:w-auto' },
  template: `
    <p role="status" class="shrink-0 text-xs whitespace-nowrap text-(--text-secondary)">
      {{ status() }}
    </p>
    <div class="min-w-0 flex-1 sm:w-56 sm:flex-none">
      <label [for]="inputId()" class="sr-only">{{ label() }}</label>
      <input
        [id]="inputId()"
        type="search"
        autocomplete="off"
        [value]="query()"
        [attr.placeholder]="placeholder()"
        (input)="onInput($event)"
        class="w-full rounded-(--radius-sm) border border-(--border-default)
          bg-(--surface-base) px-3 py-1.5 text-sm text-(--text-primary)
          focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-(--accent-primary)"
      />
    </div>
  `,
})
export class IntegrationListFilter {
  /** DOM id for the input; the label points at it. */
  readonly inputId = input.required<string>();
  /** Visually-hidden field label. The section heading carries the visible name. */
  readonly label = input.required<string>();
  /** Placeholder text; localized by the caller. */
  readonly placeholder = input<string>('');
  /** The current query. Two-way bound, so the owning section holds the value:
   *  the same string also decides which cards are open and whether the
   *  `@defer` cut applies, and only the section knows about those. */
  readonly query = model<string>('');
  /** Rows the section renders right now. */
  readonly shown = input.required<number>();
  /** Rows the section would render with no query. */
  readonly total = input.required<number>();

  protected readonly status = computed(() => {
    if (this.query().trim() === '') return '';
    return $localize`:@@products.detail.filter.status:Showing ${this.shown()}:SHOWN: of ${this.total()}:TOTAL:`;
  });

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
