/**
 * Client for the admin vendor-request endpoints (AECI-216 / Phase 6.9), consumed
 * by the requests dashboard UI (AECI-217 / Phase 6.10).
 *
 * Mirrors `AdminReviewsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by hand,
 * and the frontend never decides who is an admin. Only ever called from user
 * actions / `afterNextRender`, never during SSR render (the gate + badge already
 * SSR via `adminSummaryResolver`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ListVendorRequestsQuery,
  ListVendorRequestsResponse,
  ModerateRequestInput,
  ModerateRequestResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminRequestsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/requests` — the paginated claim/correction queue. */
  listRequests(query: Partial<ListVendorRequestsQuery> = {}): Promise<ListVendorRequestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListVendorRequestsResponse>('/api/admin/requests', { params }),
    );
  }

  /** `PATCH /api/admin/requests/:id` — resolve or reject an open request. */
  moderate(id: string, input: ModerateRequestInput): Promise<ModerateRequestResponse> {
    return firstValueFrom(
      this.http.patch<ModerateRequestResponse>(
        `/api/admin/requests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }
}
