/**
 * Client for the reviewer ban-management endpoints (AECI-218 / Phase 6.11),
 * consumed by the review-queue's "consider a ban" prompt and by
 * `/admin/users/:id`.
 *
 * **The directory name outlived its page (AECI-692).** The `/admin/reviewers`
 * SCREEN is gone — `/admin/users?banned=true` is the same
 * `banned_at IS NOT NULL` set with filters, search and paging, and
 * `/admin/users/:id` is where ban and reinstate now happen. This client stayed
 * put because the ENDPOINT did: `PATCH /api/admin/reviewers/:id` is still the
 * sole writer of `profiles.banned_at`, and moving the client would have renamed
 * a thing whose server-side name has not changed.
 *
 * `listBanned()` consequently has no UI caller today. It is kept deliberately:
 * `GET /api/admin/reviewers` is still registered and documented, and this
 * method plus `reviewer-bans-api.component.spec.ts` are the only thing pinning
 * its URL and params. Deleting them would leave a live endpoint with no
 * client-side contract test.
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
