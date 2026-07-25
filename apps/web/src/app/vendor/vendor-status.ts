import { Injectable, effect, inject, signal } from '@angular/core';

import { AccountApi } from '../account/account-api';
import { SessionStatus } from '../auth/session-status';

/**
 * App-wide "is the signed-in visitor a vendor admin?" hint, driving the header
 * user menu's "Vendor dashboard" link (AECI-522).
 *
 * Like `AdminStatus` / `SessionStatus`, this MUST stay neutral during SSR and
 * pre-hydration so the header's URL-keyed cached HTML is visitor-state-neutral:
 * `isVendor()` defaults to `false` and the vendor link only appears client-side
 * after the probe resolves. The probe is gated on `SessionStatus.signedIn()` —
 * itself the cache-neutral, browser-only auth flag — so it can never fire during
 * SSR and anonymous visitors never hit any account endpoint.
 *
 * Vendor detection rides the cheap "me" endpoint, not the vendor-gated one: a
 * single `GET /api/account` (open to any signed-in user) returns `role`, and
 * `role === 'vendor_admin'` is the whole signal — so a non-vendor never reaches
 * (and never 403s on) `/api/vendor/*`. The real gate is always server-side (the
 * `/vendor` SSR redirect + resolver, `requireVendor()` on `/api/vendor/*`).
 *
 * `providedIn: 'root'` so the desktop header (`user-menu.ts`) and the mobile
 * overlay (`nav-menu.ts`) share one reconciled value.
 */
@Injectable({ providedIn: 'root' })
export class VendorStatus {
  private readonly session = inject(SessionStatus);
  private readonly accountApi = inject(AccountApi);

  private readonly _isVendor = signal(false);

  /**
   * Whether the signed-in visitor is a vendor admin. `false` during SSR / before
   * the post-hydration probe resolves — a UI hint only; every real gate is
   * server-side.
   */
  readonly isVendor = this._isVendor.asReadonly();

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
      if (me.role === 'vendor_admin') this._isVendor.set(true);
    } catch {
      // Any probe failure → stay non-vendor; the menu still works, the link
      // simply doesn't show.
    }
  }
}
