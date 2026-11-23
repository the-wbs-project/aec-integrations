import { Component, input, output } from '@angular/core';

import type { ListingView } from './listing-toolbar';
import { AecIcon } from '../icon/icon';

const VIEW_BTN_BASE =
  'aec-view-toggle-btn inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-mark px-3.5 text-t-14 font-semibold transition-colors duration-fast ease-standard focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * The cards/table segmented toggle. Lifted out of `aec-listing-toolbar` so
 * `/search` renders the same control as `/products` and the taxonomy browse
 * pages (`DESIGN.md` "The Same-Behavior Rule"). `/search` keeps its own sort
 * control beside it, because its options come from the loaded Algolia
 * controller. The product page's integrations section uses it too.
 *
 * Mock-up 10 (AECI-1793): the group draws the 3:1 field edge
 * (`.aec-field-control`), so it is 44px like the sort trigger beside it
 * (1px edge, 3px inset, a 36px button, 3px, 1px). The pressed view is solid
 * Forest, and its glyph turns into a tick (clash 5), so the state is not
 * colour alone. In forced-colours mode the pressed button takes the system
 * selection pair (`.aec-view-toggle-btn` in `styles.css`).
 *
 * Presentation-only: the host owns `?view=` through `createListingView()`.
 */
@Component({
  selector: 'aec-listing-view-toggle',
  imports: [AecIcon],
  template: `
    <div
      role="group"
      class="aec-field-control inline-flex gap-0.5 border bg-(--surface-base) p-[3px]"
      i18n-aria-label="@@listing.toolbar.view.aria"
      aria-label="Choose a view"
    >
      <button
        type="button"
        [class]="viewBtnClass('cards')"
        [attr.aria-pressed]="view() === 'cards'"
        (click)="viewChange.emit('cards')"
      >
        <aec-icon [name]="view() === 'cards' ? 'check' : 'grid'" decorative [size]="4" />
        <span i18n="@@listing.toolbar.view.cards">Cards</span>
      </button>
      <button
        type="button"
        [class]="viewBtnClass('table')"
        [attr.aria-pressed]="view() === 'table'"
        (click)="viewChange.emit('table')"
      >
        <aec-icon [name]="view() === 'table' ? 'check' : 'list'" decorative [size]="4" />
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
      : `${VIEW_BTN_BASE} text-(--text-primary) hover:bg-(--surface-sunken)`;
  }
}
