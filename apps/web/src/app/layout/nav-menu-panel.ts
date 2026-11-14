import { afterNextRender, Component, computed, input, signal } from '@angular/core';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { type BrowseMenuModel, EMPTY_BROWSE_MENU } from '../core/taxonomy/browse-menu-model';
import { AecIcon } from '../shared/icon/icon';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { browseCountText, facetNavLabel, facetSeeAllLabel } from './taxonomy-nav-copy';

/** The four sections, in the desktop Browse menu's column order (PLAN.md §4.8). */
const SECTIONS: readonly TaxonomyKind[] = ['category', 'phase', 'audience', 'trade'];

/** The ring inside the white panel is Forest: Bone is invisible on white. */
const RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
/** A destination with a name and a count on one line, name at the start. */
const ROW = `group flex flex-wrap items-baseline justify-between gap-x-3 rounded-mark text-(--text-primary) no-underline ${RING}`;
/** A name: a Clay underline on hover, as on the desktop panel (DESIGN.md §5). */
const NAME =
  'min-w-0 wrap-anywhere underline decoration-transparent decoration-[length:1.5px] underline-offset-4 transition-colors duration-base ease-standard group-hover:decoration-(--accent-secondary)';
/** A count: a quiet tabular number, tertiary ink on the white panel (4.83:1). */
const COUNT = 'shrink-0 text-t-13 font-normal tabular-nums text-(--text-tertiary)';
/** A top-level row ("Categories", "How we rank"): serif 600 at 20px, 58px high. */
const TOP_ROW = `group flex min-h-[58px] w-full items-center justify-between gap-3 rounded-mark text-start font-serif text-t-20 leading-tight font-semibold tracking-[-0.01em] text-(--text-primary) no-underline ${RING}`;

/**
 * The mobile menu's body (AECI-1775, DESIGN.md §5 "The mobile menu"). `nav-menu.ts`
 * owns the toggle, the open state, the focus trap and the panel box.
 *
 * Order: "All products" and the key categories, then four tap-to-expand
 * sections (Categories, Phases, Audiences, Trades), then How we rank and For
 * vendors, then the footer line that states the orders. Every list comes from
 * `TaxonomyNavStore.browse`, the model the desktop Browse menu reads
 * (`browse-menu-model.ts`), so the two menus cannot order differently. This
 * component sorts and filters nothing.
 *
 * Its own component so it can sit in a `@defer (on idle; hydrate on idle)` block
 * and stay out of the initial bundle. The server renders it in full (hidden until
 * opened), so cached HTML carries "All products", the section buttons, every
 * "See all" link, How we rank, For vendors and the footer line. The terms and
 * counts wait for the first browser render (`ready`), as in `browse-panel.ts`, so
 * a block hydrated later starts from the same empty lists the server sent.
 *
 * Every destination is a plain `<a href>` with no listener and no `RouterLink`.
 * The eager panel box in `nav-menu.ts` catches the click, closes the menu and
 * routes in the app. So a tap lands whether or not this block has hydrated, and
 * if its chunk never loads. The section buttons do have a listener. A tap on one
 * before this block hydrates is queued by event replay, hydrates the block and
 * replays, so the section opens a moment later rather than never.
 */
