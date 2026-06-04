import { Component, computed, input, output } from '@angular/core';

/**
 * Page-based paginator for `IndexLayout`'s pagination slot. Stateless: the
 * page component owns the canonical `page` / `perPage` / `total` values
 * (typically read from `?page=` / route query params) and the paginator
 * emits `(pageChange)` with the requested page number.
 *
 * `total` is the count returned by the API (`ProductsListResponse.total`).
 * `perPage` is server-clamped at 100 (Phase 2 Spec §7.3); we still take it
 * as an input so the displayed `Showing X–Y of Z` line stays honest if
 * Phase 3 introduces user-controlled page sizes.
 *
 * Buttons are real `<button>` elements so keyboard activation, focus rings,
 * and screen-reader semantics work without extra ARIA.
 */
@Component({
  selector: 'aec-paginator',
  template: `
    <p class="text-sm text-(--text-secondary)" i18n="@@products.paginator.showing">
      Showing {{ rangeStart() }}–{{ rangeEnd() }} of {{ total() }}
    </p>
    <div class="flex items-center gap-2 text-sm">
      <button
        type="button"
        class="rounded-md border border-(--border-default) px-3 py-1.5 text-(--text-primary) transition-colors hover:border-(--border-strong) disabled:cursor-not-allowed disabled:text-(--text-tertiary) disabled:hover:border-(--border-default) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n-aria-label="@@products.paginator.previous.aria"
        aria-label="Previous page"
        [disabled]="isFirstPage()"
        (click)="goPrevious()"
      >
        <span i18n="@@products.paginator.previous">Previous</span>
      </button>
      <span class="px-2 text-(--text-secondary)" i18n="@@products.paginator.pageOf"
        >Page {{ page() }} of {{ totalPages() }}</span
      >
      <button
        type="button"
        class="rounded-md border border-(--border-default) px-3 py-1.5 text-(--text-primary) transition-colors hover:border-(--border-strong) disabled:cursor-not-allowed disabled:text-(--text-tertiary) disabled:hover:border-(--border-default) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n-aria-label="@@products.paginator.next.aria"
        aria-label="Next page"
        [disabled]="isLastPage()"
        (click)="goNext()"
      >
        <span i18n="@@products.paginator.next">Next</span>
      </button>
    </div>
  `,
})
export class Paginator {
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  readonly total = input.required<number>();

  readonly pageChange = output<number>();

  protected readonly totalPages = computed(() => {
    const total = this.total();
    const perPage = this.perPage();
    if (total <= 0 || perPage <= 0) return 1;
    return Math.max(1, Math.ceil(total / perPage));
  });

  protected readonly isFirstPage = computed(() => this.page() <= 1);
  protected readonly isLastPage = computed(() => this.page() >= this.totalPages());

  protected readonly rangeStart = computed(() => {
    if (this.total() === 0) return 0;
    return (this.page() - 1) * this.perPage() + 1;
  });

  protected readonly rangeEnd = computed(() =>
    Math.min(this.total(), this.page() * this.perPage()),
  );

  protected goPrevious(): void {
    if (this.isFirstPage()) return;
    this.pageChange.emit(this.page() - 1);
  }

  protected goNext(): void {
    if (this.isLastPage()) return;
    this.pageChange.emit(this.page() + 1);
  }
}
