/**
 * Client for `/admin/legal` (AECI-1688, `ADMIN_PANEL_SPEC.md` §5.22).
 *
 * Browser-side calls over the SSR Worker's `/api/*` passthrough, like every other console
 * client: the same-origin request carries the HttpOnly session cookie and the API Worker's
 * `requireAdmin()` decides. Only ever called from `afterNextRender` or a user action. The
 * publish is only ever called from the confirmation dialog's submit handler.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminLegalVersionsResponse,
  PublishLegalVersionRequest,
  PublishLegalVersionResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminLegalApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/legal-versions`. */
  list(): Promise<AdminLegalVersionsResponse> {
    return firstValueFrom(this.http.get<AdminLegalVersionsResponse>('/api/admin/legal-versions'));
  }

  /** `POST /api/admin/legal-versions`. Records one version. Sends nothing. */
  publish(body: PublishLegalVersionRequest): Promise<PublishLegalVersionResponse> {
    return firstValueFrom(
      this.http.post<PublishLegalVersionResponse>('/api/admin/legal-versions', body),
    );
  }
}
