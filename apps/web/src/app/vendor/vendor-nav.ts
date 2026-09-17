/**
 * The vendor portal's information architecture as data — the single source of
 * truth for the dashboard's nav rows.
 *
 * **Two route levels since AECI-666, ONE row on screen since §6.11**:
 * {@link VENDOR_NAV_ITEMS} is the row in vendor context, and
 * {@link VENDOR_PRODUCT_NAV_ITEMS} REPLACES it once a product is open. The shell
 * (`vendor-dashboard-tabbed.ts`) swaps the whole header — breadcrumb, title,
 * public link and tab row — to the product, so the two rows are never stacked.
 * AECI-959's segmented product row is gone with that change: both rows now use
 * the same underlined tab treatment, because only one is ever visible.
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

/**
 * One nav entry. `path` is relative to the route that renders the row: the
 * portal's parent route for {@link VENDOR_NAV_ITEMS}, the product route for
 * {@link VENDOR_PRODUCT_NAV_ITEMS} (the shell prefixes those with
 * `products/:productSlug/` because it renders both rows from the parent).
 */
export interface VendorNavItem {
  readonly path: string;
  readonly label: string;
}

/**
 * The portal's five VENDOR-level sections, in nav order. Adding a section is one
 * entry here plus its child route in `vendor.routes.ts` — the two files are read
 * together and nothing else lists the sections.
 *
 * ── WHY INTEGRATIONS IS NOT HERE ANY MORE (AECI-666) ────────────────────────
 * It moved down a level, to {@link VENDOR_PRODUCT_NAV_ITEMS}. An integration is
 * a thing that happens *to a product*, and a vendor with a dozen products was
 * reading one flat list to answer a per-product question. Its slot in the row is
 * taken by Messages, which is the surface that genuinely is vendor-wide: claim
 * approvals, seat changes and attestation nudges are addressed to the company,
 * not to one of its products.
 */
export const VENDOR_NAV_ITEMS: readonly VendorNavItem[] = [
  { path: 'overview', label: $localize`:@@vendor.nav.overview:Vendor Overview` },
  { path: 'profile', label: $localize`:@@vendor.nav.profile:Profile` },
  { path: 'products', label: $localize`:@@vendor.nav.products:Products` },
  { path: 'messages', label: $localize`:@@vendor.nav.messages:Messages` },
  { path: 'seats', label: $localize`:@@vendor.nav.seats:Seats` },
];

/**
 * The PRODUCT-level sections (AECI-666) — the row that takes over from
 * {@link VENDOR_NAV_ITEMS} on `…/products/:productSlug/*` (§6.11).
 *
 * Paths are relative to the product route, so the same two-file rule holds one
 * level down: an entry here plus a child route under `products/:productSlug`.
 *
 * "Profile" and not "Product Profile": unlike the vendor row — whose Overview
 * item names its scope because several overview-ish surfaces exist for one
 * signed-in operator — this row sits directly beneath an `h1` that is the
 * product's own name, under a breadcrumb ending in that name, inside a nav
 * labelled for that product. The scope is already said three times.
 */
export const VENDOR_PRODUCT_NAV_ITEMS: readonly VendorNavItem[] = [
  { path: 'profile', label: $localize`:@@vendor.productNav.profile:Profile` },
  { path: 'taxonomy', label: $localize`:@@vendor.productNav.taxonomy:Taxonomy` },
  { path: 'integrations', label: $localize`:@@vendor.productNav.integrations:Integrations` },
];

/**
 * Rest-state classes for one tab in either row.
 *
 * `-mb-px` + `border-b-2` pulls the item's own bottom border over the row's
 * hairline, which is what turns "a link that is coloured differently" into a
 * tab. Same treatment as the `/search` entity tabs.
 *
 * The underline COLOUR is not a utility: `.aec-nav-tab` in `styles.css` owns it,
 * because the global `*` border-color rule is unlayered and therefore beats
 * `border-transparent` / `border-(--accent-primary)` outright. The class keys off
 * `aria-current`, which `ariaCurrentWhenActive` sets on the active link.
 */
export const VENDOR_NAV_ITEM_CLASS =
  'aec-nav-tab -mb-px flex shrink-0 items-center gap-1 border-b-2 px-1 py-3 ' +
  'text-sm font-medium text-(--text-secondary) no-underline transition-colors ' +
  'hover:text-(--text-primary) focus-visible:rounded-(--radius-sm) focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * Active-state classes, applied by `routerLinkActive`.
 *
 * Type only — the underline is `.aec-nav-tab[aria-current]`.
 */
export const VENDOR_NAV_ITEM_ACTIVE_CLASS = 'font-bold text-(--accent-primary)';
