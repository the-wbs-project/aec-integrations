import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { NotFound } from '../not-found/not-found';

/**
 * AECI-203 / Phase 5.12 — the admin surface gate + minimal shell at `/admin`.
 *
 * Data comes from `adminSummaryResolver` via `route.data['summary']`:
 *   - `summary === null` → the caller is NOT an admin (the resolver got a 401/403
 *     from `GET /api/admin/summary` and set `RESPONSE_INIT.status = 404` + the
 *     noindex 404 meta). Render the global `<aec-not-found/>` so the surface is
 *     never revealed (§7.1). URL stays at `/admin`.
 *   - `summary` set → the caller is an admin. Render the shell: an admin nav with
 *     the **pending-count badge** (count of `pending` reviews — §22.1) and a
 *     placeholder body. The real review queue lands at `/admin/reviews` in 5.14.
 *
 * `/admin` is a private surface, so on the admin (success) path we set a
 * `robots: noindex` head + a title — mirroring the login utility page. On the
 * not-found path the resolver already set the noindex 404 head, so we leave it.
 */
@Component({
  selector: 'aec-admin-shell',
  imports: [NotFound],
  template: `
    @let s = summary();
    @if (s === null) {
      <aec-not-found />
    } @else {
      <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
        <header class="mb-8 border-b border-(--border-default) pb-6">
          <p
            class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@admin.shell.eyebrow"
          >
            Admin
          </p>
          <h1 class="mt-2 text-2xl font-bold text-(--text-primary)" i18n="@@admin.shell.title">
            Moderation
          </h1>
        </header>

        <div class="grid gap-8 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <nav i18n-aria-label="@@admin.shell.nav.aria" aria-label="Admin sections">
            <ul class="space-y-1">
              <li>
                <span
                  aria-current="page"
                  class="flex items-center justify-between gap-3 rounded-(--radius-md)
                    bg-(--surface-raised) px-3 py-2 text-sm font-bold text-(--text-primary)"
                >
                  <span i18n="@@admin.shell.nav.reviews">Review queue</span>
                  <span
                    class="inline-flex min-w-6 items-center justify-center rounded-full
                      bg-(--accent-primary) px-2 py-0.5 text-xs font-bold text-(--surface-base)"
                    aria-hidden="true"
                    >{{ s.pending_reviews }}</span
                  >
                  <span class="sr-only" i18n="@@admin.shell.nav.pendingCount"
                    >{{ s.pending_reviews }} reviews pending moderation</span
                  >
                </span>
              </li>
            </ul>
          </nav>

          <div class="space-y-3">
            <h2 class="text-lg font-bold text-(--text-primary)" i18n="@@admin.shell.body.heading">
              Review moderation
            </h2>
            <p class="text-sm text-(--text-secondary)" i18n="@@admin.shell.body.pending">
              {{ s.pending_reviews }} reviews are waiting for moderation.
            </p>
            <p class="text-sm text-(--text-secondary)" i18n="@@admin.shell.body.comingSoon">
              The review queue arrives in a later update.
            </p>
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

  /** Resolved data. `adminSummaryResolver` runs server-side and on hydration
   *  reads from `TransferState`; the snapshot value is the SSR-resolved summary
   *  (or null for a non-admin / not-found). */
  protected readonly summary = toSignal<AdminSummaryResponse | null, AdminSummaryResponse | null>(
    this.route.data.pipe(map((d) => (d['summary'] ?? null) as AdminSummaryResponse | null)),
    { initialValue: (this.route.snapshot.data['summary'] ?? null) as AdminSummaryResponse | null },
  );

  constructor() {
    // Admin (success) path only: private surface → noindex + a real title. The
    // not-found path's head is owned by the resolver (`setNotFoundMeta`), so
    // leave it untouched when there's no summary.
    if (this.summary()) {
      this.titleSvc.setTitle(
        $localize`:@@admin.shell.metaTitle:Moderation · Admin · AEC Integrations`,
      );
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    }
  }
}
