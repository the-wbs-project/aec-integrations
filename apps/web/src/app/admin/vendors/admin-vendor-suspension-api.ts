/**
 * The ONE client for suspend, then terminate (AECI-1623, `ADMIN_PANEL_SPEC.md` §5.7,
 * `routes/admin-vendor-suspension.ts`): every route under
 * `/api/admin/vendors/:id/suspen*`. Split out of `AdminVendorsApi` like `AdminLicensesApi`,
 * so the calls that lock a vendor out and move its money are greppable.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AbuseCostEntryRequest,
  StartSuspensionStage2Request,
  SuspendVendorRequest,
  TerminateVendorRequest,
  VendorSuspensionStateResponse,
  VendorSuspensionWriteResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminVendorSuspensionApi {
  private readonly http = inject(HttpClient);

  getState(vendorId: string): Promise<VendorSuspensionStateResponse> {
    return firstValueFrom(
      this.http.get<VendorSuspensionStateResponse>(`${base(vendorId)}/suspension`),
    );
  }

  suspend(vendorId: string, input: SuspendVendorRequest): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspend`, input);
  }

  resendNotice(vendorId: string): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/resend-notice`, {});
  }

  startStage2(
    vendorId: string,
    input: StartSuspensionStage2Request,
  ): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/stage-2`, input);
  }

  addCostEntry(
    vendorId: string,
    input: AbuseCostEntryRequest,
  ): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/cost-log`, input);
  }

  voidCostEntry(
    vendorId: string,
    entryId: string,
    reason: string,
  ): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/cost-log/${encodeURIComponent(entryId)}/void`, {
      reason,
    });
  }

  lift(vendorId: string, reason: string): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/lift`, { reason });
  }

  terminate(
    vendorId: string,
    input: TerminateVendorRequest,
  ): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/terminate`, input);
  }

  retryRefunds(vendorId: string): Promise<VendorSuspensionWriteResponse> {
    return this.post(`${base(vendorId)}/suspension/refunds/retry`, {});
  }

  private post(url: string, body: unknown): Promise<VendorSuspensionWriteResponse> {
    return firstValueFrom(this.http.post<VendorSuspensionWriteResponse>(url, body));
  }
}

function base(vendorId: string): string {
  return `/api/admin/vendors/${encodeURIComponent(vendorId)}`;
}
