import { Component, input, output } from '@angular/core';

import type { ListingView } from './listing-toolbar';
import { AecIcon } from '../icon/icon';

const VIEW_BTN_BASE =
  'inline-flex items-center gap-1.5 rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * The cards/table segmented toggle. Lifted out of `aec-listing-toolbar` so
 * `/search` renders the same control as `/products` and the taxonomy browse
 * pages (`DESIGN.md` "The Same-Behavior Rule"). `/search` keeps its own sort
 * control beside it, because its options come from the loaded Algolia
 * controller.
 *
 * Presentation-only: the host owns `?view=` through `createListingView()`.
 * The 42px height matches the sort trigger in `aec-listing-sort-select`
 * (2px border + 8px p-1 + 12px py-1.5 + 20px text-sm line box).
 */
@Component({
  selector: 'aec-listing-view-toggle',
  imports: [AecIcon],
  template: `
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
        <aec-icon name="grid" decorative [size]="4" />
        <span i18n="@@listing.toolbar.view.cards">Cards</span>
      </button>
      <button
        type="button"
        [class]="viewBtnClass('table')"
        [attr.aria-pressed]="view() === 'table'"
        (click)="viewChange.emit('table')"
      >
        <aec-icon name="list" decorative [size]="4" />
        <span i18n="@@listing.toolbar.view.table">Table</span>
      </button>
    </div>
  `,
})
export class ListingViewToggle {
  /** Active view; drives each button's pressed state. */
  readonly view = input.required<ListingView>();

  /** The chosen view. The host writes it to the URL. */
  readonly viewChange = output<ListingView>();

  protected viewBtnClass(value: ListingView): string {
    return this.view() === value
      ? `${VIEW_BTN_BASE} bg-(--accent-primary) text-(--surface-base)`
      : `${VIEW_BTN_BASE} text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
