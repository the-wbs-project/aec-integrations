/**
 * App-wide "which vendor does this signed-in seat belong to, and is it on
 * Managed?" probe, for public marketing surfaces that adapt to a vendor
 * visitor after hydration (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §5, AECI-1286).
 *
 * Built on the `RoleStatus` pattern (`auth/role-status.ts`):
 *
 *  - **Cache-neutral.** Every signal is `null` during SSR and before the probe
 *    lands, so a cached, URL-keyed page never bakes one vendor's state into the
 *    HTML the next visitor gets. The probe never runs on the server: it is gated
 *    on `isPlatformBrowser` AND on `VendorStatus.isVendor()`, which is itself
 *    `false` throughout SSR and pre-hydration.
 *  - **Cheap gate first.** A signed-out visitor or a seat with no vendor role
 *    never reaches `/api/vendor/*`. Only a `vendor_admin` (per the shared
 *    `GET /api/account` probe) triggers `GET /api/vendor/me`.
 *  - **Once per session.** The latch closes on dispatch, and concurrent reads
 *    share the one request. Unlike `RoleStatus` it does not retry: the spec asks
 *    for one call, and a failure costs only the signed-in variant of the page.
 *  - **Never surfaces an error.** A failed call (403, 404 for a deleted vendor
 *    row, a dropped connection, a malformed body) leaves every signal `null`,
 *    which every consumer renders as the signed-out page.
 *  - **Sign-out and account switch.** When `isVendor()` drops back to `false`
 *    (sign-out, or a stale role hint corrected), or the session's email changes
 *    under a still-vendor role, the signals reset to `null` and the latch reopens
 *    for the next session. A response that lands after such a reset is dropped.
 *
 * It deliberately does NOT reuse or provide `VendorPortalStore`. That store is
 * portal-scoped, owns the live-sync poll and its revision cursor, and must not
 * outlive the `/vendor` route tree. This is one read, held for the tab.
 *
 * UI hint only. Nothing here authorizes anything: every vendor destination is
 * gated server-side (`requireVendor()` on the API, the `/vendor` SSR redirect).
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';

import { SessionStatus } from '../auth/session-status';

import { VendorApi } from './vendor-api';
import { isManaged } from './vendor-plan';
import { VendorStatus } from './vendor-status';

@Injectable({ providedIn: 'root' })
export class VendorPlanStatus {
  private readonly vendorStatus = inject(VendorStatus);
  private readonly session = inject(SessionStatus);
  private readonly vendorApi = inject(VendorApi);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly _vendorSlug = signal<string | null>(null);
  private readonly _managed = signal<boolean | null>(null);

  /** The vendor's public slug (`vendors.slug`), or `null` until resolved. */
  readonly vendorSlug = this._vendorSlug.asReadonly();

  /**
   * Whether the vendor's plan is Managed, per `isManaged` over the vendor-level
   * `entitlement` block. `null` until resolved, so a consumer can tell "not
   * known yet" from "Free".
   */
  readonly managed = this._managed.asReadonly();

  /** The in-flight probe, shared by every caller. Kept after it settles: it is
   *  the once-per-session latch. Cleared only by `forget()`. */
  private probe: Promise<void> | null = null;

  /** Bumped by `forget()`, so a response for a previous session is dropped. */
  private generation = 0;

  /** The session email the current probe belongs to. A change under a
   *  still-vendor role is an account switch. */
  private probedFor: string | null = null;

  constructor() {
    effect(() => {
      const vendor = this.vendorStatus.isVendor();
      const email = this.session.email();
      untracked(() => {
        if (!vendor) {
          // `false` is also the SSR and pre-hydration default. Forgetting then
          // is harmless: there is nothing to forget yet.
          if (this.probe !== null) this.forget();
          return;
        }
        if (this.probe !== null && email !== null && email !== this.probedFor) {
          // `SessionStatus` paints `signedIn` from the cookie before the email
          // arrives, and `RoleStatus` may apply a cached vendor role in that
          // gap. A probe started then is the same session: adopt the email
          // rather than call twice. Only a change between two known emails is
          // an account switch.
          if (this.probedFor === null) this.probedFor = email;
          else this.forget();
        }
        void this.ensureProbed();
      });
    });
  }

  /**
   * Start the probe if this session has not started one. Safe to call from any
   * consumer and as often as it likes: it never issues a second request in one
   * session, and it is a no-op on the server or for a non-vendor.
   */
  ensureProbed(): Promise<void> {
    if (!this.isBrowser || !this.vendorStatus.isVendor()) return Promise.resolve();
    if (this.probe === null) {
      this.probedFor = this.session.email();
      this.probe = this.load(this.generation);
    }
    return this.probe;
  }

  /** One `GET /api/vendor/me`. Never throws. */
  private async load(generation: number): Promise<void> {
    try {
      const me = await this.vendorApi.getMe();
      if (generation !== this.generation) return;
      const slug = me.vendor.slug;
      const managed = isManaged(me.entitlement);
      if (typeof slug !== 'string') return;
      this._vendorSlug.set(slug);
      this._managed.set(managed);
    } catch {
      // Any failure, including a body missing the fields above, reads as signed
      // out. The signals were never set, so there is nothing to undo.
    }
  }

  /** Reset to the neutral default and reopen the latch for the next session. */
  private forget(): void {
    this.generation++;
    this.probe = null;
    this.probedFor = null;
    this._vendorSlug.set(null);
    this._managed.set(null);
  }
}
