/**
 * The ONE client for `PATCH /api/admin/connector-catalogs/:id` (AECI-720).
 *
 * Split out of `AdminConnectorsApi` for the same reason `AdminEntitlementApi` is
 * split out of `AdminVendorsApi`: the endpoint that can freeze a promote lane
 * gets exactly one caller, so the blast radius is greppable.
 *
 * This client re-implements none of the action. AECI-720 owns the audit row, the
 * 422 same-state gate and the 404 on an unknown `vendorId`; the control renders
 * their outcomes.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ConnectorCatalogManagementResponse,
  SetConnectorCatalogManagementInput,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class ManagedByApi {
  private readonly http = inject(HttpClient);

  setManagement(
    id: string,
    input: SetConnectorCatalogManagementInput,
  ): Promise<ConnectorCatalogManagementResponse> {
    return firstValueFrom(
      this.http.patch<ConnectorCatalogManagementResponse>(
        `/api/admin/connector-catalogs/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }
}
