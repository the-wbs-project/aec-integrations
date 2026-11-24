/**
 * Client for the search console reads behind `/admin/seo` (AECI-822,
 * `docs/ADMIN_PANEL_SPEC.md` §5.24, `docs/API_CONTRACTS.md` "Search console").
 *
 * Mirrors `AdminReindexApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the session cookie, so the API
 * Worker's `requireAdmin()` decides who may read. Called only from
 * `afterNextRender` and user actions, never during SSR render.
 *
 * Both endpoints are reads. Neither writes an audit row or is rate limited.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { SeoQueueQuery, SeoQueueResponse, SeoTrendResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminSeoApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/seo/queue`: every lane's count, plus one page of one lane's
   *  URLs, oldest first (Panel 1). Unset parameters take the API defaults. */
  queue(query: Partial<SeoQueueQuery> = {}): Promise<SeoQueueResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(this.http.get<SeoQueueResponse>('/api/admin/seo/queue', { params }));
  }

  /** `GET /api/admin/seo/trend?weeks=`: complete ISO weeks, newest first (Panel 2). */
  trend(weeks: number): Promise<SeoTrendResponse> {
    return firstValueFrom(
      this.http.get<SeoTrendResponse>('/api/admin/seo/trend', {
        params: new HttpParams().set('weeks', String(weeks)),
      }),
    );
  }
}
