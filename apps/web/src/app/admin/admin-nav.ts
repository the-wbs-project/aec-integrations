/**
 * The `/admin` information architecture as data — the single source of truth for
 * every surface that lists admin screens.
 *
 * Extracted from `admin-shell.ts` when the site header's "More" menu gained a
 * full Admin section, so the two lists could not drift. That menu is gone and
 * the header no longer restates this IA at all — it offers a single "Admin
 * portal" door (`layout/user-menu.ts`) and the console owns its own navigation.
 *
 * Two consumers today, both inside the console: `admin-shell.ts` renders the row,
 * and `admin-breadcrumb.ts` (AECI-777) derives the trail from it. That is not the
 * drift risk the "More" menu was — a second SURFACE restating the IA — but two
 * readings of one array, which is precisely what having the array is for.
 *
 * Groups and order mirror `docs/ADMIN_PANEL_SPEC.md` §5. Only routes that
 * **exist** are listed — nothing links to a 404, and no entry is rendered
 * disabled; a group with no items simply does not render at all.
 * Adding a screen is one entry here plus its route in `app.routes.ts`.
 *
 * ── HOW THE SHELL RENDERS THIS (AECI-694) ───────────────────────────────────
 * The eleven screens were a left sidebar until the vendor and user screens
 * became wide sortable tables and the 14rem rail turned into the thing standing
 * between an operator and the data. They are now a horizontal row of three
 * categories, each a dropdown.
 *
 * A group with exactly ONE screen collapses to a plain link, because a dropdown
 * that reveals a single destination is a click that buys nothing. That rule is
 * STRUCTURAL, not a flag: it keys off `items.length`, so the day Catalog gains a
 * second screen it becomes a dropdown with no edit here. The collapsed link is
 * labelled with the GROUP heading rather than the item's ("Catalog", not
 * "Coverage"), because at the top level of a nav the category is what is
 * self-describing.
 */

/** One nav entry. `badge` marks the single entry that carries the live
 *  pending-review count. */
export interface AdminNavItem {
  path: string;
  label: string;
  badge?: boolean;
}

/** A labelled group of entries. `id` wires the group label to its `<ul>` via
 *  `aria-labelledby`. */
export interface AdminNavGroup {
  id: string;
  heading: string;
  items: readonly AdminNavItem[];
}

/**
 * The §5 IA. **This list is complete**: every route in the spec's information
 * architecture exists and appears here (`/admin/activity` shipped with AECI-577,
 * `/admin/traffic` with AECI-578, `/admin/catalog` with AECI-579, `/admin/system`
 * with AECI-580, `/admin/audience` with AECI-586). `/admin/claims` arrives from
 * Stage 2 (AECI-521) — it was a hand-rolled entry in `admin-shell.ts` on
 * `stage-2` and folded into this array at the AECI-619 reconciliation.
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    id: 'admin-nav-insights',
    heading: $localize`:@@admin.shell.nav.group.insights:Insights`,
    items: [
      { path: '/admin/overview', label: $localize`:@@admin.shell.nav.overview:Overview` },
      { path: '/admin/activity', label: $localize`:@@admin.shell.nav.activity:Activity` },
      { path: '/admin/traffic', label: $localize`:@@admin.shell.nav.traffic:Traffic` },
      { path: '/admin/audience', label: $localize`:@@admin.shell.nav.audience:Audience` },
    ],
  },
  {
    id: 'admin-nav-catalog',
    heading: $localize`:@@admin.shell.nav.group.catalog:Catalog`,
    // AECI-722 gives Catalog its SECOND screen, which flips the group from a
    // collapsed plain link to a dropdown with no code change — exactly the
    // structural rule documented above. Connectors sits under Catalog rather
    // than Operations because what it does is inspect catalogue data; §5.7 put
    // Vendors under Operations on the mirror-image reasoning, that what THAT
    // screen does is account administration.
    items: [
      { path: '/admin/catalog', label: $localize`:@@admin.shell.nav.catalog:Coverage` },
      { path: '/admin/connectors', label: $localize`:@@admin.shell.nav.connectors:Connectors` },
    ],
  },
  {
    id: 'admin-nav-operations',
    heading: $localize`:@@admin.shell.nav.group.operations:Operations`,
    items: [
      {
        path: '/admin/reviews',
        label: $localize`:@@admin.shell.nav.reviews:Review queue`,
        badge: true,
      },
      { path: '/admin/requests', label: $localize`:@@admin.shell.nav.requests:Requests` },
      { path: '/admin/claims', label: $localize`:@@admin.shell.nav.claims:Vendor claims` },
      { path: '/admin/vendors', label: $localize`:@@admin.shell.nav.vendors:Vendors` },
      // AECI-692 takes the slot "Reviewer bans" held. `/admin/users?banned=true`
      // is the same `banned_at IS NOT NULL` set with filters, search and paging,
      // and the detail page is now where ban and reinstate happen — so one entry
      // replaces the other rather than sitting beside it. The recorded ordering
      // rationale survives intact: claims → vendors → people is the escalation
      // order an operator actually walks.
      { path: '/admin/users', label: $localize`:@@admin.shell.nav.users:Users` },
      { path: '/admin/system', label: $localize`:@@admin.shell.nav.system:System status` },
    ],
  },
];

/**
 * Rest-state classes for one item in the horizontal row, shared by the collapsed
 * single-screen links and by the category disclosure buttons. Exported rather
 * than written twice because the row has two kinds of control in it, and a row
 * where one item sits a pixel higher than its neighbours reads as a bug. Same
 * arrangement, and the same reason, as `vendor/vendor-nav.ts`.
 *
 * `-mb-px` + `border-b-2` pulls the item's own bottom border over the row's
 * hairline, which is what turns "a link that is coloured differently" into a
 * tab.
 *
 * The underline COLOUR is not a utility: `.aec-nav-tab` in `styles.css` owns it,
 * because the global `*` border-color rule is unlayered and therefore beats
 * `border-transparent` / `border-(--accent-primary)` outright. The class keys off
 * `aria-current`, so the mechanism is identical for the links and the buttons.
 */
