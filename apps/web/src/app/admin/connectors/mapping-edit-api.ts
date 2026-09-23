/**
 * The ONE admin client for `PATCH /api/admin/connector-stub-mappings/:id`
 * (AECI-724), split out of `AdminConnectorsApi` the way `ManagedByApi` is: the
 * first catalog-CONTENT write on this console gets exactly one caller, so its
 * blast radius is greppable.
 *
 * It re-implements none of the action. The endpoint owns the `managed_by = 'vendor'`
 * gate, the §9a.4 two-column check, the conflict 409s, the audit row and the purge.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ConnectorStubMappingEditResponse,
  ProductsListResponse,
  UpdateConnectorStubMappingInput,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class MappingEditApi {
  private readonly http = inject(HttpClient);

  updateMapping(
    id: string,
    input: UpdateConnectorStubMappingInput,
  ): Promise<ConnectorStubMappingEditResponse> {
    return firstValueFrom(
      this.http.patch<ConnectorStubMappingEditResponse>(
        `/api/admin/connector-stub-mappings/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** The public product search, the same read the vendor portal's create form uses.
   *  It returns published products only, which is also what the PATCH accepts. */
  searchProducts(query: string, perPage = 8): Promise<ProductsListResponse> {
    const params = new URLSearchParams({ search: query, perPage: String(perPage) });
    return firstValueFrom(this.http.get<ProductsListResponse>(`/api/products?${params}`));
  }
}
