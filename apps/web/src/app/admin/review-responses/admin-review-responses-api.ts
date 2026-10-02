/**
 * Client for the admin vendor review-reply endpoints (AECI-1177 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c; `API_CONTRACTS.md` §6.10), consumed by the
 * `/admin/review-responses` queue.
 *
 * Mirrors `AdminContestsApi`: browser-side calls over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the HttpOnly Supabase session
 * cookie, so the API Worker's `requireAdmin()` authenticates and authorizes it.
 * Only ever called from user actions or `afterNextRender`, never during SSR render.
 *
 * There is no single-reply read: a list row already carries everything a decision
 * needs (`ADMIN_PANEL_SPEC.md` §5.13).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminReviewResponse,
  DecideReviewResponseInput,
  ListAdminReviewResponsesQuery,
  ListAdminReviewResponsesResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminReviewResponsesApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/review-responses`. The server defaults `status` to
   *  `pending`; an omitted key is left to that default. */
  listReplies(
    query: Partial<ListAdminReviewResponsesQuery> = {},
  ): Promise<ListAdminReviewResponsesResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListAdminReviewResponsesResponse>('/api/admin/review-responses', { params }),
    );
  }

  /** `PATCH /api/admin/review-responses/:id`. Approve, reject or remove. Reject and
   *  remove carry a reason the vendor sees. Every decision carries
   *  `expected_updated_at`, the card's `updated_at`: a vendor edit since the load
   *  answers `409 REVIEW_RESPONSE_CHANGED` (§11c.7). Returns the row's
   *  post-decision state. */
  decide(id: string, input: DecideReviewResponseInput): Promise<AdminReviewResponse> {
    return firstValueFrom(
      this.http.patch<AdminReviewResponse>(
        `/api/admin/review-responses/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }
}
