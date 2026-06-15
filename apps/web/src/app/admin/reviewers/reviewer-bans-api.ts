/**
 * Client for the reviewer ban-management endpoints (AECI-218 / Phase 6.11),
 * consumed by the review-queue's "consider a ban" prompt and the
 * `/admin/reviewers` bans page.
 *
 * Like `AdminReviewsApi`, these are browser-side reads/mutations over the SSR
 * Worker's `/api/*` passthrough (service binding). Same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by hand,
 * and the frontend never decides who is an admin. Only ever called from user
 * actions / `afterNextRender`, never during SSR render.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BanReviewerInput,
  BanReviewerResponse,
  ListBannedReviewersQuery,
  ListBannedReviewersResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class ReviewerBansApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/reviewers` — the paginated currently-banned list. */
  listBanned(query: Partial<ListBannedReviewersQuery> = {}): Promise<ListBannedReviewersResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListBannedReviewersResponse>('/api/admin/reviewers', { params }),
    );
  }

  /** `PATCH /api/admin/reviewers/:id` — ban (from the prompt) or unban (from the
   *  bans page) a reviewer. */
  ban(id: string, input: BanReviewerInput): Promise<BanReviewerResponse> {
    return firstValueFrom(
      this.http.patch<BanReviewerResponse>(`/api/admin/reviewers/${encodeURIComponent(id)}`, input),
    );
  }
}
