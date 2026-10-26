import { Component, input, output } from '@angular/core';

import { ListingSortSelect, type ListingSortOption } from './listing-sort-select';
import { ListingViewToggle } from './listing-view-toggle';

/** The two catalog views. Mirrors the `?view=` param each host owns. */
export type ListingView = 'cards' | 'table';

/**
 * The listing toolbar: the sort control on the start edge, a cards/table
 * segmented toggle on the end edge (AECI-190, extracted from `products-index.ts`
 * by AECI-657). Both halves are their own components, `aec-listing-sort-select`
 * and `aec-listing-view-toggle`, so `/search` renders the identical two controls
 * in its own toolbar row.
 *
 * **Why it is shared.** AECI-190 built this markup inline in the `/products`
 * template, so the taxonomy browse pages — which render the same catalog, from
 * the same `/api/products` endpoint, through the same `createPaginatedIndex`
 * controller — shipped with no toolbar at all, against `STAGE_1_SPEC.md` §4.5's
 * "Product grid with sort options". Extracting it is what stops the two
 * surfaces drifting a second time.
 *
 * **Which sort control.** The Angular Aria combobox `/search` already used
 * (ADR 0010). Until 2026-10-26 this toolbar carried a native `<select>` instead,
 * so sorting worked with no JS. The 2026-10-26 ruling put one control on every
 * listing, so the no-JS path now has no working sort; a `?sort=` in the URL still
 * renders that order on first paint.
 *
 * **Presentation-only.** The host owns the source of truth: both `sort` and
 * `view` live in the URL (`?sort=` / `?view=`), because both fork the edge cache
 * key and must survive a reload and a share. The toolbar renders the current
 * values and emits the requested ones; it holds no state and performs no
 * navigation.
 *
 * Both themes are irrelevant in Stage 1 — light only (AECI-226); every color is
 * a semantic token.
 */
@Component({
  selector: 'aec-listing-toolbar',
  imports: [ListingSortSelect, ListingViewToggle],
  // A custom element defaults to `display: inline`, and vertical margins never
  // apply to an inline box — so the hosts' `space-y-6` on the grid slot silently
  // collapsed to nothing and the first card sat flush against the toolbar.
  host: { class: 'block' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <aec-listing-sort-select
        [options]="sortOptions()"
        [value]="sort()"
        (sortChange)="sortChange.emit($event)"
      />

      <aec-listing-view-toggle [view]="view()" (viewChange)="viewChange.emit($event)" />
    </div>
  `,
})
export class ListingToolbar {
  /** Sort choices, already localized by the host. */
  readonly sortOptions = input.required<readonly ListingSortOption[]>();

  /** Active `?sort=` key — shown in the sort trigger and ticked in its list. */
  readonly sort = input.required<string>();

  /** Active `?view=` — drives the toggle's pressed state. */
  readonly view = input.required<ListingView>();

  /** The chosen sort key. The host validates it and writes it to the URL. */
  readonly sortChange = output<string>();

  /** The chosen view. The host writes it to the URL. */
  readonly viewChange = output<ListingView>();
}
