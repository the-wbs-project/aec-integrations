/**
 * The vendor portal's information architecture as data — the single source of
 * truth for the dashboard side-nav.
 *
 * Mirrors `admin/admin-nav.ts`. The paths are **relative**, deliberately: the
 * shell renders them with `routerLink` from a component whose `ActivatedRoute`
 * is the portal's parent route, so `overview` resolves under
 * `/vendor/:vendorSlug` on the real surface and under `/preview/vendor-dashboard`
 * in the dev-only concept preview, with no per-surface branching. An absolute
 * path here would send the preview to the live portal.
 *
 * "Vendor Overview" rather than "Overview": the portal's overview is one of
 * several overview-ish surfaces a signed-in operator meets (the admin console
 * has its own), and the vendor nav sits inside a page whose `h1` is the company
 * name, so naming the scope in the item is what makes the link self-describing
 * out of context — in the nav, in a screen-reader's link list, and in the browser
 * history entry the URL now produces.
 */

/** One nav entry. `path` is relative to the portal's parent route. */
export interface VendorNavItem {
  readonly path: string;
  readonly label: string;
  /**
   * Products is the one section whose nav item carries a filterable menu
   * (`vendor-products-menu.ts`) instead of a plain link, so a vendor can jump
   * straight to a product from anywhere in the portal.
   *
   * A flag rather than a `path === 'products'` string-match in the nav template:
   * this file and `vendor.routes.ts` are meant to be read together, and a
   * template that hard-codes a path silently couples a third file to both.
   */
  readonly hasProductsMenu?: boolean;
}

/**
 * The portal's five sections, in nav order. Adding a section is one entry here
 * plus its child route in `vendor.routes.ts` — the two files are read together
 * and nothing else lists the sections.
 */
export const VENDOR_NAV_ITEMS: readonly VendorNavItem[] = [
  { path: 'overview', label: $localize`:@@vendor.nav.overview:Vendor Overview` },
  { path: 'profile', label: $localize`:@@vendor.nav.profile:Profile` },
  { path: 'products', label: $localize`:@@vendor.nav.products:Products`, hasProductsMenu: true },
  { path: 'integrations', label: $localize`:@@vendor.nav.integrations:Integrations` },
  { path: 'seats', label: $localize`:@@vendor.nav.seats:Seats` },
];

/**
 * Rest-state classes for one item in the horizontal row, shared by the four link
 * items and by the Products disclosure button. Exported rather than written
 * twice because the row has two kinds of control in it now, and a row where one
 * item sits a pixel higher than its neighbours reads as a bug.
 *
 * `-mb-px` + `border-b-2` pulls the item's own bottom border over the row's
 * hairline, which is what turns "a link that is coloured differently" into a
 * tab. Same treatment as the `/search` entity tabs.
 *
 * The underline COLOUR is not a utility: `.aec-nav-tab` in `styles.css` owns it,
 * because the global `*` border-color rule is unlayered and therefore beats
 * `border-transparent` / `border-(--accent-primary)` outright. The class keys off
 * `aria-current`, so the mechanism is identical for the links and the button.
 */
export const VENDOR_NAV_ITEM_CLASS =
  'aec-nav-tab -mb-px flex shrink-0 items-center gap-1 border-b-2 px-1 py-3 ' +
  'text-sm font-medium text-(--text-secondary) no-underline transition-colors ' +
  'hover:text-(--text-primary) focus-visible:rounded-(--radius-sm) focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * Active-state classes, applied by `routerLinkActive` on the link items.
 *
 * Type only — the underline is `.aec-nav-tab[aria-current]`, which both kinds of
 * item get for free. The Products item is a disclosure button and
 * `routerLinkActive` only works on a `routerLink`, so it carries these same two
 * declarations as `aria-[current=true]:` variants (see
 * `vendor-products-menu.ts`). Keep the two in lockstep: the mechanism differs,
 * the treatment must not.
 */
export const VENDOR_NAV_ITEM_ACTIVE_CLASS = 'font-bold text-(--accent-primary)';
