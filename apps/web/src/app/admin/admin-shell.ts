import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { NotFound } from '../not-found/not-found';
import { AdminBreadcrumb } from './admin-breadcrumb';
import { AdminNavDropdown } from './admin-nav-dropdown';
import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ITEM_ACTIVE_CLASS,
  ADMIN_NAV_ITEM_CLASS,
  type AdminNavGroup,
  type AdminNavItem,
} from './admin-nav';
import { AdminSummaryStore } from './admin-summary.store';

/** One category as the row renders it. Derived once, at module scope: the IA is
 *  a static array, so recomputing per instance would buy nothing. */
interface AdminNavEntry {
  readonly group: AdminNavGroup;
  /** Set only when the group has exactly ONE screen, in which case the category
   *  renders as a plain link to it rather than as a dropdown. See `admin-nav.ts`
   *  for why that rule is structural rather than a flag. */
  readonly sole: AdminNavItem | null;
  /** The last category's panel hangs from the end edge, or a 14rem panel opening
   *  two thirds of the way across a phone viewport runs off the screen. */
  readonly align: 'start' | 'end';
}

const NAV_ENTRIES: readonly AdminNavEntry[] = ADMIN_NAV_GROUPS.map((group, index) => ({
  group,
  sole: group.items.length === 1 ? (group.items[0] ?? null) : null,
  align: index === ADMIN_NAV_GROUPS.length - 1 ? 'end' : 'start',
}));

/**
 * AECI-203 / Phase 5.12 — the admin surface gate + shell at `/admin`. Refactored
 * in AECI-205 / Phase 5.14 from a flat page into the **layout** for the admin
 * area: the gate, header, and nav (with the pending-count badge) stay here; the
 * body is a `<router-outlet/>` that renders the child routes.
 *
 * AECI-576 / Phase 8.3 P1.2 turns that moderation surface into the **operator
 * console** shell (`docs/ADMIN_PANEL_SPEC.md` §5): the `h1` reads "Admin", the flat
 * nav becomes labelled groups, and `/admin` now redirects to `/admin/overview`
 * rather than to the review queue. The three Operations routes are untouched —
 * they moved under a heading, nothing more.
 *
 * Data comes from `adminSummaryResolver` via `route.data['summary']`:
 *   - `summary === null` → the caller is NOT an admin (the resolver got a 401/403
 *     from `GET /api/admin/summary` and set `RESPONSE_INIT.status = 404` + the
 *     noindex 404 meta). Render the global `<aec-not-found/>` so the surface is
 *     never revealed (§7.1). URL stays at `/admin`.
 *   - `summary` set → the caller is an admin. Render the shell + nav badge and let
 *     the outlet render the screen. The resolved count seeds `AdminSummaryStore`,
 *     so the badge is live: a moderation action in `ReviewQueue` decrements the
 *     store and the badge ticks down without a round-trip (§22.1).
 *
 * `/admin` is a private surface, so on the admin (success) path we set a
 * `robots: noindex` head + a title — mirroring the login utility page. On the
 * not-found path the resolver already set the noindex 404 head, so we leave it.
 *
 * The nav is the three §5 groups (Insights / Catalog / Operations) introduced by
 * Phase 8.3 P1.2 (AECI-576), driven by `ADMIN_NAV_GROUPS` (`./admin-nav.ts`).
 * That array moved out of this file when the site header's "More" overflow menu
 * gained the same nine-screen Admin section — both surfaces render one list, so
 * they cannot drift.
 *
 * AECI-777 hangs a `<aec-admin-breadcrumb/>` under that row. It is rendered here,
 * once, rather than by each screen, because it derives its whole trail from the
 * router URL and the same `ADMIN_NAV_GROUPS` array — see `admin-breadcrumb.ts` for
 * why that beats a per-screen `[trail]` input, and for the four parameterised
 * routes whose last crumb arrives via `AdminBreadcrumbStore`.
 *
 * ── THE NAV IS A HORIZONTAL ROW, NOT A SIDEBAR (AECI-694) ────────────────────
 * It was a 14rem left rail until `/admin/vendors` and `/admin/users` became wide
 * sortable tables, at which point the rail was the thing standing between an
 * operator and the data. Three categories under the `h1`, two of which drop
 * down; the content column is now full width.
 *
 * The row deliberately does NOT scroll horizontally, which is a departure from
 * the vendor portal's section row (`vendor-portal-nav.ts`) and from DESIGN.md's
 * default for tab rows. Two reasons, and both are consequences of collapsing
 * eleven items into three: the row is short enough to fit a 320px viewport
 * outright, and `overflow-x-auto` computes `overflow-y` to `auto` as well, which
 * would clip the in-flow dropdown panels. A scrolling row would force every
 * panel into a CDK overlay to escape the clip, which is complexity bought to
 * solve a problem this row does not have.
 */
