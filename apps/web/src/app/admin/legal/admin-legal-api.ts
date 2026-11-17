/**
 * Client for `/admin/legal` (AECI-1688, `ADMIN_PANEL_SPEC.md` §5.22).
 *
 * Browser-side calls over the SSR Worker's `/api/*` passthrough, like every other console
 * client: the same-origin request carries the HttpOnly session cookie and the API Worker's
 * `requireAdmin()` decides. Only ever called from `afterNextRender` or a user action. The
 * publish and the notice re-send are only ever called from a confirmation dialog's handler.
 * The litigation hold writes (AECI-1638) are called from their own forms' submit handlers.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminLegalAcceptancesResponse,
  AdminLegalVersionsResponse,
  CreateLitigationHoldRequest,
  LitigationHoldsResponse,
  LitigationHoldWriteResponse,
  PublishLegalVersionRequest,
  PublishLegalVersionResponse,
  ResendLegalNoticeResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminLegalApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/legal-versions`. */
  list(): Promise<AdminLegalVersionsResponse> {
    return firstValueFrom(this.http.get<AdminLegalVersionsResponse>('/api/admin/legal-versions'));
  }

  /**
   * `POST /api/admin/legal-versions`. Records one version. A material one then queues its
   * change notice on the server (AECI-1620).
   */
  publish(body: PublishLegalVersionRequest): Promise<PublishLegalVersionResponse> {
    return firstValueFrom(
      this.http.post<PublishLegalVersionResponse>('/api/admin/legal-versions', body),
    );
  }

  /** `POST /api/admin/legal-versions/:id/notice`. Queues the change notice again. */
  resendNotice(id: string): Promise<ResendLegalNoticeResponse> {
    return firstValueFrom(
      this.http.post<ResendLegalNoticeResponse>(
        `/api/admin/legal-versions/${encodeURIComponent(id)}/notice`,
        {},
      ),
    );
  }

  /** `GET /api/admin/legal-acceptances` (AECI-1677): who has accepted each final version. */
  acceptances(): Promise<AdminLegalAcceptancesResponse> {
    return firstValueFrom(
      this.http.get<AdminLegalAcceptancesResponse>('/api/admin/legal-acceptances'),
    );
  }

  /** `GET /api/admin/litigation-holds` (AECI-1638): open holds and the latest released. */
  litigationHolds(): Promise<LitigationHoldsResponse> {
    return firstValueFrom(this.http.get<LitigationHoldsResponse>('/api/admin/litigation-holds'));
  }

  /** `POST /api/admin/litigation-holds`. Places one hold. */
  placeHold(body: CreateLitigationHoldRequest): Promise<LitigationHoldWriteResponse> {
    return firstValueFrom(
      this.http.post<LitigationHoldWriteResponse>('/api/admin/litigation-holds', body),
    );
  }

  /** `POST /api/admin/litigation-holds/:id/release`. Releases one hold. */
  releaseHold(id: string, reason: string): Promise<LitigationHoldWriteResponse> {
    return firstValueFrom(
      this.http.post<LitigationHoldWriteResponse>(
        `/api/admin/litigation-holds/${encodeURIComponent(id)}/release`,
        { reason },
      ),
    );
  }
}
