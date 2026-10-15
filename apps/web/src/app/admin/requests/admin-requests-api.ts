/**
 * Client for the admin vendor-request endpoints (AECI-216 / Phase 6.9), consumed
 * by the requests dashboard UI (AECI-217 / Phase 6.10).
 *
 * Mirrors `AdminReviewsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates + authorizes them — no token is threaded by hand,
 * and the frontend never decides who is an admin. Only ever called from user
 * actions / `afterNextRender`, never during SSR render (the gate + badge already
 * SSR via `adminSummaryResolver`).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminLicenseReleaseRequest,
  AdminListingRequest,
  AdminProductRequest,
  DecideLicenseReleaseRequest,
  DecideProductRequest,
  ListLicenseReleaseRequestsQuery,
  ListLicenseReleaseRequestsResponse,
  ListProductRequestsQuery,
  ListProductRequestsResponse,
  ProductsListResponse,
  ListListingRequestsQuery,
  ListListingRequestsResponse,
  ListVendorRequestsQuery,
  ListVendorRequestsResponse,
  ModerateRequestInput,
  ModerateRequestResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminRequestsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/requests` — the paginated claim/correction queue. */
  listRequests(query: Partial<ListVendorRequestsQuery> = {}): Promise<ListVendorRequestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListVendorRequestsResponse>('/api/admin/requests', { params }),
    );
  }

  /** `PATCH /api/admin/requests/:id` — resolve or reject an open request. */
  moderate(id: string, input: ModerateRequestInput): Promise<ModerateRequestResponse> {
    return firstValueFrom(
      this.http.patch<ModerateRequestResponse>(
        `/api/admin/requests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `GET /api/admin/listing-requests` (AECI-1293): typed-in listings from the claim dialog. */
  listListingRequests(
    query: Partial<ListListingRequestsQuery> = {},
  ): Promise<ListListingRequestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListListingRequestsResponse>('/api/admin/listing-requests', { params }),
    );
  }

  /** `PATCH /api/admin/listing-requests/:id` — resolve or reject an open listing request. */
  moderateListingRequest(id: string, input: ModerateRequestInput): Promise<AdminListingRequest> {
    return firstValueFrom(
      this.http.patch<AdminListingRequest>(
        `/api/admin/listing-requests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `GET /api/admin/product-requests` (AECI-1377): vendors asking us to add a product. */
  listProductRequests(
    query: Partial<ListProductRequestsQuery> = {},
  ): Promise<ListProductRequestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListProductRequestsResponse>('/api/admin/product-requests', { params }),
    );
  }

  /** `PATCH /api/admin/product-requests/:id` — decide an open product request. */
  decideProductRequest(id: string, input: DecideProductRequest): Promise<AdminProductRequest> {
    return firstValueFrom(
      this.http.patch<AdminProductRequest>(
        `/api/admin/product-requests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `GET /api/admin/license-release-requests` (AECI-1373): owners asking to free a
   *  license before renewal. */
  listLicenseReleaseRequests(
    query: Partial<ListLicenseReleaseRequestsQuery> = {},
  ): Promise<ListLicenseReleaseRequestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListLicenseReleaseRequestsResponse>('/api/admin/license-release-requests', {
        params,
      }),
    );
  }

  /** `PATCH /api/admin/license-release-requests/:id` — approve or decline an open one. */
  decideLicenseReleaseRequest(
    id: string,
    input: DecideLicenseReleaseRequest,
  ): Promise<AdminLicenseReleaseRequest> {
    return firstValueFrom(
      this.http.patch<AdminLicenseReleaseRequest>(
        `/api/admin/license-release-requests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** The product picker's search for an Added or Already listed decision: the PUBLIC
   *  `GET /api/products`, which lists promoted products only, A to Z. */
  searchProducts(query: string, perPage = 8): Promise<ProductsListResponse> {
    const params = new HttpParams()
      .set('search', query)
      .set('perPage', String(perPage))
      .set('sort', 'name');
    return firstValueFrom(this.http.get<ProductsListResponse>('/api/products', { params }));
  }
}
