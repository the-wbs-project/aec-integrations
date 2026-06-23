/**
 * Client for the account endpoints (AECI-202 / Phase 5.11). The signed-in
 * user's own account surface: read identity, update the display name, and the
 * GDPR delete.
 *
 * Like `RequestsApi`, these are browser-side mutations/reads over the SSR
 * Worker's `/api/*` proxy (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAuth()` authenticates them — no token is threaded by hand. Only ever
 * called from user actions / `afterNextRender`, never during SSR render.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AccountProfileResponse,
  AccountReview,
  AccountReviewsQuery,
  AccountReviewsResponse,
  DeleteAccountResponse,
  UpdateAccountInput,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly http = inject(HttpClient);

  /** Read the caller's identity (`email` read-only from the session, display name). */
  getProfile(): Promise<AccountProfileResponse> {
    return firstValueFrom(this.http.get<AccountProfileResponse>('/api/account'));
  }

  /** Update the editable display name. */
  updateProfile(input: UpdateAccountInput): Promise<AccountProfileResponse> {
    return firstValueFrom(this.http.patch<AccountProfileResponse>('/api/account', input));
  }

  /** Right-to-erasure: anonymizes the caller's reviews, deletes their profile +
   *  auth user. The caller signs out + redirects on success. */
  deleteAccount(): Promise<DeleteAccountResponse> {
    return firstValueFrom(this.http.delete<DeleteAccountResponse>('/api/account'));
  }

  /** List the caller's own reviews (all statuses), newest-first, page-based
   *  (AECI-225). Scope is server-set to the session — no reviewer id is sent.
   *  An optional `product_id` narrows the list to one product (AECI-260). */
  listReviews(query?: Partial<AccountReviewsQuery>): Promise<AccountReviewsResponse> {
    const params: Record<string, string> = {};
    if (query?.page != null) params['page'] = String(query.page);
    if (query?.perPage != null) params['perPage'] = String(query.perPage);
    if (query?.product_id != null) params['product_id'] = query.product_id;
    return firstValueFrom(
      this.http.get<AccountReviewsResponse>('/api/account/reviews', { params }),
    );
  }

  /** The caller's own review for a single product, or `null` if none exists
   *  (AECI-260). Drives the "you've already reviewed this" prevention UX on the
   *  detail-page CTA + the review-form guard. Server-scoped to the session, so
   *  no reviewer id is sent; `perPage: 1` keeps it cheap. */
  findMyReviewForProduct(productId: string): Promise<AccountReview | null> {
    return this.listReviews({ product_id: productId, perPage: 1 }).then((r) => r.data[0] ?? null);
  }
}
