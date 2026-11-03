/**
 * Client for the admin thread reads (AECI-1539, `ADMIN_PANEL_SPEC.md` §5.19,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.12), consumed by `/admin/threads` and
 * `/admin/threads/:id`.
 *
 * Mirrors `AdminSubscribersApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the HttpOnly Supabase session
 * cookie, so the API Worker's `requireAdmin()` authenticates and authorizes it.
 * Only ever called from `afterNextRender` or a user action, never during SSR render.
 *
 * **Reads only.** AECi writes nothing on a thread in v1 (§15.3).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminThreadDetailResponse,
  AdminThreadsQuery,
  AdminThreadsResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminThreadsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/threads`. The server defaults `help` to `all`. */
  listThreads(query: Partial<AdminThreadsQuery> = {}): Promise<AdminThreadsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(this.http.get<AdminThreadsResponse>('/api/admin/threads', { params }));
  }

  /** `GET /api/admin/threads/:id`. Every message, the text of a deleted one included. */
  getThread(id: string): Promise<AdminThreadDetailResponse> {
    return firstValueFrom(
      this.http.get<AdminThreadDetailResponse>(`/api/admin/threads/${encodeURIComponent(id)}`),
    );
  }
}
