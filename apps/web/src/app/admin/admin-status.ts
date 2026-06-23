import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { SessionStatus } from '../auth/session-status';

import { AdminSummaryStore } from './admin-summary.store';

/**
 * App-wide "is the signed-in visitor an admin?" hint, driving the header's user
 * menu (its admin section) and the user-icon pending-review badge (AECI-259).
 *
 * Like `SessionStatus` (Phase 5 §4.4 / §8) this MUST stay neutral during SSR and
 * pre-hydration so the header's URL-keyed cached HTML is visitor-state-neutral:
 * `isAdmin()` defaults to `false` and admin affordances only appear client-side
 * after the probe resolves. The probe is gated on `SessionStatus.signedIn()` —
 * itself the cache-neutral, browser-only auth flag — so it can never fire during
 * SSR (signedIn is always false there) and anonymous visitors never hit any
 * account/admin endpoint.
 *
 * Admin detection rides the cheap "me" endpoint, not the admin-only one: a single
 * `GET /api/account` (open to any signed-in user) now returns `role`. Only when
 * `role === 'admin'` do we then call the admin-gated `GET /api/admin/summary` for
 * the pending-review count — so a non-admin never reaches (and never 403s on) the
 * admin endpoint. That count seeds the same root `AdminSummaryStore` that
 * `AdminShell`/`ReviewQueue` use, so the badge ticks down live as reviews are
 * moderated, and a fresh visit to `/admin` re-seeds it authoritatively.
 *
 * `providedIn: 'root'` so the desktop header (`user-menu.ts`) and the mobile
 * overlay (`nav-menu.ts`) share one reconciled value.
 */
@Injectable({ providedIn: 'root' })
export class AdminStatus {
  private readonly session = inject(SessionStatus);
  private readonly accountApi = inject(AccountApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly http = inject(HttpClient);

  private readonly _isAdmin = signal(false);

  /**
   * Whether the signed-in visitor is an admin. `false` during SSR / before the
   * post-hydration probe resolves — a UI hint only; every real gate is
   * server-side (the `/admin` SSR redirect + resolver, `requireAdmin()` on
   * `/api/admin/*`).
   */
  readonly isAdmin = this._isAdmin.asReadonly();

  /** Probe at most once per client session. */
  private probed = false;

  constructor() {
    // Browser-only by construction: the sole trigger is `signedIn()` flipping to
    // true, which never happens during SSR (SessionStatus stays false there), so
    // this effect fires no network and bakes no visitor state into cached HTML.
    effect(() => {
      if (this.session.signedIn() && !this.probed) {
        this.probed = true;
        void this.reconcile();
      }
    });
  }

  private async reconcile(): Promise<void> {
    try {
      const me = await this.accountApi.getProfile();
      if (me.role !== 'admin') return; // not an admin → keep the neutral default
      this._isAdmin.set(true);
      // Admins only: fetch the pending-review count for the badge.
      const summary = await firstValueFrom(
        this.http.get<AdminSummaryResponse>('/api/admin/summary'),
      );
      this.summaryStore.seed(summary.pending_reviews);
    } catch {
      // Any probe failure → stay non-admin (or admin-without-count); the menu
      // still works and the badge simply doesn't show.
    }
  }
}
