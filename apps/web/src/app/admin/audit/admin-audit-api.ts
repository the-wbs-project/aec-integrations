/**
 * Client for `GET /api/admin/audit`, the global audit-log read (AECI-653,
 * `API_CONTRACTS.md` §6.10), consumed by `/admin/audit`.
 *
 * Mirrors `AdminClaimsApi`: a browser-side read over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the HttpOnly Supabase session
 * cookie, so the API Worker's `requireAdmin()` authenticates and authorizes it.
 * Only ever called from `afterNextRender` or a user action, never during SSR.
 * A read: it records nothing.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminAuditLogResponse, AuditActorType } from '@aeci/shared';

/**
 * The query as it goes on the wire. Not `AdminAuditLogQuery`: that is the
 * server's PARSED shape, where `after` / `before` are decoded cursor objects.
 * Here they are the raw `"<created_at>|<id>"` strings the server handed back.
 */
export interface AdminAuditListParams {
  readonly entity_type?: string;
  readonly entity_id?: string;
  readonly action?: string;
  readonly actor_id?: string;
  readonly actor_type?: AuditActorType;
  readonly from?: string;
  readonly to?: string;
  readonly perPage?: number;
  readonly order?: 'asc' | 'desc';
  /** A `next_cursor` from an earlier response. Never sent with `before`. */
  readonly after?: string;
  /** A `prev_cursor` from an earlier response. Never sent with `after`. */
  readonly before?: string;
  /** `0` skips the count; the response then carries `total: null`. */
  readonly count?: 0 | 1;
}

@Injectable({ providedIn: 'root' })
export class AdminAuditApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/audit`. Undefined and blank values are left off the URL,
   *  which the server reads as "no filter" either way. */
  listAudit(query: AdminAuditListParams = {}): Promise<AdminAuditLogResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      params = params.set(key, String(value));
    }
    return firstValueFrom(this.http.get<AdminAuditLogResponse>('/api/admin/audit', { params }));
  }
}
