/**
 * Client for the admin re-index worklist endpoints (AECI-946), consumed by
 * `ReindexList` at `/admin/reindex`.
 *
 * Mirrors `AdminRequestsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by
 * hand, and the frontend never decides who is an admin. Only ever called from
 * user actions / `afterNextRender`, never during SSR render (the gate + nav
 * already SSR via `adminSummaryResolver` on the parent `/admin` route).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { ListReindexQueueQuery, ListReindexQueueResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminReindexApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/reindex` — the worklist, priority first then oldest first. */
  list(query: Partial<ListReindexQueueQuery> = {}): Promise<ListReindexQueueResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListReindexQueueResponse>('/api/admin/reindex', { params }),
    );
  }

  /** `DELETE /api/admin/reindex/:id` — mark one URL done and drop it. Resolves on
   *  `204`; a `404` means someone else already cleared the row. */
  clear(id: number): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`/api/admin/reindex/${encodeURIComponent(String(id))}`),
    );
  }
}
