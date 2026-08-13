/**
 * Client for the admin panel's `page_views` reads (AECI-577 / Phase 8.3 P1.3),
 * consumed by the Activity feed.
 *
 * Mirrors `AdminRequestsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes them — no token is threaded by hand, and the
 * frontend never decides who is an admin. Only ever called from user actions or
 * `afterNextRender`, never during SSR render (the gate already SSRs via
 * `adminSummaryResolver`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminBreakdownDimension,
  AdminPageViewsQuery,
  AdminPageViewsResponse,
  AdminTrafficBreakdownResponse,
} from '@aeci/shared';

/** The breakdown endpoint caps `perPage` at 100; one page is more distinct
 *  sources or countries than a filter dropdown should ever hold. */
const FILTER_OPTIONS_PER_PAGE = 100;

@Injectable({ providedIn: 'root' })
export class AdminPageViewsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/page-views` — one page of the §5.2 visit feed. */
  listPageViews(query: Partial<AdminPageViewsQuery>): Promise<AdminPageViewsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params = params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    return firstValueFrom(
      this.http.get<AdminPageViewsResponse>('/api/admin/page-views', { params }),
    );
  }

  /**
   * `GET /api/admin/traffic/breakdown` — reused here to populate the source and
   * country dropdowns.
   *
   * The alternative was to duplicate the referrer vocabulary into `@aeci/shared`
   * and invent a country list. This is better on both counts: the options are
   * exactly the values present in the selected window (so the operator is never
   * offered a filter that returns nothing), the NULL bucket arrives as a real
   * `key: null` group rather than having to be synthesised, and no vocabulary
   * exists in two places waiting to drift.
   *
   * `traffic: 'all'` deliberately ignores the feed's population filter — the list
   * of *available* countries should not shrink because the operator is currently
   * looking at bots.
   */
  listFilterOptions(
    dimension: Extract<AdminBreakdownDimension, 'source' | 'country'>,
    from: string,
    to: string,
  ): Promise<AdminTrafficBreakdownResponse> {
    const params = new HttpParams()
      .set('dimension', dimension)
      .set('from', from)
      .set('to', to)
      .set('traffic', 'all')
      .set('perPage', String(FILTER_OPTIONS_PER_PAGE));
    return firstValueFrom(
      this.http.get<AdminTrafficBreakdownResponse>('/api/admin/traffic/breakdown', { params }),
    );
  }
}
