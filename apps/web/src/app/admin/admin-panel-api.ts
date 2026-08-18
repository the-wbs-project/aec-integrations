/**
 * Client for the admin **panel** read endpoints (AECI-574 / Phase 8.3 P1.1),
 * consumed by the operator console screens (AECI-576 onward).
 *
 * Mirrors `AdminRequestsApi` / `AdminReviewsApi`: browser-side reads over the SSR
 * Worker's `/api/*` passthrough (service binding). The same-origin requests carry
 * the HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by hand,
 * and the frontend never decides who is an admin. Only ever called from user
 * actions / `afterNextRender`, never during SSR render (the gate + badge already
 * SSR via `adminSummaryResolver`).
 *
 * Every endpoint here is a **pure read**: no `audit_log` obligation, no
 * `Cache-Tag`, no edge caching (`/admin/*` is absent from `ROUTE_CACHE_PATTERNS`).
 * That includes `recompute` — §13 D8 of `docs/ADMIN_PANEL_SPEC.md` draws the line
 * at side effects, not at manual-ness, so "recompute today's digest" is a `GET`
 * with a query flag and deliberately NOT a `POST`.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminMetricKey,
  AdminOverviewResponse,
  AdminTimeseriesResponse,
  VersionResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminPanelApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/admin/overview` — the §5.1 bundle in one round trip.
   *
   * `day` omitted reports the prior COMPLETE UTC day, the same window the 05:00
   * digest gets. `recompute` additionally runs the two network-dependent status
   * items (the ten data-quality checks and the Algolia drift count) which the
   * default response returns as `null` plus a `requires_recompute` note.
   */
  getOverview(opts: { day?: string; recompute?: boolean } = {}): Promise<AdminOverviewResponse> {
    let params = new HttpParams();
    if (opts.day) params = params.set('day', opts.day);
    if (opts.recompute) params = params.set('recompute', '1');
    return firstValueFrom(this.http.get<AdminOverviewResponse>('/api/admin/overview', { params }));
  }

  /**
   * `GET /api/admin/metrics/timeseries` — one metric, day-bucketed, zero-filled.
   * `from` / `to` are UTC calendar dates and are BOTH inclusive.
   */
  getTimeseries(query: {
    metric: AdminMetricKey;
    from: string;
    to: string;
  }): Promise<AdminTimeseriesResponse> {
    const params = new HttpParams()
      .set('metric', query.metric)
      .set('from', query.from)
      .set('to', query.to);
    return firstValueFrom(
      this.http.get<AdminTimeseriesResponse>('/api/admin/metrics/timeseries', { params }),
    );
  }

  /** `GET /_version` — the SSR Worker's OWN build identity, served by
   *  `apps/web/src/server/routes/version.ts` and NOT proxied (unlike
   *  `/api/version`, which reports the API Worker's). Compared against the API
   *  Worker's `status.version` so a stale SSR deploy is visible (AECI-92). */
  getSsrVersion(): Promise<VersionResponse> {
    return firstValueFrom(this.http.get<VersionResponse>('/_version'));
  }
}
