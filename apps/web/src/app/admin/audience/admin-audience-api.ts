/**
 * Client for the §5.4 Audience reads (AECI-586 / Phase 8.3 P5.1).
 *
 * Mirrors `AdminTrafficApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes them — no token is threaded by hand and the
 * frontend never decides who is an admin. Only ever called from
 * `afterNextRender` or a user action, never during SSR render: the gate itself
 * SSRs via `adminSummaryResolver` on the parent `/admin` route.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminAudienceResponse, AdminFeedbackResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminAudienceApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/admin/audience` — the §5.4 bundle. `from` / `to` are UTC calendar
   * dates and are BOTH inclusive.
   */
  audience(query: {
    from: string;
    to: string;
    breakdownLimit?: number;
  }): Promise<AdminAudienceResponse> {
    let params = new HttpParams().set('from', query.from).set('to', query.to);
    if (query.breakdownLimit !== undefined) {
      params = params.set('breakdown_limit', String(query.breakdownLimit));
    }
    return firstValueFrom(this.http.get<AdminAudienceResponse>('/api/admin/audience', { params }));
  }

  /** `GET /api/admin/feedback` — the inbox, newest first. */
  feedback(query: { page: number; perPage: number }): Promise<AdminFeedbackResponse> {
    const params = new HttpParams()
      .set('page', String(query.page))
      .set('perPage', String(query.perPage));
    return firstValueFrom(this.http.get<AdminFeedbackResponse>('/api/admin/feedback', { params }));
  }
}
