/**
 * Client for `/admin/dmca` (AECI-1665, `ADMIN_PANEL_SPEC.md` §5.23).
 *
 * Browser-side calls over the SSR Worker's `/api/*` passthrough, like every other console
 * client: the same-origin request carries the HttpOnly session cookie and the API Worker's
 * `requireAdmin()` decides. Only ever called from `afterNextRender` or a user action.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  CreateDmcaNoticeRequest,
  CreateDmcaNoticeResponse,
  DmcaNoticesQuery,
  DmcaNoticesResponse,
  UpdateDmcaNoticeRequest,
  UpdateDmcaNoticeResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminDmcaApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/dmca-notices`. */
  list(query: DmcaNoticesQuery = {}): Promise<DmcaNoticesResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params = params.set(key, value);
    }
    return firstValueFrom(
      this.http.get<DmcaNoticesResponse>('/api/admin/dmca-notices', { params }),
    );
  }

  /** `POST /api/admin/dmca-notices`. Logs one notice or counter-notice. */
  create(body: CreateDmcaNoticeRequest): Promise<CreateDmcaNoticeResponse> {
    return firstValueFrom(
      this.http.post<CreateDmcaNoticeResponse>('/api/admin/dmca-notices', body),
    );
  }

  /** `PATCH /api/admin/dmca-notices/:id`. A stale `expected_updated_at` is a 409. */
  update(id: string, body: UpdateDmcaNoticeRequest): Promise<UpdateDmcaNoticeResponse> {
    return firstValueFrom(
      this.http.patch<UpdateDmcaNoticeResponse>(
        `/api/admin/dmca-notices/${encodeURIComponent(id)}`,
        body,
      ),
    );
  }
}
