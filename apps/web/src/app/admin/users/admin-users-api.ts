/**
 * Client for the admin user endpoints (AECI-692 / `ADMIN_PANEL_SPEC.md` §5.8),
 * consumed by `/admin/users` and `/admin/users/:id`.
 *
 * Mirrors `AdminVendorsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes them — no token is threaded by hand, and the
 * frontend never decides who is an admin. Only ever called from user actions or
 * `afterNextRender`, never during SSR render (the gate and shell already SSR via
 * `adminSummaryResolver`).
 *
 * **Reads only.** Ban and reinstate are `ReviewerBansApi.ban()` — the client for
 * `PATCH /api/admin/reviewers/:id`, which is the sole writer of
 * `profiles.banned_at`. Adding a `ban()` here would give that one endpoint two
 * clients and invite a second, subtly different call site.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminUserDetail, AdminUsersListQuery, AdminUsersListResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminUsersApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/users` — the paginated user list, filters + name/email search. */
  listUsers(
    query: Partial<Record<keyof AdminUsersListQuery, string | number | boolean>> = {},
  ): Promise<AdminUsersListResponse> {
    return firstValueFrom(
      this.http.get<AdminUsersListResponse>('/api/admin/users', { params: toParams(query) }),
    );
  }

  /** `GET /api/admin/users/:id` — profile, auth account, seat, invites, counts. */
  getUser(id: string): Promise<AdminUserDetail> {
    return firstValueFrom(
      this.http.get<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
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
