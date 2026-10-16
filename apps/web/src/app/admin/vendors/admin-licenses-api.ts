/**
 * The ONE client for `POST /api/admin/vendors/:id/licenses` (AECI-1370, E4.1) and
 * `PATCH /api/admin/licenses/:id` (AECI-1371, E4.2).
 *
 * Split out of `AdminVendorsApi` like `SeatProvisionApi`: the admin write that grants
 * Managed licenses gets exactly one caller, so its blast radius is greppable. The
 * idempotency (`grant_id`), the validation and the email all live server-side.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  GrantLicensesInput,
  GrantLicensesResponse,
  UpdateLicenseBody,
  UpdateLicenseResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminLicensesApi {
  private readonly http = inject(HttpClient);

  grantLicenses(vendorId: string, input: GrantLicensesInput): Promise<GrantLicensesResponse> {
    return firstValueFrom(
      this.http.post<GrantLicensesResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/licenses`,
        input,
      ),
    );
  }

  /** `PATCH /api/admin/licenses/:id` (AECI-1371, E4.2): extend, re-reference or revoke. */
  updateLicense(licenseId: string, input: UpdateLicenseBody): Promise<UpdateLicenseResponse> {
    return firstValueFrom(
      this.http.patch<UpdateLicenseResponse>(
        `/api/admin/licenses/${encodeURIComponent(licenseId)}`,
        input,
      ),
    );
  }
}