export const ADMIN_NAV_ITEM_CLASS =
  'aec-nav-tab -mb-px flex shrink-0 cursor-pointer items-center gap-1 border-b-2 px-1 py-3 ' +
  'text-sm font-medium text-(--text-secondary) no-underline transition-colors ' +
  'hover:text-(--text-primary) focus-visible:rounded-(--radius-sm) focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/** Active-state classes, applied by `routerLinkActive` on the collapsed links.
 *  Type only — the underline is `.aec-nav-tab[aria-current]`, which every item
 *  gets for free. */
export const ADMIN_NAV_ITEM_ACTIVE_CLASS = 'font-bold text-(--accent-primary)';

/**
 * The disclosure button's classes: the shared item treatment plus the same two
 * active declarations as `aria-[current=true]:` variants.
 *
 * A button has no `routerLink` for `routerLinkActive` to hang off, so it sets
 * `aria-current="true"` itself from the router URL. Keep the two in lockstep:
 * the mechanism differs, the treatment must not. (`vendor-products-menu.ts`
 * carries the identical arrangement one portal over.)
 */
export const ADMIN_NAV_TRIGGER_CLASS = `${ADMIN_NAV_ITEM_CLASS} aria-[current=true]:font-bold aria-[current=true]:text-(--accent-primary)`;

/**
 * ── THE BREADCRUMB READS THIS FILE TOO (AECI-777) ────────────────────────────
 *
 * `AdminBreadcrumb` derives its trail from the router URL against the array
 * above, which is why the array is data rather than markup. The consequence
 * worth stating: the nav and the trail cannot disagree about a screen's label or
 * which category it belongs to, because there is only one place either is
 * written. Adding a screen is still one entry here.
 */

/** Where a path sits in the IA: its category, and its own label. */
export interface AdminNavPosition {
  readonly groupHeading: string;
  readonly label: string;
}

/** Path → position, flattened once at module scope. The IA is a static array,
 *  so rebuilding this per breadcrumb instance would buy nothing. */
const NAV_POSITIONS = new Map<string, AdminNavPosition>(
  ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map(
      (item) => [item.path, { groupHeading: group.heading, label: item.label }] as const,
    ),
  ),
);

/** The IA position of a nav-able admin path, or null if it names no screen.
 *  Null is the honest answer for `/admin/reviewers` (a redirect) and for a typo,
 *  and the breadcrumb degrades to its root crumb rather than inventing a trail. */
export function adminNavPosition(path: string): AdminNavPosition | null {
  return NAV_POSITIONS.get(path) ?? null;
}

/**
 * What a detail screen is called before its entity loads, keyed by the section
 * segment of `/admin/<section>/<id>`.
 *
 * ONE definition, two consumers: the breadcrumb's last crumb and the screen's
 * own `h2`, which both show this word until the fetch resolves and the entity's
 * real name replaces it. They previously carried separate message ids for the
 * same string (`@@admin.vendors.detail.heading` and friends), which is a
 * translation that can drift between two places showing it simultaneously.
 *
 * A section with no entry falls back to its URL segment, which is ugly but never
 * wrong — the map is not a gate on rendering.
 */
export const ADMIN_DETAIL_FALLBACK_LABELS: Readonly<Record<string, string>> = {
  vendors: $localize`:@@admin.breadcrumb.detail.vendors:Vendor`,
  users: $localize`:@@admin.breadcrumb.detail.users:Account`,
  claims: $localize`:@@admin.breadcrumb.detail.claims:Vendor claim`,
  connectors: $localize`:@@admin.breadcrumb.detail.connectors:Connector catalogue`,
};
