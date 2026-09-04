import { Component, input, output } from '@angular/core';

/** One sort choice the toolbar renders. `value` is the `?sort=` key handed back
 *  through `(sortChange)`; `label` is the already-localized display string. */
export interface ListingSortOption {
  readonly value: string;
  readonly label: string;
}

/** The two catalog views. Mirrors the `?view=` param each host owns. */
export type ListingView = 'cards' | 'table';

/**
 * Per-instance id seed so the `<label for>` ↔ `<select id>` association stays
 * unique if two toolbars ever co-exist on one page. Rendered during SSR, so it
 * must be deterministic per render — it is, since the counter advances in
 * construction order and SSR and hydration construct in the same order.
 */
let nextToolbarId = 0;

const VIEW_BTN_BASE =
  'inline-flex items-center gap-1.5 rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * The listing toolbar: a sort `<select>` on the start edge, a cards/table
 * segmented toggle on the end edge (AECI-190, extracted from `products-index.ts`
 * by AECI-657).
 *
 * **Why it is shared.** AECI-190 built this markup inline in the `/products`
 * template, so the taxonomy browse pages — which render the same catalog, from
 * the same `/api/products` endpoint, through the same `createPaginatedIndex`
 * controller — shipped with no toolbar at all, against `STAGE_1_SPEC.md` §4.5's
 * "Product grid with sort options". Extracting it is what stops the two
 * surfaces drifting a second time.
 *
 * **Presentation-only.** The host owns the source of truth: both `sort` and
 * `view` live in the URL (`?sort=` / `?view=`), because both fork the edge cache
 * key and must survive a reload and a share. The toolbar renders the current
 * values and emits the requested ones; it holds no state and performs no
 * navigation. This mirrors `aec-search-sort-by` on `/search`, where the
 * controller likewise owns the truth.
 *
 * **A native `<select>`, deliberately.** `/search` uses an Angular Aria combobox
 * (ADR 0010) because its options are built browser-side from the loaded Algolia
 * controller. Here the options are static and SSR-rendered, and a native select
 * needs no JS to be operable — so the degraded/no-JS path keeps a working sort
 * control. Two different mechanisms for two different constraints, not drift.
 *
 * Both themes are irrelevant in Stage 1 — light only (AECI-226); every color is
 * a semantic token.
 */
@Component({
  selector: 'aec-listing-toolbar',
  // A custom element defaults to `display: inline`, and vertical margins never
  // apply to an inline box — so the hosts' `space-y-6` on the grid slot silently
  // collapsed to nothing and the first card sat flush against the toolbar.
  host: { class: 'block' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="inline-flex items-center gap-2">
        <label
          [for]="sortId"
          class="text-sm text-(--text-secondary)"
          i18n="@@listing.toolbar.sort.label"
          >Sort</label
        >
        <!-- py-2.5 is not arbitrary: it makes the select 42px, matching the view
             toggle beside it (2px border + 8px p-1 + 12px py-1.5 + 20px text-sm
             line box). Change one side and change the other. -->
        <div class="relative">
          <select
            [id]="sortId"
            class="appearance-none rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-base) py-2.5 pe-9 ps-3 text-sm text-(--text-primary)
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            (change)="onSortChange($event)"
          >
            @for (option of sortOptions(); track option.value) {
              <option [value]="option.value" [selected]="option.value === sort()">
                {{ option.label }}
              </option>
            }
          </select>
          <svg
            class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </div>

      <div
        role="group"
        class="inline-flex gap-1 rounded-(--radius-md) border border-(--border-default)
          bg-(--surface-raised) p-1"
        i18n-aria-label="@@listing.toolbar.view.aria"
        aria-label="Choose a view"
      >
        <button
          type="button"
          [class]="viewBtnClass('cards')"
          [attr.aria-pressed]="view() === 'cards'"
          (click)="viewChange.emit('cards')"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect width="7" height="7" x="3" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="14" rx="1" />
            <rect width="7" height="7" x="3" y="14" rx="1" />
          </svg>
          <span i18n="@@listing.toolbar.view.cards">Cards</span>
        </button>
        <button
          type="button"
          [class]="viewBtnClass('table')"
          [attr.aria-pressed]="view() === 'table'"
          (click)="viewChange.emit('table')"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="8" x2="21" y1="6" y2="6" />
            <line x1="8" x2="21" y1="12" y2="12" />
            <line x1="8" x2="21" y1="18" y2="18" />
            <line x1="3" x2="3.01" y1="6" y2="6" />
            <line x1="3" x2="3.01" y1="12" y2="12" />
            <line x1="3" x2="3.01" y1="18" y2="18" />
          </svg>
          <span i18n="@@listing.toolbar.view.table">Table</span>
        </button>
      </div>
    </div>
  `,
})
export class ListingToolbar {
  /** Sort choices, already localized by the host. */
  readonly sortOptions = input.required<readonly ListingSortOption[]>();

  /** Active `?sort=` key — marks the matching `<option>` selected. */
  readonly sort = input.required<string>();

  /** Active `?view=` — drives the toggle's pressed state. */
  readonly view = input.required<ListingView>();

  /** The chosen sort key. The host validates it and writes it to the URL. */
  readonly sortChange = output<string>();

  /** The chosen view. The host writes it to the URL. */
  readonly viewChange = output<ListingView>();

  protected readonly sortId = `aec-listing-sort-${nextToolbarId++}`;

  protected onSortChange(event: Event): void {
    this.sortChange.emit((event.target as HTMLSelectElement).value);
  }

  protected viewBtnClass(value: ListingView): string {
    return this.view() === value
      ? `${VIEW_BTN_BASE} bg-(--accent-primary) text-(--surface-base)`
      : `${VIEW_BTN_BASE} text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
