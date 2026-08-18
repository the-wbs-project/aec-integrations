/**
 * Client for the §5.6 System status screen (AECI-580 / Phase 8.3 P1.6).
 *
 * Mirrors `AdminRequestsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin request carries the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates + authorizes it — no token is threaded by hand. Only ever called
 * from `afterNextRender` / user actions, never during SSR render (the gate + nav
 * already SSR via `adminSummaryResolver`).
 *
 * ─── Two version endpoints, on purpose ───────────────────────────────────────
 *
 * `getSystem()` carries the **API Worker's** build metadata; `getSsrVersion()`
 * hits the SSR Worker's own `/_version`, which is served by `apps/web` itself and
 * is deliberately NOT proxied (`server-runtime.ts` forwards `/api/*` untouched,
 * so `/api/version` can only ever report the API Worker). They exist as a pair
 * precisely so a **stale SSR deploy is detectable** — AECI-92 — and the screen
 * compares them. Reading one and calling it "the version" would defeat the point.
 *
 * `/api/version` itself is not called: the System bundle already carries those
 * exact values, read by the same Worker from the same `COMMIT_SHA` /
 * `DEPLOYED_AT` / `ENV` vars, so a third request would buy nothing.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminSystemResponse, VersionResponse } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminSystemApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/admin/system` — the §5.6 bundle.
   *
   * `recompute` runs the ten data-quality checks and the Algolia drift count
   * live (§13 D8). Still a pure read — it writes nothing and sends nothing — but
   * it costs a logo-URL probe plus three Algolia queries, which is why it is
   * opt-in rather than part of every load.
   */
  getSystem(opts: { recompute?: boolean } = {}): Promise<AdminSystemResponse> {
    const params = opts.recompute ? new HttpParams().set('recompute', '1') : new HttpParams();
    return firstValueFrom(this.http.get<AdminSystemResponse>('/api/admin/system', { params }));
  }

  /** `GET /_version` — the SSR Worker's OWN build metadata (public, unproxied). */
  getSsrVersion(): Promise<VersionResponse> {
    return firstValueFrom(this.http.get<VersionResponse>('/_version'));
  }
}
