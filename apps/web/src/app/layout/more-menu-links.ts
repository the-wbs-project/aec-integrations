/**
 * Copy + link set for the header's "More" overflow menu, in one pure module so
 * the desktop flyout (`nav-more-trigger.ts`) and the mobile overlay disclosure
 * (`nav-menu.ts`) can't drift — the same anti-drift pattern as
 * `taxonomy-nav-copy.ts` for the taxonomy facets.
 *
 * "More" is the home for every destination that isn't a primary directory
 * surface: the two forward-looking pages (Updates, Roadmap), the company pages
 * (About, Contact), and Legal. The admin section is NOT here — it comes from
 * `admin/admin-nav.ts` (`ADMIN_NAV_GROUPS`), the same array the `/admin` sidebar
 * renders, and it is gated on `AdminStatus.isAdmin()` by the consuming surface.
 *
 * i18n ids are deliberately REUSED from the footer / primary nav where the
 * string is identical (`@@app.nav.updates`, `@@app.footer.about`, …) — the same
 * convention `site-footer.ts` follows for `@@app.nav.categories`. A shared id
 * with an identical source is one translation unit, not a collision.
 *
 * The shapes are structurally identical to `AdminNavItem` / `AdminNavGroup` so
 * `nav-more-list.ts` renders both with one template; `heading: null` marks the
 * lead group, which renders as a bare list with no overline.
 */

export interface MoreMenuItem {
  path: string;
  label: string;
  /** Marks the single entry that carries the live pending-review count. */
  badge?: boolean;
}

export interface MoreMenuGroup {
  /** Wires the group label to its `<ul>` via `aria-labelledby`. Always set, so
   *  an unlabelled group can still be addressed for testing. */
  id: string;
  /** `null` renders the list with no visible heading (the lead group). */
  heading: string | null;
  items: readonly MoreMenuItem[];
}

/** The public (always-visible) half of the More menu. */
export function moreSiteGroups(): readonly MoreMenuGroup[] {
  return [
    {
      id: 'nav-more-site',
      heading: null,
      items: [
        { path: '/updates', label: $localize`:@@app.nav.updates:Updates` },
        { path: '/roadmap', label: $localize`:@@app.nav.roadmap:Roadmap` },
        { path: '/about', label: $localize`:@@app.footer.about:About` },
        { path: '/contact', label: $localize`:@@app.footer.contact:Contact` },
      ],
    },
    {
      id: 'nav-more-legal',
      heading: $localize`:@@app.footer.legal.eyebrow:Legal`,
      items: [
        { path: '/legal/terms', label: $localize`:@@app.footer.legal.terms:Terms` },
        { path: '/legal/privacy', label: $localize`:@@app.footer.legal.privacy:Privacy` },
        {
          path: '/legal/review-guidelines',
          label: $localize`:@@app.footer.legal.reviewGuidelines:Review guidelines`,
        },
        {
          path: '/legal/listing-accuracy',
          label: $localize`:@@app.footer.legal.listingAccuracy:Listing accuracy`,
        },
      ],
    },
  ];
}

/** Top-level trigger label ("More") and its accessible name. */
export function moreTriggerLabel(): string {
  return $localize`:@@app.nav.more:More`;
}

export function moreTriggerAria(): string {
  return $localize`:@@app.nav.more.aria:More menu`;
}
