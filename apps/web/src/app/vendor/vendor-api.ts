/**
 * Client for the Stage 2 vendor-portal endpoints (AECI-520 / `/api/vendor/*`),
 * consumed by the vendor dashboard (AECI-522).
 *
 * Like `AdminReviewsApi` / `AccountApi`, these are browser-side reads/mutations
 * over the SSR Worker's `/api/*` passthrough (service binding). The same-origin
 * requests carry the HttpOnly Supabase session cookie automatically, so the API
 * Worker's `requireVendor()` authenticates + authorizes them and scopes every
 * row to the session's `vendor_id` — no vendor id is ever threaded by hand, and
 * the frontend never decides which vendor a user administers. Only ever called
 * from user actions / `afterNextRender`, never during SSR render (the gate + the
 * dashboard payload SSR via `vendorMeResolver`).
 *
 * Provided as a class (not just a function bag) so the dev-only preview
 * (`preview/vendor-dashboard/`) can shadow it with a fixture-backed subclass via
 * DI (`{ provide: VendorApi, useClass: PreviewVendorApi }`) and exercise the same
 * components without a real vendor session.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ListVendorSeatsResponse,
  TaxonomyResponse,
  UpdateVendorProductInput,
  UpdateVendorProductResponse,
  UpdateVendorProfileInput,
  UpdateVendorProfileResponse,
  VendorMeResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class VendorApi {
  protected readonly http = inject(HttpClient);

  /** `GET /api/vendor/me` — the dashboard payload (vendor + owned products +
   *  claim/correction status + seat count). */
  getMe(): Promise<VendorMeResponse> {
    return firstValueFrom(this.http.get<VendorMeResponse>('/api/vendor/me'));
  }

  /** `GET /api/vendor/seats` — the read-only seat roster. Loaded lazily after
   *  first paint because it needs the Supabase email lookup. */
  getSeats(): Promise<ListVendorSeatsResponse> {
    return firstValueFrom(this.http.get<ListVendorSeatsResponse>('/api/vendor/seats'));
  }

  /** `PATCH /api/vendor/profile` — edit own vendor content within guard-rails.
   *  Send only changed fields (the endpoint requires ≥1). Echoes post-edit
   *  state. */
  updateProfile(input: UpdateVendorProfileInput): Promise<UpdateVendorProfileResponse> {
    return firstValueFrom(
      this.http.patch<UpdateVendorProfileResponse>('/api/vendor/profile', input),
    );
  }

  /** `PATCH /api/vendor/products/:id` — edit an owned product within guard-rails.
   *  Taxonomy arrays are full-set replacement. Echoes post-edit state. */
  updateProduct(id: string, input: UpdateVendorProductInput): Promise<UpdateVendorProductResponse> {
    return firstValueFrom(
      this.http.patch<UpdateVendorProductResponse>(
        `/api/vendor/products/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `GET /api/taxonomy` — the full category/audience/phase vocabulary (with
   *  live counts) that powers the product editor's "assign existing term"
   *  pickers. A public read; vendors assign existing terms only (an unknown slug
   *  is a 400 server-side). */
  getTaxonomy(): Promise<TaxonomyResponse> {
    return firstValueFrom(this.http.get<TaxonomyResponse>('/api/taxonomy'));
  }
}
