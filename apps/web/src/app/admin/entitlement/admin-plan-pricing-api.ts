/**
 * Client for the admin plan price overrides (ruling 2026-10-08,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.13), consumed by `PlanPricingControl`.
 *
 * Separate from `AdminEntitlementApi` on purpose: the override is display only
 * and is not part of the entitlement. A Free vendor with no entitlement row can
 * carry one, and clearing an entitlement leaves it alone.
 *
 * Same transport as the entitlement client: a same-origin request over the SSR
 * Worker's `/api/*` passthrough, carrying the HttpOnly session cookie, so the API
 * Worker's `requireAdmin()` decides who may write.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { SetVendorPlanPricingInput, VendorPlanPricingResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminPlanPricingApi {
  private readonly http = inject(HttpClient);

  /**
   * `PUT /api/admin/vendors/:id/plan-pricing`. A full replacement: both fields
   * `null` resets the vendor to the default list price.
   */
  setPlanPricing(
    vendorId: string,
    input: SetVendorPlanPricingInput,
  ): Promise<VendorPlanPricingResponse> {
    return firstValueFrom(
      this.http.put<VendorPlanPricingResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/plan-pricing`,
        input,
      ),
    );
  }
}
