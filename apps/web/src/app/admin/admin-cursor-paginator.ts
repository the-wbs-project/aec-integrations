import { Component, input, output } from '@angular/core';

/**
 * Previous / next paging over a keyset cursor (ADR 0046), first used by the
 * global audit log at `/admin/audit` (`ADMIN_PANEL_SPEC.md` §5.18).
 *
 * The sibling of `AdminPaginator`, which pages by number. A cursor page has no
 * page number and no page count, so this control offers Previous, Next and,
 * once the operator has left the first page, First page. It states no position:
 * the caller's result line already carries the count, and saying it twice is
 * noise. Keyset paging cannot
 * jump to page N, and on a ledger scanned by date nobody wants to.
 *
 * Rows per page is a native select. ADR 0010 sends new form-control patterns to
 * Angular Aria, but a single native select is the lightest accessible control
 * here and needs no overlay. The label wraps the select, so a page can render
 * this control twice (above and below its table) without duplicate ids.
 *
 * Presentational: the parent owns the cursors and refetches on every output.
 * While `busy`, every control is disabled, so a second press cannot race the
 * first fetch.
 */
@Component({
  selector: 'aec-admin-cursor-paginator',
  template: `
    <nav class="flex flex-wrap items-center justify-end gap-3" [attr.aria-label]="label()">
      <div class="flex flex-wrap items-center gap-2">
        @if (pageSizes().length > 1) {
          <label class="inline-flex items-center gap-2 text-xs text-(--text-secondary)">
            <span i18n="@@admin.cursorPaginator.perPage">Rows per page</span>
            <select
              [value]="perPage()"
              [disabled]="busy()"
              (change)="onPerPage($event)"
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-2 py-1.5 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
            >
              @for (size of pageSizes(); track size) {
                <option [value]="size" [selected]="size === perPage()">{{ size }}</option>
              }
            </select>
          </label>
        }
        @if (canFirst()) {
          <button
            type="button"
            [disabled]="busy()"
            (click)="first.emit()"
            class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
              bg-(--surface-raised) px-4 py-2 text-sm font-bold text-(--text-primary)
              transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)
              disabled:cursor-not-allowed disabled:opacity-50"
            i18n="@@admin.cursorPaginator.first"
          >
            First page
          </button>
        }
        <button
          type="button"
          [disabled]="busy() || !hasPrev()"
          (click)="prev.emit()"
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
          [disabled]="busy() || !hasNext()"
          (click)="next.emit()"
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
  `,
  styles: [':host { display: block; }'],
})
export class AdminCursorPaginator {
  /** A page exists before this one, and the caller holds its cursor. */
  readonly hasPrev = input.required<boolean>();
  /** A page exists after this one, and the caller holds its cursor. */
  readonly hasNext = input.required<boolean>();
  /** Show "First page". Usually `hasPrev`, but also an empty page reached by a
   *  cursor, whose cursors are null while rows still exist before it. */
  readonly canFirst = input.required<boolean>();
  readonly perPage = input.required<number>();
  /** The sizes to offer. Fewer than two hides the select. */
  readonly pageSizes = input<readonly number[]>([]);
  readonly busy = input(false);
  /** The nav's accessible name. Distinct per instance when rendered twice. */
  readonly label = input($localize`:@@admin.paginator.aria:Pagination`);

  readonly prev = output<void>();
  readonly next = output<void>();
  readonly first = output<void>();
  readonly pageSizeChange = output<number>();

  protected onPerPage(event: Event): void {
    const size = Number((event.target as HTMLSelectElement).value);
    if (Number.isInteger(size) && size !== this.perPage()) this.pageSizeChange.emit(size);
  }
}
