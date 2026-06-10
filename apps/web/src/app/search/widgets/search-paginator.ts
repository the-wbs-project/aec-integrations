import { Component, input, output } from '@angular/core';

/**
 * Minimal prev/next paginator for a `/search` results tab (AECI-142), bound to a
 * `connectPagination` render-state slice (`page` is zero-based, `nbPages` is the
 * total). Renders nothing for a single page. Distinct from the `/products` table
 * `Paginator` (1-based + total/perPage); InstantSearch pagination is page-count
 * based, so this is its own small control.
 */
@Component({
  selector: 'aec-search-paginator',
  template: `
    @if (nbPages() > 1) {
      <nav
        class="mt-8 flex items-center justify-center gap-4"
        i18n-aria-label="@@search.pagination.aria"
        aria-label="Pagination"
      >
        <button
          type="button"
          class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          [disabled]="page() <= 0"
          (click)="pageChange.emit(page() - 1)"
          i18n="@@search.pagination.previous"
        >
          Previous
        </button>
        <span
          class="text-sm tabular-nums text-(--text-secondary)"
          i18n="@@search.pagination.status"
        >
          Page {{ page() + 1 }} of {{ nbPages() }}
        </span>
        <button
          type="button"
          class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          [disabled]="page() >= nbPages() - 1"
          (click)="pageChange.emit(page() + 1)"
          i18n="@@search.pagination.next"
        >
          Next
        </button>
      </nav>
    }
  `,
})
export class SearchPaginator {
  /** Zero-based current page. */
  readonly page = input.required<number>();
  /** Total page count. */
  readonly nbPages = input.required<number>();
  /** Emits the target zero-based page. */
  readonly pageChange = output<number>();
}
