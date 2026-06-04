import { Component, computed, input, output } from '@angular/core';

/**
 * Sortable `<th>` cell for `IndexLayout`'s table-header slot. Wraps a real
 * `<button>` so keyboard activation works out of the box, and reflects the
 * active sort axis via `aria-sort` (`ascending` / `descending` / `none`).
 *
 * Phase 2 (AECI-58) ships three sortable axes for `/products`: `name`,
 * `created`, `updated`. The component is intentionally string-key based —
 * `IndexKey` is a free `string` — so the same primitive can be reused on
 * `/vendors` and `/integrations` without coupling to a single union.
 *
 * Spec: Phase 2 Spec §7.4 — server resolves direction from key
 * (`created → DESC`, `name → ASC`, `updated → DESC`), so this component does
 * NOT toggle ASC/DESC on repeated clicks. Activating the already-active
 * column is a no-op visually (the server result is identical); we still emit
 * `(sortChange)` so the page can decide what to do.
 *
 * `direction` must match the server's fixed sort order for the key — it drives
 * both `aria-sort` (WCAG 1.3.1) and the visual indicator glyph (↑ / ↓).
 */
@Component({
  selector: 'aec-sortable-column-header',
  template: `
    <th scope="col" [attr.aria-sort]="ariaSort()" class="px-4 py-3">
      <button
        type="button"
        class="-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium tracking-wide uppercase transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        [class.text-(--text-primary)]="isActive()"
        [class.text-(--text-secondary)]="!isActive()"
        (click)="onClick()"
      >
        <span>{{ label() }}</span>
        @if (isActive()) {
          <span aria-hidden="true" class="text-(--text-secondary)">{{
            direction() === 'ascending' ? '↑' : '↓'
          }}</span>
        }
      </button>
    </th>
  `,
})
export class SortableColumnHeader {
  readonly key = input.required<string>();
  readonly currentSort = input.required<string>();
  readonly label = input.required<string>();
  readonly direction = input.required<'ascending' | 'descending'>();

  readonly sortChange = output<string>();

  protected readonly isActive = computed(() => this.key() === this.currentSort());

  protected readonly ariaSort = computed<'ascending' | 'descending' | 'none'>(() =>
    this.isActive() ? this.direction() : 'none',
  );

  protected onClick(): void {
    this.sortChange.emit(this.key());
  }
}
