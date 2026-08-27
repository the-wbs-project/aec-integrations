/**
 * App-wide "is the signed-in visitor a vendor admin?" hint, driving the header
 * account menu's "Vendor portal" link (AECI-522).
 *
 * The probe itself lives in `auth/role-status.ts`, not here — see `AdminStatus`
 * for why. Before that extraction this class ran its own `GET /api/account` and,
 * unlike the admin one, latched `probed = true` BEFORE awaiting while swallowing
 * every error: a single 401 / JWKS blip hid "Vendor portal" for the entire life
 * of the page, with no retry and no re-arm. Deriving from `RoleStatus` inherits
 * the AECI-617 self-healing probe, the `ensureProbed()` menu-open retry, and the
 * `sessionStorage` hint, and drops one redundant round trip per page load.
 *
 * `isVendor()` is `false` during SSR / pre-hydration (see `RoleStatus`), so the
 * vendor link never reaches the header's URL-keyed cached HTML. It is a UI hint
 * only: the real gate is always server-side (the `/vendor` SSR redirect +
 * resolver, `requireVendor()` on `/api/vendor/*`).
 *
 * `providedIn: 'root'` so the desktop header (`user-menu.ts`) and the mobile
 * overlay (`nav-menu.ts`) share one reconciled value.
 */
import { Injectable, computed, inject } from '@angular/core';

import { RoleStatus } from '../auth/role-status';

@Injectable({ providedIn: 'root' })
export class VendorStatus {
  private readonly roleStatus = inject(RoleStatus);

  /**
   * Whether the signed-in visitor is a vendor admin. `false` during SSR / before
   * the post-hydration probe resolves — a UI hint only.
   */
  readonly isVendor = computed(() => this.roleStatus.role() === 'vendor_admin');

  /**
   * Re-arm the shared account probe. Delegates to `RoleStatus`; see
   * `AdminStatus.ensureProbed()`.
   */
  ensureProbed(): Promise<void> {
    return this.roleStatus.ensureProbed();
  }
}
