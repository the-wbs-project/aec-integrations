import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/**
 * Prev/next pagination for the admin panel (AECI-577).
 *
 * The existing admin queues do not paginate — they load `perPage=100` once and
 * show a truncation note, which works because a launch-scale moderation backlog
 * fits in one page. `page_views` does not: production holds ~26k rows and grows
 * ~1k/day, so the Activity feed is the first admin surface that has to page for
 * real, and §5.3/§5.5 will want the same control.
 *
 * Deliberately prev/next rather than numbered pages: the feed is scanned
 * chronologically, so "page 7" is not a destination anyone reasons about, and a
 * numbered rail over 500+ pages is a worse control than two buttons plus the
 * position. The total is always shown, so the operator knows the size of what
 * they are walking.
 *
 * Presentational: the parent owns `page` and refetches on `(pageChange)`.
 */
@Component({
  selector: 'aec-admin-paginator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pageCount() > 1) {
      <nav
        class="flex flex-wrap items-center justify-between gap-3 border-t border-(--border-default) pt-4"
        i18n-aria-label="@@admin.paginator.aria"
        aria-label="Pagination"
      >
        <p class="text-xs text-(--text-secondary)">{{ positionLabel() }}</p>

        <div class="flex items-center gap-2">
          <button
            type="button"
            [disabled]="page() <= 1"
            (click)="go(page() - 1)"
            class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
              bg-(--surface-raised) px-4 py-2 text-sm font-bold text-(--text-primary)
              transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)
              disabled:cursor-not-allowed disabled:opacity-50"
            i18n="@@admin.paginator.previous"
          >
            Previous
          </button>
          <button
            type="button"
            [disabled]="page() >= pageCount()"
            (click)="go(page() + 1)"
            class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
              bg-(--surface-raised) px-4 py-2 text-sm font-bold text-(--text-primary)
              transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)
              disabled:cursor-not-allowed disabled:opacity-50"
            i18n="@@admin.paginator.next"
          >
            Next
          </button>
        </div>
      </nav>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminPaginator {
  /** 1-based. */
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  /** Rows matching the current filters, not rows on this page. */
  readonly total = input.required<number>();
  readonly pageChange = output<number>();

  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.total() / Math.max(1, this.perPage()))),
  );

  /** Built in TS rather than an interpolated template string so the whole
   *  sentence is one translatable unit with ordered placeholders. */
  protected readonly positionLabel = computed(
    () =>
      $localize`:@@admin.paginator.position:Page ${this.page()}:PAGE: of ${this.pageCount()}:PAGES: · ${this.total()}:TOTAL: rows`,
  );

  protected go(page: number): void {
    if (page < 1 || page > this.pageCount() || page === this.page()) return;
    this.pageChange.emit(page);
  }
}
