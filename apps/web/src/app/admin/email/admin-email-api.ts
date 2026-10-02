/**
 * Client for the `/admin/email` reads (AECI-1223 / `ADMIN_PANEL_SPEC.md` §5.14).
 *
 * Browser-side reads over the SSR Worker's `/api/*` passthrough, like every other console
 * client: the same-origin request carries the HttpOnly session cookie and the API Worker's
 * `requireAdmin()` decides. Only ever called from `afterNextRender` or a user action.
 *
 * **The address search is a POST body, on purpose.** Both Workers log request URLs, so an
 * address must never be put in a query string. `listSends` takes no address at all, and the
 * API refuses one if it arrives there (`ADDRESS_NOT_ALLOWED_IN_URL`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminEmailSearchResponse,
  AdminEmailSendsResponse,
  AdminEmailSummaryResponse,
} from '@aeci/shared';

/** The list filters, as the screen holds them. Absent means "any". */
export interface AdminEmailFilters {
  page: number;
  perPage: number;
  template?: string;
  outcome?: string;
  delivery?: string;
  from?: string;
  to?: string;
}

@Injectable({ providedIn: 'root' })
export class AdminEmailApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/email/summary`. */
  summary(): Promise<AdminEmailSummaryResponse> {
    return firstValueFrom(this.http.get<AdminEmailSummaryResponse>('/api/admin/email/summary'));
  }

  /** `GET /api/admin/email/sends`. No address: see the file header. */
  listSends(filters: AdminEmailFilters): Promise<AdminEmailSendsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<AdminEmailSendsResponse>('/api/admin/email/sends', { params }),
    );
  }

  /** `POST /api/admin/email/sends/search`. The address rides the JSON body only. */
  searchSends(address: string, filters: AdminEmailFilters): Promise<AdminEmailSearchResponse> {
    const body: Record<string, string | number> = { address };
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') body[key] = value;
    }
    return firstValueFrom(
      this.http.post<AdminEmailSearchResponse>('/api/admin/email/sends/search', body),
    );
  }
}
