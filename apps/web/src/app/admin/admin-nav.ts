/**
 * The `/admin` information architecture as data — the single source of truth for
 * every surface that lists admin screens.
 *
 * Extracted from `admin-shell.ts` when the site header's "More" menu gained a
 * full Admin section, so the two lists could not drift. That menu is gone and
 * the header no longer restates this IA at all — it offers a single "Admin
 * portal" door (`layout/user-menu.ts`) and the console owns its own navigation.
 * So the array is back to ONE consumer, `admin-shell.ts`, which is the point:
 * eleven screens across three groups is a sidebar, not a dropdown column.
 *
 * Groups and order mirror `docs/ADMIN_PANEL_SPEC.md` §5. Only routes that
 * **exist** are listed — nothing links to a 404, and no entry is rendered
 * disabled; a group with no items simply does not render its heading either.
 * Adding a screen is one entry here plus its route in `app.routes.ts`.
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
