import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { NotFound } from '../not-found/not-found';
import { AdminSummaryStore } from './admin-summary.store';

/**
 * AECI-203 / Phase 5.12 — the admin surface gate + shell at `/admin`. Refactored
 * in AECI-205 / Phase 5.14 from a flat page into the **layout** for the admin
 * area: the gate, header, and nav (with the pending-count badge) stay here; the
 * body is now a `<router-outlet/>` that renders the child routes (`/admin/reviews`
 * is the first, and `/admin` redirects to it).
 *
 * Data comes from `adminSummaryResolver` via `route.data['summary']`:
 *   - `summary === null` → the caller is NOT an admin (the resolver got a 401/403
 *     from `GET /api/admin/summary` and set `RESPONSE_INIT.status = 404` + the
 *     noindex 404 meta). Render the global `<aec-not-found/>` so the surface is
 *     never revealed (§7.1). URL stays at `/admin`.
 *   - `summary` set → the caller is an admin. Render the shell + nav badge and let
 *     the outlet render the queue. The resolved count seeds `AdminSummaryStore`,
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
          <p class="aec-overline text-(--text-secondary)" i18n="@@admin.shell.eyebrow">Admin</p>
          <h1 class="mt-2 text-2xl font-bold text-(--text-primary)" i18n="@@admin.shell.title">
            Moderation
          </h1>
        </header>

        <div class="grid gap-8 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <nav i18n-aria-label="@@admin.shell.nav.aria" aria-label="Admin sections">
            <ul class="space-y-1">
              <li>
                <a
                  routerLink="/admin/reviews"
                  routerLinkActive="bg-(--surface-raised) text-(--text-primary)"
                  ariaCurrentWhenActive="page"
                  class="flex items-center justify-between gap-3 rounded-(--radius-md) px-3 py-2
                    text-sm font-bold text-(--text-secondary) no-underline transition-colors
                    hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@admin.shell.nav.reviews">Review queue</span>
                  <span
                    class="inline-flex min-w-6 items-center justify-center rounded-full
                      bg-(--accent-primary) px-2 py-0.5 text-xs font-bold text-(--surface-base)"
                    aria-hidden="true"
                    >{{ count }}</span
                  >
                  <span class="sr-only" i18n="@@admin.shell.nav.pendingCount"
                    >{{ count }} reviews pending moderation</span
                  >
                </a>
              </li>
              <li>
                <a
                  routerLink="/admin/requests"
                  routerLinkActive="bg-(--surface-raised) text-(--text-primary)"
                  ariaCurrentWhenActive="page"
                  class="flex items-center gap-3 rounded-(--radius-md) px-3 py-2 text-sm
                    font-bold text-(--text-secondary) no-underline transition-colors
                    hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@admin.shell.nav.requests">Requests</span>
                </a>
              </li>
              <li>
                <a
                  routerLink="/admin/reviewers"
                  routerLinkActive="bg-(--surface-raised) text-(--text-primary)"
                  ariaCurrentWhenActive="page"
                  class="flex items-center gap-3 rounded-(--radius-md) px-3 py-2 text-sm
                    font-bold text-(--text-secondary) no-underline transition-colors
                    hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@admin.shell.nav.reviewers">Reviewer bans</span>
                </a>
              </li>
              <!-- AECI-579: the first non-moderation section. AECI-576 regroups
                   this flat list into Insights / Catalog / Operations. -->
              <li>
                <a
                  routerLink="/admin/catalog"
                  routerLinkActive="bg-(--surface-raised) text-(--text-primary)"
                  ariaCurrentWhenActive="page"
                  class="flex items-center gap-3 rounded-(--radius-md) px-3 py-2 text-sm
                    font-bold text-(--text-secondary) no-underline transition-colors
                    hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@admin.shell.nav.catalog">Catalog</span>
                </a>
              </li>
            </ul>
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
      this.titleSvc.setTitle(
        $localize`:@@admin.shell.metaTitle:Moderation · Admin · AEC Integrations`,
      );
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    }
  }
}
