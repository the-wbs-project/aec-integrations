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

import type {
  ListReindexQueueQuery,
  ListReindexQueueResponse,
  ListReindexSubmissionsQuery,
  ListReindexSubmissionsResponse,
  ReindexClearOutcome,
} from '@aeci/shared';

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

  /** `GET /api/admin/reindex/submissions` — the submission history, newest
   *  first, each row with its causes (AECI-1188). Unset filters are omitted. */
  submissions(
    query: Partial<ListReindexSubmissionsQuery> = {},
  ): Promise<ListReindexSubmissionsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListReindexSubmissionsResponse>('/api/admin/reindex/submissions', { params }),
    );
  }

  /** `DELETE /api/admin/reindex/:id?outcome=` — mark one URL done and drop it,
   *  recording whether the operator requested indexing (AECI-1185). Resolves on
   *  `204`; a `404` means someone else already cleared the row. */
  clear(id: number, outcome: ReindexClearOutcome): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`/api/admin/reindex/${encodeURIComponent(String(id))}`, {
        params: new HttpParams().set('outcome', outcome),
      }),
    );
  }
}
