import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminBreakdownDimension,
  AdminMetricKey,
  AdminTimeseriesResponse,
  AdminTrafficBreakdownResponse,
  AdminTrafficPopulation,
} from '@aeci/shared';

/**
 * Client for the two read endpoints the Traffic section renders — AECI-578 /
 * Phase 8.3 P1.4. Contracts: `packages/shared/src/api/admin-panel.ts`,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * Mirrors `AdminRequestsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes them — no token is threaded by hand and the
 * frontend never decides who is an admin. Only ever called from
 * `afterNextRender` or a user action, never during SSR render: the gate itself
 * SSRs via `adminSummaryResolver` on the parent `/admin` route.
 */
@Injectable({ providedIn: 'root' })
export class AdminTrafficApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/admin/metrics/timeseries` — one metric, day-bucketed.
   *
   * `from` / `to` are UTC calendar dates and are **both inclusive** (`from=to` is
   * a legal single-day range). Every day in the window comes back zero-filled, so
   * a chart never has to distinguish "no data" from "no key".
   */
  timeseries(query: {
    metric: AdminMetricKey;
    from: string;
    to: string;
    excludeInternal?: boolean;
  }): Promise<AdminTimeseriesResponse> {
    let params = new HttpParams()
      .set('metric', query.metric)
      .set('from', query.from)
      .set('to', query.to)
      .set('interval', 'day');
    if (query.excludeInternal) params = params.set('exclude_internal', '1');
    return firstValueFrom(
      this.http.get<AdminTimeseriesResponse>('/api/admin/metrics/timeseries', { params }),
    );
  }

  /**
   * `GET /api/admin/traffic/breakdown` — grouped counts over a UTC window.
   *
   * `traffic` is omitted for `dimension=bot`: the API forces the bot population
   * for that dimension regardless (grouping human rows by `bot_name` returns a
   * single empty bucket), and sending a contradicting value would only make the
   * request read as if it meant something.
   */
  breakdown(query: {
    dimension: AdminBreakdownDimension;
    from: string;
    to: string;
    traffic?: AdminTrafficPopulation;
    perPage?: number;
    excludeInternal?: boolean;
  }): Promise<AdminTrafficBreakdownResponse> {
    let params = new HttpParams()
      .set('dimension', query.dimension)
      .set('from', query.from)
      .set('to', query.to)
      .set('page', '1')
      .set('perPage', String(query.perPage ?? 8));
    if (query.dimension !== 'bot' && query.traffic) params = params.set('traffic', query.traffic);
    if (query.excludeInternal) params = params.set('exclude_internal', '1');
    return firstValueFrom(
      this.http.get<AdminTrafficBreakdownResponse>('/api/admin/traffic/breakdown', { params }),
    );
  }
}
