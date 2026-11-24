import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { AecButton } from '../shared/button/button';

/**
 * Prev/next pagination for the admin panel (AECI-577).
 *
 * `page_views` was the first admin list that had to page for real: production
 * holds ~26k rows and grows ~1k/day, so the Activity feed pages on the server.
 * The review queue pages the set it has loaded in the browser (AECI-2102),
 * because its sorts run over that set. The other moderation queues still load
 * `perPage=100` once and show a truncation note.
 *
 * Deliberately prev/next rather than numbered pages: the feed is scanned
 * chronologically, so "page 7" is not a destination anyone reasons about, and a
 * numbered rail over 500+ pages is a worse control than two buttons plus the
 * position. The total is always shown, so the operator knows the size of what
 * they are walking.
 *
 * Presentational: the parent owns `page` and refetches on `(pageChange)`.
 *
 * FOCUS (AECI-2102). No button is ever natively disabled: a press that reached
 * the first or last page, or started a refetch, would disable the focused button,
 * and Chromium drops focus to `<body>`. An edge button is `aria-disabled` and its
 * press does nothing. While `busy` the nav is `aria-busy` and both presses do
 * nothing, without the dimmed look (DESIGN.md: a busy state does not set
 * `aria-disabled`).
 *
 * Its sibling, `AdminCursorPaginator` (`admin-cursor-paginator.ts`), pages by
 * keyset cursor instead. Only `/admin/audit` uses it, because an append-only
 * ledger drifts under offset paging (ADR 0046). Every other admin list, the
 * scoped audit trails included, stays on this one and `PageQuerySchema`.
 */
@Component({
  selector: 'aec-admin-paginator',
  imports: [AecButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pageCount() > 1) {
      <!-- AECI-1813, mock-up 14: the position on the start edge, Previous and Next
           as compact secondary buttons on the end, 16px under the table. -->
      <nav
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 pt-4"
        i18n-aria-label="@@admin.paginator.aria"
        aria-label="Pagination"
        [attr.aria-busy]="busy() ? 'true' : null"
      >
        <p class="text-t-14 tabular-nums text-(--text-secondary)">{{ positionLabel() }}</p>

        <div class="flex flex-wrap items-center gap-3">
          <button
            aecButton
            variant="secondary"
            compact
            [attr.aria-disabled]="page() <= 1 ? 'true' : null"
            (click)="go(page() - 1)"
            i18n="@@admin.paginator.previous"
          >
            Previous
          </button>
          <button
            aecButton
            variant="secondary"
            compact
            [attr.aria-disabled]="page() >= pageCount() ? 'true' : null"
            (click)="go(page() + 1)"
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
  /** A refetch is in flight: both buttons ignore presses. */
  readonly busy = input(false);
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
    if (this.busy()) return;
    if (page < 1 || page > this.pageCount() || page === this.page()) return;
    this.pageChange.emit(page);
  }
}
