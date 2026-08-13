import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { NotFound } from '../not-found/not-found';
import { AdminSummaryStore } from './admin-summary.store';

/** One nav entry. `badge` marks the single entry that carries the live
 *  pending-review count. */
interface AdminNavItem {
  path: string;
  label: string;
  badge?: boolean;
}

/** A labelled group of entries. `id` wires the group label to its `<ul>` via
 *  `aria-labelledby`. */
interface AdminNavGroup {
  id: string;
  heading: string;
  items: readonly AdminNavItem[];
}

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
 */
@Component({
  selector: 'aec-admin-shell',
  imports: [NotFound, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @let s = summary();
    @if (s === null) {
      <aec-not-found />
    } @else {
      @let count = pendingCount();
      <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
        <header class="mb-8 border-b border-(--border-default) pb-6">
          <h1 class="text-2xl font-bold text-(--text-primary)" i18n="@@admin.shell.title">Admin</h1>
        </header>

        <div class="grid gap-8 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <nav i18n-aria-label="@@admin.shell.nav.aria" aria-label="Admin sections">
            <div class="space-y-6">
              @for (group of navGroups; track group.id) {
                <div>
                  <!-- A <p>, not a heading: the shell owns the only h1 and each
                       screen owns the only h2, so nav-group headings would break
                       heading order for no navigational gain (the <ul> is named
                       via aria-labelledby instead). -->
                  <p [id]="group.id" class="aec-overline px-3 pb-1 text-(--text-secondary)">
                    {{ group.heading }}
                  </p>
                  <ul class="space-y-1" [attr.aria-labelledby]="group.id">
                    @for (item of group.items; track item.path) {
                      <li>
                        <a
                          [routerLink]="item.path"
                          routerLinkActive="bg-(--surface-raised) text-(--text-primary)"
                          ariaCurrentWhenActive="page"
                          class="flex items-center justify-between gap-3 rounded-(--radius-md) px-3
                            py-2 text-sm font-bold text-(--text-secondary) no-underline
                            transition-colors hover:text-(--text-primary) focus-visible:outline-2
                            focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        >
                          <span>{{ item.label }}</span>
                          @if (item.badge) {
                            <span
                              class="inline-flex min-w-6 items-center justify-center rounded-full
                                bg-(--accent-primary) px-2 py-0.5 text-xs font-bold
                                text-(--surface-base)"
                              aria-hidden="true"
                              >{{ count }}</span
                            >
                            <span class="sr-only" i18n="@@admin.shell.nav.pendingCount"
                              >{{ count }} reviews pending moderation</span
                            >
                          }
                        </a>
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>
          </nav>

          <div class="min-w-0">
            <router-outlet />
          </div>
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

  /**
   * The §5 information architecture, as data — later sub-issues add one entry
   * rather than editing markup.
   *
   * Only routes that **exist** are listed. §5's full IA also names
   * `/admin/activity` (AECI-577), `/admin/traffic` (AECI-578),
   * `/admin/catalog` (AECI-579), `/admin/audience` (AECI-586) and
   * `/admin/system` (AECI-580); each appears here when its screen ships. Nothing
   * links to a 404, and no entry is rendered disabled — a group with no items
   * (Catalog, today) simply does not render its heading either.
   */
  protected readonly navGroups: readonly AdminNavGroup[] = [
    {
      id: 'admin-nav-insights',
      heading: $localize`:@@admin.shell.nav.group.insights:Insights`,
      items: [{ path: '/admin/overview', label: $localize`:@@admin.shell.nav.overview:Overview` }],
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
        { path: '/admin/reviewers', label: $localize`:@@admin.shell.nav.reviewers:Reviewer bans` },
      ],
    },
  ];

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
