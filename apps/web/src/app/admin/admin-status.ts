/**
 * App-wide "is the signed-in visitor an admin?" hint, driving the header account
 * menu's "Admin portal" link (`layout/user-menu.ts` on desktop, the account block
 * inside `layout/nav-menu.ts` below `lg`) and the pending-work badge on that
 * menu's trigger (AECI-259; three queues rather than one since AECI-922).
 *
 * The probe itself lives in `auth/role-status.ts`, not here: `VendorStatus` asks
 * the same endpoint the same question, so one `GET /api/account` answers both and
 * one `ensureProbed()` re-arms both doors. This class is the admin-shaped view of
 * that signal plus the one admin-only side effect — seeding the queue badges.
 *
 * `isAdmin()` is `false` during SSR / pre-hydration (see `RoleStatus`), so no
 * `/admin` path appears in the URL-keyed cached header HTML for any visitor.
 * It is a UI hint only; every real gate is server-side (the `/admin` SSR redirect
 * + resolver, `requireAdmin()` on `/api/admin/*`).
 *
 * `providedIn: 'root'` so the desktop header (`user-menu.ts`) and the mobile
 * overlay (`nav-menu.ts`) share one reconciled value and one probe.
 */
import { Injectable, computed, effect, inject } from '@angular/core';

import { RoleStatus } from '../auth/role-status';

import { AdminSummaryStore } from './admin-summary.store';

@Injectable({ providedIn: 'root' })
export class AdminStatus {
  private readonly roleStatus = inject(RoleStatus);
  private readonly summaryStore = inject(AdminSummaryStore);

  /**
   * Whether the signed-in visitor is an admin. `false` during SSR / before the
   * post-hydration probe (or its cached hint) resolves — a UI hint only.
   */
  readonly isAdmin = computed(() => this.roleStatus.role() === 'admin');

  constructor() {
    // Seed the same store `/admin` re-seeds, so the badges are live the moment the
    // probe lands. All three counts are non-null for admins only and ride the
    // same payload, which is the whole reason the probe uses `/api/account`.
    //
    // `typeof`, not `!== null`, and per key rather than per payload: the SSR and
    // API Workers deploy separately, so during a rolling deploy the older shape
    // carries `pending_reviews` alone and the other two arrive as `undefined`.
    // Seeding those would put NaN in the badge; omitting them leaves the store's
    // existing values alone, which is what `AdminSummaryStore.seed` is built for.
    effect(() => {
      const me = this.roleStatus.profile();
      if (!me) return;
      this.summaryStore.seed({
        ...(typeof me.pending_reviews === 'number' ? { reviews: me.pending_reviews } : {}),
        ...(typeof me.pending_requests === 'number' ? { requests: me.pending_requests } : {}),
        ...(typeof me.pending_claims === 'number' ? { claims: me.pending_claims } : {}),
        ...(typeof me.pending_reindex === 'number' ? { reindex: me.pending_reindex } : {}),
        ...(typeof me.pending_contests === 'number' ? { contests: me.pending_contests } : {}),
      });
    });
  }

  /**
   * Re-arm the shared account probe. Delegates to `RoleStatus` — kept on this
   * class so a menu that already injects it doesn't need a third injection.
   * Safe to call repeatedly and safe for anonymous visitors (it no-ops).
   */
  ensureProbed(): Promise<void> {
    return this.roleStatus.ensureProbed();
  }
}
