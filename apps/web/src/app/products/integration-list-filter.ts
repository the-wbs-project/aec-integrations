import { Component, computed, input, model } from '@angular/core';

/**
 * AECI-841 — the name filter above a long product-detail integration section.
 *
 * Presentational and controlled: it renders the query it is given and emits
 * every keystroke. The section owns the query, because the same value also
 * drives which groups are open and whether the `@defer` cut applies.
 *
 * **The result count is a WCAG 4.1.3 status message**, so the `<p role="status">`
 * is in the DOM from first render with empty text, and gains text when a query
 * starts. A live region added to the page at the same moment its text arrives is
 * frequently not announced at all — the region has to exist first. It renders
 * nothing while the query is empty, so an idle section announces nothing.
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
  host: { class: 'block' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1 sm:max-w-xs">
        <label [for]="inputId()" class="sr-only">{{ label() }}</label>
        <input
          [id]="inputId()"
          type="search"
          autocomplete="off"
          [value]="query()"
          [attr.placeholder]="placeholder()"
          (input)="onInput($event)"
          class="w-full rounded-(--radius-sm) border border-(--border-default)
            bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-(--accent-primary)"
        />
      </div>
      <p role="status" class="text-xs text-(--text-secondary)">{{ status() }}</p>
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
