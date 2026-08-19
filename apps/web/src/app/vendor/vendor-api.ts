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
  CreateVendorClaimInput,
  ListDataObjectsResponse,
  ListProductVersionsResponse,
  ListVendorIntegrationsResponse,
  ListVendorNotificationsResponse,
  ListVendorSeatsResponse,
  TaxonomyResponse,
  UpdateVendorProductInput,
  UpdateVendorProductResponse,
  UpdateVendorProfileInput,
  UpdateVendorProfileResponse,
  UpsertVendorAttestationInput,
  VendorClaimResponse,
  VendorMeResponse,
  VendorUpdatesResponse,
} from '@aeci/shared';

/**
 * A complete attestation position, for `PUT /api/vendor/claims/:id/attestation`.
 *
 * **Every field is required, and that is the point.** The wire schema
 * (`UpsertVendorAttestationSchema`) marks `note` and both version stamps
 * `.nullable().optional()`, and the endpoint **replaces** rather than patches —
 * "an omitted `note` or version stamp lands as `null` on the new row". So the
 * natural-looking `upsertAttestation(id, { asserted: false })` does not record a
 * denial; it records a denial **and silently destroys** the note and version
 * stamps the vendor wrote earlier.
 *
 * That is an easy bug to write here specifically, because every neighbouring
 * `/api/vendor/*` write on this dashboard is a PATCH that takes only changed
 * fields (`vendor-profile-form.ts`, `vendor-product-form.ts`). Making the fields
 * required turns the mistake into a compile error instead of a data-loss report.
 * The `satisfies` at the call site keeps it honest against the wire type.
 *
 * Callers should build this through `VendorAttestationControl`'s single
 * `position()` helper rather than by hand.
 */
export interface VendorAttestationPosition {
  readonly asserted: boolean;
  readonly note: string | null;
  readonly introduced_version_id: string | null;
  readonly deprecated_version_id: string | null;
}

@Injectable({ providedIn: 'root' })
export class VendorApi {
  protected readonly http = inject(HttpClient);

  /** `GET /api/vendor/me` — the dashboard payload (vendor + owned products +
   *  claim/correction status + seat count). */
  getMe(): Promise<VendorMeResponse> {
    return firstValueFrom(this.http.get<VendorMeResponse>('/api/vendor/me'));
  }

  /** `GET /api/vendor/updates` — the per-scope freshness cursor (AECI-627): six
   *  revisions plus the server's clock at read, in one D1 round trip and with no
   *  writes. Polled by `VendorLiveSync` (AECI-629), which diffs the revisions
   *  against the last seen and refetches only what moved. Each value is an ISO
   *  string or `null` ("no rows of that kind"), compared as a string. */
  getUpdates(): Promise<VendorUpdatesResponse> {
    return firstValueFrom(this.http.get<VendorUpdatesResponse>('/api/vendor/updates'));
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

  // ─── Attestations (AECI-301 API, AECI-606 tab) ─────────────────────────────

  /** `GET /api/vendor/integrations` — every integration touching a product the
   *  caller owns, with its claims, each claim's computed `agreement`, the
   *  counterparty's position, and which slots are the caller's. Unpaginated
   *  (bounded by the vendor's own catalog) and **not** Verified-gated: an
   *  unverified vendor gets a real surface it cannot yet write to. */
  getIntegrations(): Promise<ListVendorIntegrationsResponse> {
    return firstValueFrom(
      this.http.get<ListVendorIntegrationsResponse>('/api/vendor/integrations'),
    );
  }

  /** `GET /api/vendor/data-objects` — the closed `data_object` vocabulary, in
   *  the order the claim lanes use. `data_object` is find-only server-side, so
   *  the picker offers this list rather than a text input (AECI-606 / §5.2). */
  getDataObjects(): Promise<ListDataObjectsResponse> {
    return firstValueFrom(this.http.get<ListDataObjectsResponse>('/api/vendor/data-objects'));
  }

  /** `GET /api/vendor/products/:id/versions` — an owned product's release
   *  labels, for the optional version stamps on an attestation. Only the
   *  caller's own endpoint product's versions may stamp a slot (§8.2), so this
   *  is never called for the counterpart product. */
  listProductVersions(productId: string): Promise<ListProductVersionsResponse> {
    return firstValueFrom(
      this.http.get<ListProductVersionsResponse>(
        `/api/vendor/products/${encodeURIComponent(productId)}/versions`,
      ),
    );
  }

  /** `POST /api/vendor/claims` — create a claim **and** the caller's affirming
   *  attestation, in one batch. There is no `asserted` field: creating a claim
   *  IS affirming it. Returns 201 with the claim, agreement included.
   *
   *  A duplicate identity is a `400` carrying `details.claim_id` — the existing
   *  id, so the UI can route the vendor to that lane instead of dead-ending. */
  createClaim(input: CreateVendorClaimInput): Promise<VendorClaimResponse> {
    return firstValueFrom(this.http.post<VendorClaimResponse>('/api/vendor/claims', input));
  }

  /** `PUT /api/vendor/claims/:id/attestation` — state a position.
   *
   *  **Replaces, does not patch.** See `VendorAttestationPosition`: the whole
   *  position goes on every call, or the omitted parts are erased. */
  upsertAttestation(
    claimId: string,
    position: VendorAttestationPosition,
  ): Promise<VendorClaimResponse> {
    const body = position satisfies UpsertVendorAttestationInput;
    return firstValueFrom(
      this.http.put<VendorClaimResponse>(
        `/api/vendor/claims/${encodeURIComponent(claimId)}/attestation`,
        body,
      ),
    );
  }

  /** `DELETE /api/vendor/claims/:id/attestation` — withdraw the caller's own
   *  position. Retracts only rows this vendor wrote, never a co-owner's. `204`
   *  with no body, so the caller re-reads rather than reconstructing: the
   *  response carries no recomputed `agreement`, and the counterparty view is a
   *  lossy reduction that cannot be inverted (a third voter would be invisible).
   *  Nothing to retract is a `404`, deliberately not an idempotent `204`. */
  retractAttestation(claimId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`/api/vendor/claims/${encodeURIComponent(claimId)}/attestation`),
    );
  }

  /** `GET /api/vendor/notifications` — the last 90 days of detector nudges the
   *  §7 sweep emailed this vendor, read from the `audit_log` ledger. A
   *  historical record of what was sent, not live state. */
  getNotifications(): Promise<ListVendorNotificationsResponse> {
    return firstValueFrom(
      this.http.get<ListVendorNotificationsResponse>('/api/vendor/notifications'),
    );
  }
}
