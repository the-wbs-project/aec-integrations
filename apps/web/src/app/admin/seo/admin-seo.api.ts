/**
 * Client for the search console reads behind `/admin/seo` (AECI-822,
 * `docs/ADMIN_PANEL_SPEC.md` §5.24, `docs/API_CONTRACTS.md` "Search console").
 *
 * Mirrors `AdminReindexApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the session cookie, so the API
 * Worker's `requireAdmin()` decides who may read. Called only from
 * `afterNextRender` and user actions, never during SSR render.
 *
 * All three endpoints are reads. None writes an audit row or is rate limited.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  SeoFunnelResponse,
  SeoQueueQuery,
  SeoQueueResponse,
  SeoTrendResponse,
} from '@aeci/shared';

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

  /** `GET /api/admin/seo/funnel`: each engine's funnel over the trailing 28 days
   *  (Panel 3, AECI-823). Takes no parameters. */
  funnel(): Promise<SeoFunnelResponse> {
    return firstValueFrom(this.http.get<SeoFunnelResponse>('/api/admin/seo/funnel'));
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
