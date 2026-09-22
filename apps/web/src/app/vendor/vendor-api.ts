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
  RetireIntegrationResponse,
  ClaimIntegrationResponse,
  CreateVendorIntegrationInput,
  CreateVendorIntegrationResponse,
  ProductsListResponse,
  CreateVendorClaimInput,
  UpdateVendorIntegrationInput,
  UpdateVendorIntegrationResponse,
  DecideContestInput,
  IntegrationLinkKind,
  IntegrationLinkResponse,
  ListVendorContestsResponse,
  SubmitIntegrationContestInput,
  VendorContestResponse,
  ListDataObjectsResponse,
  ListProductVersionsResponse,
  ListVendorIntegrationsResponse,
  ListVendorNotificationsResponse,
  CreateSeatInviteResponse,
  ResendSeatInviteResponse,
  ListVendorSeatsResponse,
  TaxonomyResponse,
  UpdateVendorProductInput,
  UpdateVendorProductResponse,
  UpdateVendorProfileInput,
  UpdateVendorProfileResponse,
  UpsertVendorAttestationInput,
  VendorClaimResponse,
  VendorMeResponse,
  VendorProductConnectorsResponse,
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

  /** `GET /api/vendor/updates` — the per-scope freshness cursor (AECI-627): seven
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

  /** `POST /api/vendor/seats/invites` — invite a colleague (AECI-664 / §11a).
   *  Owner-only server-side; any address is accepted (§11a.3 dropped the domain
   *  gate). A refusal is an `ApiError` the caller renders, never something this
   *  client pre-empts. */
  inviteSeat(email: string): Promise<CreateSeatInviteResponse> {
    return firstValueFrom(
      this.http.post<CreateSeatInviteResponse>('/api/vendor/seats/invites', { email }),
    );
  }

  /** `POST /api/vendor/seats/invites/:id/resend` — mail a pending invite again
   *  (AECI-927 / §11a.9). Same token, refreshed expiry. Owner-only server-side,
   *  and refused with a 429 inside the per-invite cooldown or a 422 once the
   *  lifetime send cap is reached — both rendered by the caller. */
  resendInvite(inviteId: string): Promise<ResendSeatInviteResponse> {
    return firstValueFrom(
      this.http.post<ResendSeatInviteResponse>(
        `/api/vendor/seats/invites/${inviteId}/resend`,
        // No body: the invite is named by the path and everything else is server
        // policy. `HttpClient.post` requires the argument, so it is an explicit
        // `null` rather than an empty object that implies a shape.
        null,
      ),
    );
  }

  /** `DELETE /api/vendor/seats/invites/:id` — revoke a pending invite (204). */
  revokeInvite(inviteId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/vendor/seats/invites/${inviteId}`));
  }

  /** `DELETE /api/vendor/seats/:userId` — remove a colleague's seat (204). */
  removeSeat(userId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/vendor/seats/${userId}`));
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
   *  vendor without active account access gets a real surface it cannot yet write to. */
  getIntegrations(): Promise<ListVendorIntegrationsResponse> {
    return firstValueFrom(
      this.http.get<ListVendorIntegrationsResponse>('/api/vendor/integrations'),
    );
  }

  /** `GET /api/vendor/data-objects` — the closed `data_object` vocabulary, in
   *  the vocabulary (`display_order`) order the claim lanes use. `data_object`
   *  is find-only server-side, so the picker offers this list rather than a text
   *  input (AECI-606 / §5.2). The picker itself re-sorts alphabetically by label
   *  — see `dataObjectOptions` in `components/vendor-add-claim-form.ts`. */
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

  /** `GET /api/vendor/products/:id/connectors` — the connectors that deliver
   *  or reach an owned product, grouped per connector (AECI-1013). Read-only and
   *  outside the live cursor, so it is fetched once per product and never
   *  polled. */
  listProductConnectors(productId: string): Promise<VendorProductConnectorsResponse> {
    return firstValueFrom(
      this.http.get<VendorProductConnectorsResponse>(
        `/api/vendor/products/${encodeURIComponent(productId)}/connectors`,
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
    contextProductId?: string | null,
  ): Promise<VendorClaimResponse> {
    // `context_product_id` frames the echoed claim only (AECI-666); it is not part
    // of the stored position, so it rides the wire body without joining
    // `VendorAttestationPosition`.
    const body = {
      ...position,
      context_product_id: contextProductId ?? null,
    } satisfies UpsertVendorAttestationInput;
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

  // ─── Field contests (AECI-1008 / §11b) ──────────────────────────────────────

  /** `GET /api/vendor/contests` — what this vendor submitted and what routes to
   *  it as an integration's owner. Newest first, 100 per list. Seat-gated only. */
  getContests(): Promise<ListVendorContestsResponse> {
    return firstValueFrom(this.http.get<ListVendorContestsResponse>('/api/vendor/contests'));
  }

  /** `POST /api/vendor/integrations/:id/contests` — contest one field (201).
   *  `proposed_value` is in wire form: `direction` caller-relative, `owner` a
   *  vendor id or `null`. */
  submitContest(
    integrationId: string,
    body: SubmitIntegrationContestInput,
  ): Promise<VendorContestResponse> {
    return firstValueFrom(
      this.http.post<VendorContestResponse>(
        `/api/vendor/integrations/${encodeURIComponent(integrationId)}/contests`,
        body,
      ),
    );
  }

  /** `POST /api/vendor/integrations/:id/retire` (AECI-1010) — the owner withdraws a
   *  claimed integration from the public site. A retired row is
   *  `409 INTEGRATION_RETIRED`. Open contests on it close as withdrawn. */
  retireIntegration(integrationId: string): Promise<RetireIntegrationResponse> {
    return firstValueFrom(
      this.http.post<RetireIntegrationResponse>(
        `/api/vendor/integrations/${encodeURIComponent(integrationId)}/retire`,
        null,
      ),
    );
  }

  /** `POST /api/vendor/integrations/:id/restore` (AECI-1010) — the owner brings a
   *  retired integration back. A live row is `409 INTEGRATION_NOT_RETIRED`. */
  restoreIntegration(integrationId: string): Promise<RetireIntegrationResponse> {
    return firstValueFrom(
      this.http.post<RetireIntegrationResponse>(
        `/api/vendor/integrations/${encodeURIComponent(integrationId)}/restore`,
        null,
      ),
    );
  }

  /** `POST /api/vendor/contests/:id/withdraw` — the submitter withdraws an open
   *  contest. A closed one is `409 CONTEST_NOT_OPEN`. */
  withdrawContest(contestId: string): Promise<VendorContestResponse> {
    return firstValueFrom(
      this.http.post<VendorContestResponse>(
        `/api/vendor/contests/${encodeURIComponent(contestId)}/withdraw`,
        null,
      ),
    );
  }

  // ─── Integration ownership (AECI-1005 claim / AECI-1006 edit) ───────────────

  /** `POST /api/vendor/integrations/:id/claim` — the recorded owner takes the row
   *  (200). No body. From then on promote writes nothing to it. */
  claimIntegration(integrationId: string): Promise<ClaimIntegrationResponse> {
    return firstValueFrom(
      this.http.post<ClaimIntegrationResponse>(
        `/api/vendor/integrations/${encodeURIComponent(integrationId)}/claim`,
        null,
      ),
    );
  }

  /** `PATCH /api/vendor/integrations/:id` — the claimed owner edits standard
   *  fields. Send only the changed ones; `direction` is framed by
   *  `context_product_id`. Goes live with no moderation. */
  updateIntegration(
    integrationId: string,
    body: UpdateVendorIntegrationInput,
  ): Promise<UpdateVendorIntegrationResponse> {
    return firstValueFrom(
      this.http.patch<UpdateVendorIntegrationResponse>(
        `/api/vendor/integrations/${encodeURIComponent(integrationId)}`,
        body,
      ),
    );
  }

  /** `POST /api/vendor/contests/:id/decision` — the owner accepts or declines an
   *  owner-routed contest. An accept writes the catalog in the same batch. */
  decideContest(contestId: string, body: DecideContestInput): Promise<VendorContestResponse> {
    return firstValueFrom(
      this.http.post<VendorContestResponse>(
        `/api/vendor/contests/${encodeURIComponent(contestId)}/decision`,
        body,
      ),
    );
  }

  // ─── Vendor create (AECI-1011) ─────────────────────────────────────────────

  /** `POST /api/vendor/integrations` — list a new integration between one of the
   *  caller's products and a promoted counterpart. Goes live with no moderation.
   *  `possible_duplicates` in the 201 is a warning, never a refusal. */
  createIntegration(body: CreateVendorIntegrationInput): Promise<CreateVendorIntegrationResponse> {
    return firstValueFrom(
      this.http.post<CreateVendorIntegrationResponse>('/api/vendor/integrations', body),
    );
  }

  /** The counterpart picker's search: the PUBLIC `GET /api/products?search=`, over
   *  the same-origin passthrough. Public on purpose: the counterpart is any
   *  published product, and this list is exactly what a visitor can see. The
   *  server re-checks that the pick is promoted. */
  searchProducts(query: string, perPage = 8): Promise<ProductsListResponse> {
    const params = new URLSearchParams({ search: query, perPage: String(perPage) });
    return firstValueFrom(this.http.get<ProductsListResponse>(`/api/products?${params}`));
  }

  // ─── Per-side integration links (AECI-1007) ────────────────────────────────

  /** `PUT /api/vendor/integrations/:id/links/:productId/:kind` — set the caller's
   *  own listing or docs link for its product on this integration. Seat-gated only. */
  putIntegrationLink(
    integrationId: string,
    productId: string,
    kind: IntegrationLinkKind,
    url: string,
  ): Promise<IntegrationLinkResponse> {
    return firstValueFrom(
      this.http.put<IntegrationLinkResponse>(integrationLinkPath(integrationId, productId, kind), {
        url,
      }),
    );
  }

  /** `DELETE …/links/:productId/:kind` — remove it. Removing an unset link is a
   *  200 that writes nothing. */
  deleteIntegrationLink(
    integrationId: string,
    productId: string,
    kind: IntegrationLinkKind,
  ): Promise<IntegrationLinkResponse> {
    return firstValueFrom(
      this.http.delete<IntegrationLinkResponse>(
        integrationLinkPath(integrationId, productId, kind),
      ),
    );
  }
}

function integrationLinkPath(
  integrationId: string,
  productId: string,
  kind: IntegrationLinkKind,
): string {
  return `/api/vendor/integrations/${encodeURIComponent(integrationId)}/links/${encodeURIComponent(productId)}/${kind}`;
}
