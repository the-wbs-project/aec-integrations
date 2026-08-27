/**
 * App-wide "is the signed-in visitor an admin?" hint, driving the header account
 * menu's "Admin portal" link (`layout/user-menu.ts` on desktop, the account block
 * inside `layout/nav-menu.ts` below `lg`) and the pending-review badge on that
 * menu's trigger (AECI-259).
 *
 * The probe itself lives in `auth/role-status.ts`, not here: `VendorStatus` asks
 * the same endpoint the same question, so one `GET /api/account` answers both and
 * one `ensureProbed()` re-arms both doors. This class is the admin-shaped view of
 * that signal plus the one admin-only side effect — seeding the review badge.
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
    // Seed the same store `/admin` re-seeds, so the badge is live the moment the
    // probe lands. `pending_reviews` is non-null for admins only and rides the
    // same payload, which is the whole reason the probe uses `/api/account`.
    //
    // `typeof`, not `!== null`: the SSR and API Workers deploy separately, so
    // during a rolling deploy this can be `undefined` on the older shape — and
    // `seed(undefined)` would put NaN in the badge.
    effect(() => {
      const me = this.roleStatus.profile();
      if (me && typeof me.pending_reviews === 'number') this.summaryStore.seed(me.pending_reviews);
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
