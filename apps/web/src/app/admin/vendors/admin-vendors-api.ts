/**
 * Client for the admin vendor endpoints (AECI-652 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.6), consumed by `/admin/vendors` and
 * `/admin/vendors/:id`.
 *
 * Mirrors `AdminClaimsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates and authorizes them — no token is threaded by
 * hand, and the frontend never decides who is an admin. Only ever called from
 * user actions / `afterNextRender`, never during SSR render (the gate and shell
 * already SSR via `adminSummaryResolver`).
 *
 * The entitlement WRITE is not here — it is `AdminEntitlementApi`, injected by
 * `EntitlementControl`, so the one endpoint that can move `vendors.verified` has
 * exactly one client.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminVendorAuditQuery,
  AdminVendorAuditResponse,
  AdminVendorDetail,
  AdminVendorProductsQuery,
  AdminVendorProductsResponse,
  AdminVendorsListQuery,
  AdminVendorsListResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminVendorsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/vendors` — the paginated vendor list, name/slug search. */
  listVendors(
    query: Partial<Record<keyof AdminVendorsListQuery, string | number | boolean>> = {},
  ): Promise<AdminVendorsListResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorsListResponse>('/api/admin/vendors', {
        params: toParams(query),
      }),
    );
  }

  /** `GET /api/admin/vendors/:id` — basics, entitlement, seats, counts. */
  getVendor(id: string): Promise<AdminVendorDetail> {
    return firstValueFrom(
      this.http.get<AdminVendorDetail>(`/api/admin/vendors/${encodeURIComponent(id)}`),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/products` — the vendor's product roster, the
   * Products tab's only read. Paginated, name-ordered, every ownership row (a
   * co-owned product is owned).
   */
  listProducts(
    id: string,
    query: Partial<Record<keyof AdminVendorProductsQuery, string | number>> = {},
  ): Promise<AdminVendorProductsResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorProductsResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/products`,
        { params: toParams(query) },
      ),
    );
  }

  /** `GET /api/admin/vendors/:id/audit` — the `audit_log` viewer, newest first. */
  listAudit(
    id: string,
    query: Partial<Record<keyof AdminVendorAuditQuery, string | number>> = {},
  ): Promise<AdminVendorAuditResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorAuditResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/audit`,
        { params: toParams(query) },
      ),
    );
  }

  /**
   * `DELETE /api/admin/vendors/:id/seats/:userId` — revoke one seat.
   *
   * A seat revoke is NOT an entitlement change and NOT a ban (§5.2): the badge,
   * the entitlement row and `vendors.verified` are all untouched, and banning a
   * person is `/admin/users/:id`. It only un-grants this one person's access.
   */
  revokeSeat(vendorId: string, userId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/seats/${encodeURIComponent(userId)}`,
      ),
    );
  }
}

function toParams(query: Record<string, string | number | boolean | undefined>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params = params.set(key, String(value));
  }
  return params;
}
