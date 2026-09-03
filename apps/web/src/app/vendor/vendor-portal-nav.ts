import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import type { VendorProduct } from '@aeci/shared';

import {
  VENDOR_NAV_ITEM_ACTIVE_CLASS,
  VENDOR_NAV_ITEM_CLASS,
  VENDOR_NAV_ITEMS,
} from './vendor-nav';
import { VendorProductsMenu } from './vendor-products-menu';

/**
 * The vendor portal's section nav: a horizontal row of tabs under the company
 * name, above the content.
 *
 * ── WHY IT IS HORIZONTAL ────────────────────────────────────────────────────
 * It was a 14rem side rail in a two-column grid. Five short links do not earn a
 * seventh of a wide page, and the content they front (a profile form, a product
 * form, an integration list) is the thing that wants the width. Horizontal also
 * puts the section row directly above the panel it switches, which is what makes
 * it read as a tab row rather than as a second site nav.
 *
 * ── WHY IT IS NOT STICKY ────────────────────────────────────────────────────
 * `shared/section-nav/section-nav.ts` is sticky because it is an in-page jump nav
 * on a long editorial scroll, where the target moves under the reader. A router
 * nav has no such coupling: the sections are short, and each one is its own
 * document. Sticky would also have to live on the host (a sticky `<nav>` is
 * trapped inside its parent's box) for no gain.
 *
 * ── ONE ROW AT EVERY WIDTH ──────────────────────────────────────────────────
 * Narrow viewports scroll the row sideways rather than wrapping it: a wrapped tab
 * row breaks its own underline across two lines. There is deliberately NO
 * `md:hidden` mobile duplicate, which would put every nav item in the DOM twice
 * and hand the specs (and a screen reader's link list) two of everything.
 *
 * ── THE PRODUCTS ITEM ───────────────────────────────────────────────────────
 * Products is a filterable dropdown rather than a link, because it is the one
 * section with a set of things underneath it (see `vendor-products-menu.ts`).
 * A vendor with ONE product (or none) gets a plain link instead: a dropdown over
 * a single option is noise, and it keeps the section reachable in the degenerate
 * case. That mirrors the rule the in-page picker used to carry.
 *
 * Presentational: the products come down as an input from the shell, which takes
 * them from `me`. Nothing here injects `VendorPortalStore` — the store is not
 * root-provided (the preview shadows it), and an input keeps this component
 * testable with no DI at all.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-portal-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, VendorProductsMenu],
  template: `
    <nav
      i18n-aria-label="@@vendor.nav.aria"
      aria-label="Portal sections"
      class="mb-8 border-b border-(--border-default)"
    >
      <ul class="m-0 flex list-none gap-x-6 overflow-x-auto p-0 whitespace-nowrap">
        @for (item of navItems; track item.path) {
          <li class="shrink-0">
            @if (item.hasProductsMenu && products().length > 1) {
              <aec-vendor-products-menu [products]="products()" [label]="item.label" />
            } @else {
              <a
                [routerLink]="item.path"
                [routerLinkActive]="activeClass"
                ariaCurrentWhenActive="page"
                [class]="itemClass"
              >
                {{ item.label }}
              </a>
            }
          </li>
        }
      </ul>
    </nav>
  `,
  styles: [':host { display: block; }'],
})
export class VendorPortalNav {
  /** This vendor's catalog. Only used to decide whether Products is a menu or a
   *  link, and to fill the menu. */
  readonly products = input.required<readonly VendorProduct[]>();

  /** The portal IA. Relative paths, deliberately: one template serves
   *  `/vendor/:vendorSlug` and `/preview/vendor-dashboard`. */
  protected readonly navItems = VENDOR_NAV_ITEMS;
  protected readonly itemClass = VENDOR_NAV_ITEM_CLASS;
  protected readonly activeClass = VENDOR_NAV_ITEM_ACTIVE_CLASS;
}
