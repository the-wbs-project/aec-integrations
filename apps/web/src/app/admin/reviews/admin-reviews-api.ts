/**
 * Client for the admin moderation endpoints (AECI-204 / Phase 5.13), consumed by
 * the queue UI (AECI-205 / Phase 5.14).
 *
 * Like `AccountApi` / `ReviewsApi`, these are browser-side reads/mutations over
 * the SSR Worker's `/api/*` passthrough (service binding). The same-origin
 * requests carry the HttpOnly Supabase session cookie automatically, so the API
 * Worker's `requireAdmin()` authenticates + authorizes them — no token is
 * threaded by hand, and the frontend never decides who is an admin. Only ever
 * called from user actions / `afterNextRender`, never during SSR render (the
 * gate + badge already SSR via `adminSummaryResolver`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ListPendingReviewsQuery,
  ListPendingReviewsResponse,
  ModerateReviewInput,
  ModerateReviewResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminReviewsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/reviews` — the paginated moderation list. */
  listPending(query: Partial<ListPendingReviewsQuery> = {}): Promise<ListPendingReviewsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListPendingReviewsResponse>('/api/admin/reviews', { params }),
    );
  }

  /** `PATCH /api/admin/reviews/:id` — approve or reject a pending review. */
  moderate(id: string, input: ModerateReviewInput): Promise<ModerateReviewResponse> {
    return firstValueFrom(
      this.http.patch<ModerateReviewResponse>(
        `/api/admin/reviews/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }
}
