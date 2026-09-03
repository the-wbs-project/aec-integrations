/**
 * Client for the admin entitlement action (AECI-532 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.1), consumed by `EntitlementControl`.
 *
 * Lives here rather than on `AdminClaimsApi` because the endpoint was never a
 * claims endpoint: it takes a VENDOR id and hits `/api/admin/vendors/:id/…`. It
 * sat there only because `/admin/claims` happened to be the one surface that
 * could reach it. Since AECI-652 the control lives on `/admin/vendors/:id`, and
 * a vendors page reaching through a claims service would be the wrong dependency
 * edge — so the method moved with the control.
 *
 * Mirrors `AdminClaimsApi`: a browser-side mutation over the SSR Worker's
 * `/api/*` passthrough. The same-origin request carries the HttpOnly Supabase
 * session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes it — no token is threaded by hand, and the
 * frontend never decides who is an admin.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { SetVendorEntitlementInput, VendorEntitlementResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminEntitlementApi {
  private readonly http = inject(HttpClient);

  /**
   * `PATCH /api/admin/vendors/:id/entitlement` — set / renew / clear the vendor's
   * paid entitlement.
   *
   * **The only writer that can take `vendors.verified` back down**, and it does so
   * through the entitlement row: `verified` is never sent, it is a mirror written
   * server-side in the same `db.batch` (§2.1), and it comes back on the response
   * as a read-only readout.
   */
  setEntitlement(
    vendorId: string,
    input: SetVendorEntitlementInput,
  ): Promise<VendorEntitlementResponse> {
    return firstValueFrom(
      this.http.patch<VendorEntitlementResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/entitlement`,
        input,
      ),
    );
  }
}
