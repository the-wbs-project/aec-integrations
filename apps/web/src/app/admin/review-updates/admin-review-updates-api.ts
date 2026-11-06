/**
 * Client for the admin reviewer-update endpoints (AECI-1613 / `STAGE_1_SPEC.md`
 * §4.7a; `API_CONTRACTS.md` §6.10), consumed by the `/admin/review-updates` queue.
 *
 * Mirrors `AdminReviewResponsesApi`: browser-side calls over the SSR Worker's
 * `/api/*` passthrough. The same-origin request carries the HttpOnly Supabase
 * session cookie, so the API Worker's `requireAdmin()` authenticates it. Only ever
 * called from user actions or `afterNextRender`, never during SSR render.
 *
 * There is no single-update read: a list row carries the update and the original
 * review it belongs to, which is everything a decision needs.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminReviewUpdate,
  DecideReviewUpdateInput,
  ListAdminReviewUpdatesQuery,
  ListAdminReviewUpdatesResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminReviewUpdatesApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/review-updates`. The server defaults `status` to `pending`;
   *  an omitted key is left to that default. */
  listUpdates(
    query: Partial<ListAdminReviewUpdatesQuery> = {},
  ): Promise<ListAdminReviewUpdatesResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListAdminReviewUpdatesResponse>('/api/admin/review-updates', { params }),
    );
  }

  /** `PATCH /api/admin/review-updates/:id`. Approve, reject or remove. Reject and
   *  remove carry a reason the reviewer sees. A row someone else already moved
   *  answers `409 REVIEW_UPDATE_WRONG_STATE`. Returns the row's new state. */
  decide(id: string, input: DecideReviewUpdateInput): Promise<AdminReviewUpdate> {
    return firstValueFrom(
      this.http.patch<AdminReviewUpdate>(
        `/api/admin/review-updates/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }
}
