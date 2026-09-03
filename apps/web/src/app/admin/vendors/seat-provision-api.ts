/**
 * The ONE client for `POST /api/admin/vendors/:id/seats` (AECI-740).
 *
 * Split out of `AdminVendorsApi` for the same reason `AdminEntitlementApi` and
 * `ManagedByApi` are split out of their siblings: the one endpoint that writes
 * `profiles.role = 'vendor_admin'` standalone — with no claim and no invite behind
 * it — gets exactly one caller, so the blast radius is greppable.
 *
 * The action's whole property — a seat with **no** `vendor_entitlements` row, so
 * the Verified badge never lights (`STAGE_2_SPEC.md` §8.9(2)) — is enforced
 * server-side and pinned by `apps/api/src/routes/vendor-admin-role-writers.spec.ts`.
 * Nothing here re-implements it; the control renders its outcome, including the
 * `entitlement_granted: false` the response states out loud.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { ProvisionVendorSeat, ProvisionVendorSeatResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class SeatProvisionApi {
  private readonly http = inject(HttpClient);

  provisionSeat(
    vendorId: string,
    input: ProvisionVendorSeat,
  ): Promise<ProvisionVendorSeatResponse> {
    return firstValueFrom(
      this.http.post<ProvisionVendorSeatResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/seats`,
        input,
      ),
    );
  }
}