@Component({
  selector: 'aec-nav-menu-panel',
  imports: [AecIcon],
  host: { class: 'block' },
  template: `
    <ul>
      <li class="border-b pt-3 pb-4">
        <a href="/products" [class]="bigRowClass">
          <span [class]="bigNameClass" i18n="@@app.nav.browse.allProducts">All products</span>
          @let total = shown().totalProducts;
          @if (total !== undefined) {
            <span [class]="countClass">{{ countText(total) }}</span>
          }
        </a>
        @if (shown().keyCategories.length > 0) {
          <p
            id="nav-menu-key"
            class="aec-overline mt-2 mb-1 border-t pt-4 text-(--text-secondary)"
            i18n="@@app.nav.browse.keyCategories"
          >
            Key categories
          </p>
          <ul aria-labelledby="nav-menu-key">
            @for (term of shown().keyCategories; track term.id) {
              <li>
                <a [href]="'/categories/' + term.slug" [class]="bigRowClass">
                  <span [class]="bigNameClass">{{ term.name }}</span>
                  <span [class]="countClass">{{ countText(term.product_count) }}</span>
                </a>
              </li>
            }
          </ul>
        }
      </li>

      @for (section of sections(); track section.kind) {
        <li class="border-b">
          <button
            type="button"
            [id]="'nav-menu-btn-' + section.kind"
            [class]="topRowClass"
            [attr.aria-expanded]="isOpen(section.kind)"
            [attr.aria-controls]="'nav-menu-sec-' + section.kind"
            (click)="toggle(section.kind)"
          >
            <span [class]="nameClass">{{ section.label }}</span>
            <!-- aec-icon's host is display: contents, so the turn goes on a wrapper. -->
            <span
              data-chevron
              class="inline-flex shrink-0 text-(--text-secondary) transition-transform duration-base ease-standard motion-reduce:transition-none"
              [class.rotate-180]="isOpen(section.kind)"
              ><aec-icon name="chevron-down" decorative [size]="5"
            /></span>
          </button>
          <div [id]="'nav-menu-sec-' + section.kind" [hidden]="!isOpen(section.kind)" class="pb-4">
            <ul [attr.aria-labelledby]="'nav-menu-btn-' + section.kind">
              @for (term of section.terms; track term.id) {
                <li>
                  <a [href]="section.path + '/' + term.slug" [class]="termRowClass">
                    <span [class]="nameClass">{{ term.name }}</span>
                    <span [class]="countClass">{{ countText(term.product_count) }}</span>
                  </a>
                </li>
              }
            </ul>
            <a [href]="section.path" [class]="seeAllClass"
              >{{ section.seeAll }}<aec-icon name="arrow-right" decorative [size]="4"
            /></a>
          </div>
        </li>
      }

      <li class="border-b">
        <a href="/docs/trust/how-ranking-works" [class]="topRowClass"
          ><span [class]="nameClass">{{ labels.howWeRank }}</span></a
        >
      </li>
      <li class="border-b">
        <a href="/vendor-program" [class]="topRowClass"
          ><span [class]="nameClass">{{ labels.forVendors }}</span></a
        >
      </li>
    </ul>
    <p class="mt-4 text-t-13 text-(--text-tertiary)" i18n="@@app.nav.browse.footer">
      Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in
      project order.
    </p>
  `,
})
export class NavMenuPanel {
  readonly menu = input.required<BrowseMenuModel>();

  private readonly ready = signal(false);
  private readonly openSections = signal<ReadonlySet<TaxonomyKind>>(new Set());

  constructor() {
    afterNextRender(() => this.ready.set(true));
  }

  /** Empty on the server and on the hydrating render, then the store's model. */
  protected readonly shown = computed(() => (this.ready() ? this.menu() : EMPTY_BROWSE_MENU));

  protected readonly countClass = COUNT;
  /** "See all <facet>": 16px at 400, secondary ink, underlined, 44px target. */
  protected readonly seeAllClass = `mt-2 inline-flex min-h-11 items-center gap-2 rounded-mark text-t-16 font-normal text-(--text-secondary) underline underline-offset-4 hover:text-(--text-primary) ${RING}`;
  /** "All products" and a key category: serif 24px at 400, 48px high. */
  protected readonly bigRowClass = `${ROW} min-h-12 py-2`;
  /** A term in a section: 16px at 400, 44px high (DESIGN.md §5 "Panel type"). */
  protected readonly termRowClass = `${ROW} min-h-11 py-3 text-t-16 font-normal leading-tight`;
  protected readonly topRowClass = TOP_ROW;
  protected readonly nameClass = NAME;
  protected readonly bigNameClass = `${NAME} font-serif text-t-24 leading-[1.1] tracking-[-0.01em]`;
  protected readonly countText = browseCountText;

  /** The same ids and copy as the desktop row (`site-header.ts`). */
  protected readonly labels = {
    howWeRank: $localize`:@@app.nav.howWeRank:How we rank`,
    forVendors: $localize`:@@app.nav.forVendors:For vendors`,
  };

  protected readonly sections = computed(() => {
    const menu = this.shown();
    const terms = {
      category: menu.categories,
      phase: menu.phases,
      audience: menu.audiences,
      trade: menu.trades,
    } as const;
    return SECTIONS.map((kind) => ({
      kind,
      label: facetNavLabel(kind),
      seeAll: facetSeeAllLabel(kind),
      path: `/${KIND_PATH_SEGMENT[kind]}`,
      terms: terms[kind],
    }));
  });

  protected isOpen(kind: TaxonomyKind): boolean {
    return this.openSections().has(kind);
  }

  protected toggle(kind: TaxonomyKind): void {
    const next = new Set(this.openSections());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.openSections.set(next);
  }
}
