/**
 * Client for `GET /api/admin/subscribers` (AECI-859 / `ADMIN_PANEL_SPEC.md` §5.4),
 * consumed by `/admin/subscribers`.
 *
 * Mirrors `AdminUsersApi` and `AdminAudienceApi`: browser-side reads over the SSR
 * Worker's `/api/*` passthrough (service binding). The same-origin requests carry
 * the HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates and authorizes them — no token is threaded by
 * hand and the frontend never decides who is an admin. Only ever called from
 * `afterNextRender` or a user action, never during SSR render: the gate itself
 * SSRs via `adminSummaryResolver` on the parent `/admin` route.
 *
 * **Reads only, and there is nothing here to write.** A subscriber is removed
 * from the list by the subscriber, through the tokenized `POST /api/unsubscribe`
 * (AECI-537). The console deliberately has no opt-out-on-their-behalf control:
 * that would be an operator suppressing a person's consent record with no
 * evidence the person asked.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminSubscribersQuery, AdminSubscribersResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminSubscribersApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/subscribers` — the paginated roster, filter + email search. */
  listSubscribers(
    query: Partial<Record<keyof AdminSubscribersQuery, string | number>> = {},
  ): Promise<AdminSubscribersResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<AdminSubscribersResponse>('/api/admin/subscribers', { params }),
    );
  }
}
