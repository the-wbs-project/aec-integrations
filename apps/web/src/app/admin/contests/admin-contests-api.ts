/**
 * Client for the admin integration-field-contest endpoints (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b; `API_CONTRACTS.md` §6.10), consumed by the
 * `/admin/contests` queue.
 *
 * Mirrors `AdminClaimsApi`: browser-side calls over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the HttpOnly Supabase session
 * cookie, so the API Worker's `requireAdmin()` authenticates and authorizes it.
 * Only ever called from user actions or `afterNextRender`, never during SSR render.
 *
 * There is no `getContest(id)`: the API has no single-contest read, and the list
 * row already carries every field the decision needs.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminContest,
  DecideContestInput,
  ListAdminContestsQuery,
  ListAdminContestsResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminContestsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/contests`. The server defaults `status` to `open` and
   *  `routed_to` to `aeci`; an omitted key is left to that default. */
  listContests(query: Partial<ListAdminContestsQuery> = {}): Promise<ListAdminContestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListAdminContestsResponse>('/api/admin/contests', { params }),
    );
  }

  /** `PATCH /api/admin/contests/:id`. Accept records the decision and files a
   *  `REVIEW - ` Linear issue after commit; it writes no catalog data. Returns the
   *  row's post-decision state. */
  decide(id: string, input: DecideContestInput): Promise<AdminContest> {
    return firstValueFrom(
      this.http.patch<AdminContest>(`/api/admin/contests/${encodeURIComponent(id)}`, input),
    );
  }
}
