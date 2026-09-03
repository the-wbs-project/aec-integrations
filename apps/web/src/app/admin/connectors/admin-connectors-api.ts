/**
 * Client for the connector admin endpoints (AECI-722 /
 * `docs/ADMIN_PANEL_SPEC.md` §5.9), consumed by `/admin/connectors` and
 * `/admin/connectors/:id`.
 *
 * Mirrors `AdminVendorsApi`: browser-side reads over the SSR Worker's `/api/*`
 * passthrough (service binding). The same-origin requests carry the HttpOnly
 * Supabase session cookie automatically, so the API Worker's `requireAdmin()`
 * authenticates and authorizes them — no token is threaded by hand, and the
 * frontend never decides who is an admin. Only ever called from user actions /
 * `afterNextRender`, never during SSR render (the gate and shell already SSR via
 * `adminSummaryResolver`).
 *
 * **The `managed_by` WRITE is not here** — it is `ManagedByApi`, injected by
 * `ManagedByControl`, so the one endpoint that can freeze a promote lane has
 * exactly one client. Same split, and the same reason, as `AdminEntitlementApi`.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminConnectorAuditResponse,
  AdminConnectorCatalogDetail,
  AdminConnectorCatalogsListResponse,
  AdminConnectorPairsResponse,
  AdminConnectorStubsResponse,
} from '@aeci/shared';

const BASE = '/api/admin/connector-catalogs';

@Injectable({ providedIn: 'root' })
export class AdminConnectorsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/connector-catalogs` — the paginated catalogue list. */
  listCatalogs(
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<AdminConnectorCatalogsListResponse> {
    return firstValueFrom(
      this.http.get<AdminConnectorCatalogsListResponse>(BASE, { params: toParams(query) }),
    );
  }

  /** `GET /api/admin/connector-catalogs/:id` — basics, surfaces, counts, handover. */
  getCatalog(id: string): Promise<AdminConnectorCatalogDetail> {
    return firstValueFrom(
      this.http.get<AdminConnectorCatalogDetail>(`${BASE}/${encodeURIComponent(id)}`),
    );
  }

  /** `GET /api/admin/connector-catalogs/:id/stubs` — the triage queue. */
  listStubs(
    id: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<AdminConnectorStubsResponse> {
    return firstValueFrom(
      this.http.get<AdminConnectorStubsResponse>(`${BASE}/${encodeURIComponent(id)}/stubs`, {
        params: toParams(query),
      }),
    );
  }

  /** `GET /api/admin/connector-catalogs/:id/pairs` — one lane per call (§13.3). */
  listPairs(
    id: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<AdminConnectorPairsResponse> {
    return firstValueFrom(
      this.http.get<AdminConnectorPairsResponse>(`${BASE}/${encodeURIComponent(id)}/pairs`, {
        params: toParams(query),
      }),
    );
  }

  /** `GET /api/admin/connector-catalogs/:id/audit` — the `audit_log` viewer. */
  listAudit(
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<AdminConnectorAuditResponse> {
    return firstValueFrom(
      this.http.get<AdminConnectorAuditResponse>(`${BASE}/${encodeURIComponent(id)}/audit`, {
        params: toParams(query),
      }),
    );
  }
}

function toParams(query: Record<string, string | number | boolean | undefined>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params = params.set(key, String(value));
  }
  return params;
}
