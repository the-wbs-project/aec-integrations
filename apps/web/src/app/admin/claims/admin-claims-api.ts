/**
 * Client for the admin vendor-CLAIM endpoints (AECI-521 LIST +
 * AECI-519 PATCH / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5, §3), consumed by the
 * `/admin/claims` reviewer surface.
 *
 * Mirrors `AdminRequestsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by hand,
 * and the frontend never decides who is an admin. Only ever called from user
 * actions / `afterNextRender`, never during SSR render (the gate + shell already
 * SSR via `adminSummaryResolver`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ListVendorClaimsQuery,
  ListVendorClaimsResponse,
  ModerateClaimInput,
  ModerateClaimResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminClaimsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/claims` — the paginated claim-review queue (reviewer signals). */
  listClaims(query: Partial<ListVendorClaimsQuery> = {}): Promise<ListVendorClaimsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(this.http.get<ListVendorClaimsResponse>('/api/admin/claims', { params }));
  }

  /** `PATCH /api/admin/claims/:id` — approve (grant a verified account) / reject a
   *  claim. Approve runs the AECI-519 grant batch; the optional `entitlement`
   *  records the offline PO/invoice arrangement in the grant's audit metadata. */
  moderate(id: string, input: ModerateClaimInput): Promise<ModerateClaimResponse> {
    return firstValueFrom(
      this.http.patch<ModerateClaimResponse>(`/api/admin/claims/${encodeURIComponent(id)}`, input),
    );
  }
}
