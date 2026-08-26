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
}

/**
 * The portal's five sections, in nav order. Adding a section is one entry here
 * plus its child route in `vendor.routes.ts` — the two files are read together
 * and nothing else lists the sections.
 */
export const VENDOR_NAV_ITEMS: readonly VendorNavItem[] = [
  { path: 'overview', label: $localize`:@@vendor.nav.overview:Vendor Overview` },
  { path: 'profile', label: $localize`:@@vendor.nav.profile:Profile` },
  { path: 'products', label: $localize`:@@vendor.nav.products:Products` },
  { path: 'integrations', label: $localize`:@@vendor.nav.integrations:Integrations` },
  { path: 'seats', label: $localize`:@@vendor.nav.seats:Seats` },
];
