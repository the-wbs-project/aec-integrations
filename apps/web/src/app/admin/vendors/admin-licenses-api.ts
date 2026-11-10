/**
 * The ONE client for `POST /api/admin/vendors/:id/licenses` (AECI-1370, E4.1),
 * `POST /api/admin/vendors/:id/licenses/ban-term` (AECI-1589),
 * `PATCH /api/admin/licenses/:id` (AECI-1371, E4.2),
 * `PATCH /api/admin/license-grants/:id` (AECI-1615) and
 * `PUT /api/admin/vendors/:id/billing/email` (AECI-1381) and
 * `PUT /api/admin/vendors/:id/billing/legal-name` (AECI-1625): the admin billing writes.
 *
 * Split out of `AdminVendorsApi` like `SeatProvisionApi`: the admin write that grants
 * Managed licenses gets exactly one caller, so its blast radius is greppable. The
 * idempotency (`grant_id`), the validation and the email all live server-side.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminUpdateBillingEmailRequest,
  AdminUpdateBillingEmailResponse,
  BanTermLicensesInput,
  BanTermLicensesResponse,
  UpdateVendorLegalNameRequest,
  UpdateVendorLegalNameResponse,
  GrantLicensesInput,
  GrantLicensesResponse,
  UpdateLicenseBody,
  UpdateLicenseResponse,
  WithdrawLicenseGrantInput,
  WithdrawLicenseGrantResponse,
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

  /** `POST /api/admin/vendors/:id/licenses/ban-term` (AECI-1589): after an unban, one
   *  complimentary license per product the ban ended, assigned at grant. */
  grantBanTermLicenses(
    vendorId: string,
    input: BanTermLicensesInput,
  ): Promise<BanTermLicensesResponse> {
    return firstValueFrom(
      this.http.post<BanTermLicensesResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/licenses/ban-term`,
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

  /** `PATCH /api/admin/license-grants/:id` (AECI-1615): withdraw a grant still waiting
   *  for an owner's accept. `422` when it is no longer pending. */
  withdrawLicenseGrant(grantId: string, reason: string): Promise<WithdrawLicenseGrantResponse> {
    const body: WithdrawLicenseGrantInput = { action: 'withdraw', reason };
    return firstValueFrom(
      this.http.patch<WithdrawLicenseGrantResponse>(
        `/api/admin/license-grants/${encodeURIComponent(grantId)}`,
        body,
      ),
    );
  }

  /** `PUT /api/admin/vendors/:id/billing/email` (AECI-1381): set or clear the billing
   *  email. `null` clears it. */
  updateBillingEmail(
    vendorId: string,
    billing_email: string | null,
  ): Promise<AdminUpdateBillingEmailResponse> {
    const body: AdminUpdateBillingEmailRequest = { billing_email };
    return firstValueFrom(
      this.http.put<AdminUpdateBillingEmailResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/billing/email`,
        body,
      ),
    );
  }

  /** `PUT /api/admin/vendors/:id/billing/legal-name` (AECI-1625): set or clear the
   *  vendor's legal name. `null` clears it. */
  updateLegalName(
    vendorId: string,
    legal_name: string | null,
  ): Promise<UpdateVendorLegalNameResponse> {
    const body: UpdateVendorLegalNameRequest = { legal_name };
    return firstValueFrom(
      this.http.put<UpdateVendorLegalNameResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/billing/legal-name`,
        body,
      ),
    );
  }
}
