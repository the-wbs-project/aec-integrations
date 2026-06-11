/**
 * Client for the authenticated review-submission endpoint (AECI-200 / Phase
 * 5.9) — the second browser-side mutation in `apps/web` after the vendor
 * request forms (`requests/requests-api.ts`).
 *
 * The SSR Worker proxies `/api/*` to the private API Worker over the service
 * binding, forwarding cookies untouched (`server-runtime.ts`'s `/api/*`
 * passthrough). So the Supabase session cookie (`sb-…-auth-token*`) rides this
 * same-origin POST automatically and `requireAuth()` on the API reads it — no
 * bearer token is attached client-side. POSTs are excluded from the hydration
 * transfer cache (`withHttpTransferCacheOptions({ includePostRequests: false })`,
 * `app.config.ts`) and only ever run from a user action, never during render.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { SubmitReviewInput, SubmitReviewResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class ReviewsApi {
  private readonly http = inject(HttpClient);

  submitReview(input: SubmitReviewInput): Promise<SubmitReviewResponse> {
    return firstValueFrom(this.http.post<SubmitReviewResponse>('/api/reviews', input));
  }
}
