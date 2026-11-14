import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { type BrowseMenuModel, EMPTY_BROWSE_MENU } from '../core/taxonomy/browse-menu-model';
import { AecIcon } from '../shared/icon/icon';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { facetNavLabel, facetSeeAllLabel } from './taxonomy-nav-copy';

/** The four facet columns, in the desktop column order (PLAN.md §4.8). */
const FACET_COLUMNS: readonly TaxonomyKind[] = ['category', 'phase', 'audience', 'trade'];

/** A destination inside the white panel: a Forest ring (Bone is invisible on white). */
const LINK =
  'group block rounded-mark no-underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
/** A destination's text: weight 400, a Clay underline on hover. */
const TEXT =
  'block font-normal text-(--text-primary) underline decoration-transparent decoration-[length:1.5px] underline-offset-4 transition-colors duration-base ease-standard group-hover:decoration-(--accent-secondary)';

/**
 * The Browse panel's body (AECI-1774, DESIGN.md §5 "The Browse menu"): the Explore
 * column ("All products" and the key categories), then Categories, Phases,
 * Audiences and Trades, each ending in "See all", then the footer line that states
 * the orders. `browse-menu.ts` owns the trigger, the open state and the panel box.
 *
 * Its own component so it can sit in a `@defer` block and stay out of the initial
 * bundle. With incremental hydration the server still renders it in full, so the
 * cached HTML carries "All products", the column labels and the "See all" links.
 *
 * The terms and counts wait for the first browser render (`ready`). The server
 * renders none, and a block hydrated later must start from the same empty lists
 * the server sent, or hydration would meet DOM it did not expect.
 *
 * Every destination is a plain `<a href>` with no listener and no `RouterLink`.
 * So the server HTML carries no event-replay marker inside this block, and a link
 * works before the block hydrates, or if its chunk never loads (a tab left open
 * across a deploy). The menu's panel box (`browse-menu.ts`) is eager and catches
 * the click: it closes the menu and routes in the app. Without it the browser
 * follows the href.
 */
@Component({
  selector: 'aec-browse-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecIcon],
  host: { class: 'mx-auto block max-w-7xl px-8 pt-12 pb-8' },
  template: `
    <div class="grid grid-cols-5 gap-x-6 xl:gap-x-8">
      <div class="min-w-0">
        <p
          id="browse-col-explore"
          class="aec-overline mb-4 text-(--text-secondary)"
          i18n="@@app.nav.browse.explore"
        >
          Explore
        </p>
        <a href="/products" [class]="linkClass">
          <span [class]="keyTextClass" i18n="@@app.nav.browse.allProducts">All products</span>
          @let total = shown().totalProducts;
          @if (total !== undefined) {
            <span [class]="countClass">{{ countText(total) }}</span>
          }
        </a>
        <p
          id="browse-col-key"
          class="aec-overline mt-3 mb-3 border-t pt-4 text-(--text-secondary)"
          i18n="@@app.nav.browse.keyCategories"
        >
          Key categories
        </p>
        <ul aria-labelledby="browse-col-key">
          @for (term of shown().keyCategories; track term.id) {
            <li>
              <a [href]="'/categories/' + term.slug" [class]="linkClass">
                <span [class]="keyTextClass">{{ term.name }}</span>
                <span [class]="countClass">{{ countText(term.product_count) }}</span>
              </a>
            </li>
          }
        </ul>
      </div>

      @for (column of columns(); track column.kind) {
        <div class="min-w-0">
          <p [id]="'browse-col-' + column.kind" class="aec-overline mb-4 text-(--text-secondary)">
            {{ column.label }}
          </p>
          <ul [attr.aria-labelledby]="'browse-col-' + column.kind">
            @for (term of column.terms; track term.id) {
              <li>
                <a [href]="column.path + '/' + term.slug" [class]="termLinkClass">
                  <span [class]="termTextClass">{{ term.name }}</span>
                  <span [class]="countClass">{{ countText(term.product_count) }}</span>
                </a>
              </li>
            }
          </ul>
          <a
            [href]="column.path"
            class="mt-2 inline-flex items-center gap-2 rounded-mark py-2 text-t-16 font-normal text-(--text-secondary) underline underline-offset-4 hover:text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            >{{ column.seeAll }}<aec-icon name="arrow-right" decorative [size]="4"
          /></a>
        </div>
      }
    </div>
    <p class="mt-6 border-t pt-4 text-t-13 text-(--text-tertiary)" i18n="@@app.nav.browse.footer">
      Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in
      project order.
    </p>
  `,
})
export class BrowsePanel {
  readonly menu = input.required<BrowseMenuModel>();

  private readonly ready = signal(false);

  constructor() {
    afterNextRender(() => this.ready.set(true));
  }

  /** Empty on the server and on the hydrating render, then the store's model. */
  protected readonly shown = computed(() => (this.ready() ? this.menu() : EMPTY_BROWSE_MENU));

  protected readonly linkClass = LINK;
  protected readonly termLinkClass = `${LINK} py-2`;
  /** A key item and "All products": serif 24px at weight 400 (DESIGN.md §5 "Panel type"). */
  protected readonly keyTextClass = `${TEXT} pt-0.5 font-serif text-t-24 leading-[1.1] tracking-[-0.01em]`;
  /** A term: 16px at weight 400, pinned so no row weight reaches the panel. */
  protected readonly termTextClass = `${TEXT} text-t-16 leading-tight`;
  /** A count: a quiet tabular number, tertiary ink on the white panel (4.83:1). */
  protected readonly countClass = 'mt-0.5 mb-3 block text-t-13 tabular-nums text-(--text-tertiary)';

  protected readonly columns = computed(() => {
    const menu = this.shown();
    const terms = {
      category: menu.categories,
      phase: menu.phases,
      audience: menu.audiences,
      trade: menu.trades,
    } as const;
    return FACET_COLUMNS.map((kind) => ({
      kind,
      label: facetNavLabel(kind),
      seeAll: facetSeeAllLabel(kind),
      path: `/${KIND_PATH_SEGMENT[kind]}`,
      terms: terms[kind],
    }));
  });

  /**
   * "1 product" or "N products", under each destination. The leading space keeps
   * the link's accessible name "AI 69 products", not "AI69 products": the two
   * spans are blocks on screen, but a name is computed from text.
   */
  protected countText(count: number): string {
    const label =
      count === 1
        ? $localize`:@@app.nav.browse.countOne:1 product`
        : $localize`:@@app.nav.browse.countOther:${count}:count: products`;
    return ` ${label}`;
  }
}
