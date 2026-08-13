/**
 * Client for the admin panel's catalog reads (AECI-579 / Phase 8.3 P1.5),
 * consumed by the `/admin/catalog` screen.
 *
 * Mirrors `AdminRequestsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates + authorizes them — no token is threaded by hand, and the
 * frontend never decides who is an admin. Only ever called from
 * `afterNextRender`, never during SSR render (the gate already SSRs via
 * `adminSummaryResolver` on the parent `/admin` route).
 *
 * Two endpoints, deliberately: coverage is a snapshot of current state, while
 * §5.5's "counts over time" is a **time series** and belongs to the endpoint that
 * already owns that shape — including its `catalog_series_is_additions_only`
 * caveat. Calling `/metrics/timeseries` here rather than widening
 * `/catalog/coverage` keeps one implementation of that series.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminCatalogCoverageResponse,
  AdminMetricKey,
  AdminTimeseriesResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminCatalogApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/catalog/coverage` — gap lists, funnel, taxonomy usage, and
   *  claim/attestation coverage. `sample` caps the rows returned per gap list. */
  coverage(sample?: number): Promise<AdminCatalogCoverageResponse> {
    let params = new HttpParams();
    if (sample !== undefined) params = params.set('sample', String(sample));
    return firstValueFrom(
      this.http.get<AdminCatalogCoverageResponse>('/api/admin/catalog/coverage', { params }),
    );
  }

  /** `GET /api/admin/metrics/timeseries` — one `catalog.*` additions series over
   *  an inclusive UTC date range. */
  timeseries(metric: AdminMetricKey, from: string, to: string): Promise<AdminTimeseriesResponse> {
    const params = new HttpParams().set('metric', metric).set('from', from).set('to', to);
    return firstValueFrom(
      this.http.get<AdminTimeseriesResponse>('/api/admin/metrics/timeseries', { params }),
    );
  }
}
