/**
 * The `/admin` information architecture as data — the single source of truth for
 * every surface that lists admin screens.
 *
 * Extracted from `admin-shell.ts` when the site header's "More" menu gained a
 * full Admin section, so the two lists could not drift. That menu is gone and
 * the header no longer restates this IA at all — it offers a single "Admin
 * portal" door (`layout/user-menu.ts`) and the console owns its own navigation.
 * So the array is back to ONE consumer, `admin-shell.ts`.
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
    items: [{ path: '/admin/catalog', label: $localize`:@@admin.shell.nav.catalog:Coverage` }],
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
