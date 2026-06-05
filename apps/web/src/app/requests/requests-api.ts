/**
 * Client for the vendor-request endpoints (AECI-128) — the app's first
 * browser-side mutation. Everything else in `apps/web` is read-only
 * (`httpResource` / SSR service-binding fetches); claim & correction submission
 * is the first write, so it goes through `HttpClient.post` here.
 *
 * The SSR Worker proxies `/api/*` to the private API Worker over the service
 * binding, so relative paths work both during SSR and after hydration. POSTs are
 * excluded from the hydration transfer cache (`withHttpTransferCacheOptions({
 * includePostRequests: false })`, `app.config.ts`) and only ever run from a user
 * action, never during render.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ClaimForm,
  CorrectionForm,
  RequestSubmitResponse,
  RequestTargetType,
} from '@aeci/shared';

/** Addresses a request's target by `(type, slug)` — the form never holds a UUID. */
export interface RequestTargetRef {
  readonly targetType: RequestTargetType;
  readonly slug: string;
}

@Injectable({ providedIn: 'root' })
export class RequestsApi {
  private readonly http = inject(HttpClient);

  submitCorrection(
    target: RequestTargetRef,
    formValue: CorrectionForm,
  ): Promise<RequestSubmitResponse> {
    return firstValueFrom(
      this.http.post<RequestSubmitResponse>('/api/requests/correction', {
        ...formValue,
        target_type: target.targetType,
        slug: target.slug,
      }),
    );
  }

  submitClaim(target: RequestTargetRef, formValue: ClaimForm): Promise<RequestSubmitResponse> {
    return firstValueFrom(
      this.http.post<RequestSubmitResponse>('/api/requests/claim', {
        ...formValue,
        target_type: target.targetType,
        slug: target.slug,
      }),
    );
  }
}