@Component({
  selector: 'aec-admin-shell',
  imports: [
    NotFound,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    AdminNavDropdown,
    AdminBreadcrumb,
  ],
  template: `
    @let s = summary();
    @if (s === null) {
      <aec-not-found />
    } @else {
      @let count = pendingCount();
      <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
        <header class="mb-8">
          <h1 class="text-2xl font-bold text-(--text-primary)" i18n="@@admin.shell.title">Admin</h1>

          <nav
            i18n-aria-label="@@admin.shell.nav.aria"
            aria-label="Admin sections"
            class="mt-4 border-b border-(--border-default)"
          >
            <ul class="m-0 flex list-none flex-wrap items-stretch gap-x-6 p-0">
              @for (entry of navEntries; track entry.group.id) {
                <li class="shrink-0">
                  @if (entry.sole; as sole) {
                    <a
                      [routerLink]="sole.path"
                      [routerLinkActive]="itemActiveClass"
                      ariaCurrentWhenActive="page"
                      [class]="itemClass"
                    >
                      {{ entry.group.heading }}
                    </a>
                  } @else {
                    <aec-admin-nav-dropdown
                      [group]="entry.group"
                      [pendingCount]="count"
                      [align]="entry.align"
                    />
                  }
                </li>
              }
            </ul>
          </nav>

          <!--
            AECI-777: the trail sits BELOW the row, not above it. Its first crumb
            is "Admin", which is the h1 immediately above, and its second mirrors
            the category the row already marks current; placed above the row it
            would restate both before you had read either. Below, it reads as
            "and inside that section, here", which is the only part the row cannot
            show, because a detail route has no nav entry to make current.
          -->
          <aec-admin-breadcrumb />
        </header>

        <div class="min-w-0">
          <router-outlet />
        </div>
      </section>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminShell {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);
  private readonly summaryStore = inject(AdminSummaryStore);

  /** The §5 IA, arranged for the row — see `./admin-nav.ts`. This shell is its
   *  only consumer: the header offers one "Admin portal" door and never
   *  restates these screens. */
  protected readonly navEntries = NAV_ENTRIES;
  protected readonly itemClass = ADMIN_NAV_ITEM_CLASS;
  protected readonly itemActiveClass = ADMIN_NAV_ITEM_ACTIVE_CLASS;

  /** Resolved data. `adminSummaryResolver` runs server-side and on hydration
   *  reads from `TransferState`; the snapshot value is the SSR-resolved summary
   *  (or null for a non-admin / not-found). */
  protected readonly summary = toSignal<AdminSummaryResponse | null, AdminSummaryResponse | null>(
    this.route.data.pipe(map((d) => (d['summary'] ?? null) as AdminSummaryResponse | null)),
    { initialValue: (this.route.snapshot.data['summary'] ?? null) as AdminSummaryResponse | null },
  );

  /** Live count for the badge — seeded from the resolver, decremented by the
   *  queue. Falls back to 0 (only reached on the admin branch, always seeded). */
  protected readonly pendingCount = computed(() => this.summaryStore.pendingReviews() ?? 0);

  constructor() {
    // The parent `/admin` route data is fixed for this shell instance's lifetime
    // (navigating between children never re-runs the resolver; a fresh visit
    // re-instantiates the shell), so seed the shared store synchronously here —
    // the badge then paints the right count on the first render, and the queue
    // decrements the same store after each action.
    const s = this.summary();
    if (s) {
      this.summaryStore.seed(s.pending_reviews);

      // Admin (success) path only: private surface → noindex + a real title. The
      // not-found path's head is owned by the resolver (`setNotFoundMeta`), so
      // leave it untouched when there's no summary.
      this.titleSvc.setTitle($localize`:@@admin.shell.metaTitle:Admin · AEC Integrations`);
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    }
  }
}
