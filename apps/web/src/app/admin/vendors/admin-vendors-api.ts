/**
 * Client for the admin vendor endpoints (AECI-652 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.6), consumed by `/admin/vendors` and
 * `/admin/vendors/:id`.
 *
 * Mirrors `AdminClaimsApi`: browser-side reads/mutations over the SSR Worker's
 * `/api/*` passthrough (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAdmin()` authenticates and authorizes them — no token is threaded by
 * hand, and the frontend never decides who is an admin. Only ever called from
 * user actions / `afterNextRender`, never during SSR render (the gate and shell
 * already SSR via `adminSummaryResolver`).
 *
 * License writes are not here. They are `AdminLicensesApi`, used by the Billing
 * tab's grant and license actions (AECI-1375 retired the entitlement write).
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminVendorIntegrationsQuery,
  AdminVendorIntegrationsResponse,
  AdminVendorAuditQuery,
  AdminVendorAuditResponse,
  AdminVendorBillingResponse,
  AdminVendorDetail,
  AdminVendorProductsQuery,
  AdminVendorProductsResponse,
  AdminVendorsListQuery,
  AdminVendorsListResponse,
  RetireIntegrationResponse,
  AdminFieldHideResponse,
  AdminFieldHidesResponse,
  AdminFieldOverrideResponse,
  AdminFieldOverridesResponse,
  AdminSetFieldHideInput,
  AdminSetFieldOverrideInput,
  AdminBrandAssetHoldResponse,
  AdminReturnRecordsResponse,
  AdminListingHideResponse,
  ListingHideKind,
  ListBrandAssetRemovalsResponse,
  TaxonomyResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminVendorsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/vendors` — the paginated vendor list, name/slug search. */
  listVendors(
    query: Partial<Record<keyof AdminVendorsListQuery, string | number | boolean>> = {},
  ): Promise<AdminVendorsListResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorsListResponse>('/api/admin/vendors', {
        params: toParams(query),
      }),
    );
  }

  /** `GET /api/admin/vendors/:id` — basics, seats, counts. */
  getVendor(id: string): Promise<AdminVendorDetail> {
    return firstValueFrom(
      this.http.get<AdminVendorDetail>(`/api/admin/vendors/${encodeURIComponent(id)}`),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/billing` (AECI-1372, E4.3): the read-only Billing tab.
   * Billing account and owner seats, every license, the agreement acceptances and the
   * early-unassign requests, in one payload. `billing_account: null` is a vendor the
   * E1 back-fill missed, not an error.
   */
  getBilling(id: string): Promise<AdminVendorBillingResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorBillingResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/billing`,
      ),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/products` — the vendor's product roster, the
   * Products tab's only read. Paginated, name-ordered, every ownership row (a
   * co-owned product is owned).
   */
  listProducts(
    id: string,
    query: Partial<Record<keyof AdminVendorProductsQuery, string | number>> = {},
  ): Promise<AdminVendorProductsResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorProductsResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/products`,
        { params: toParams(query) },
      ),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/integrations` (AECI-1046) — the vendor-held
   * integrations this vendor owns, live and retired. The Integrations tab's read.
   */
  listIntegrations(
    id: string,
    query: Partial<Record<keyof AdminVendorIntegrationsQuery, string | number>> = {},
  ): Promise<AdminVendorIntegrationsResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorIntegrationsResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/integrations`,
        { params: toParams(query) },
      ),
    );
  }

  /**
   * `POST /api/admin/integrations/:id/retire` or `/restore` (AECI-1046). The reason
   * is required and, since AECI-1159, shown to the integration's owner. The optional
   * internal note goes into the audit row only.
   */
  setIntegrationRetired(
    integrationId: string,
    mode: 'retire' | 'restore',
    reason: string,
    internalNote = '',
  ): Promise<RetireIntegrationResponse> {
    return firstValueFrom(
      this.http.post<RetireIntegrationResponse>(
        `/api/admin/integrations/${encodeURIComponent(integrationId)}/${mode}`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/field-overrides` (AECI-1237): the active AECi field
   * locks on the vendor, its products and the integrations it owns.
   */
  listFieldOverrides(vendorId: string): Promise<AdminFieldOverridesResponse> {
    return firstValueFrom(
      this.http.get<AdminFieldOverridesResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/field-overrides`,
      ),
    );
  }

  /**
   * `POST /api/admin/field-overrides` (AECI-1237): correct one field and lock it. The
   * reason is shown to the vendor; the internal note is never shown.
   */
  setFieldOverride(input: AdminSetFieldOverrideInput): Promise<AdminFieldOverrideResponse> {
    return firstValueFrom(
      this.http.post<AdminFieldOverrideResponse>('/api/admin/field-overrides', {
        ...input,
        ...overrideReasonBody(input.reason, input.internalNote ?? ''),
      }),
    );
  }

  /**
   * `GET /api/taxonomy`: the four facet vocabularies. The facet correction form
   * (AECI-1382) lists a facet's terms from it and the lock list names a locked set.
   */
  getTaxonomy(): Promise<TaxonomyResponse> {
    return firstValueFrom(this.http.get<TaxonomyResponse>('/api/taxonomy'));
  }

  /** `POST /api/admin/field-overrides/:id/lift` (AECI-1237). Same reason rule. */
  liftFieldOverride(
    overrideId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminFieldOverrideResponse> {
    return firstValueFrom(
      this.http.post<AdminFieldOverrideResponse>(
        `/api/admin/field-overrides/${encodeURIComponent(overrideId)}/lift`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }

  /**
   * `GET /api/admin/vendors/:id/field-hides` (AECI-1238, §11d.7): every active value
   * hide on the vendor's records, with the hide-by and decide-by dates and the last
   * status reply.
   */
  listFieldHides(vendorId: string): Promise<AdminFieldHidesResponse> {
    return firstValueFrom(
      this.http.get<AdminFieldHidesResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/field-hides`,
      ),
    );
  }

  /**
   * `POST /api/admin/field-hides` (AECI-1238): hide one value on a vendor-held record
   * while AECi checks it. The reason is shown to the vendor; the note never is.
   */
  setFieldHide(input: AdminSetFieldHideInput): Promise<AdminFieldHideResponse> {
    return firstValueFrom(
      this.http.post<AdminFieldHideResponse>('/api/admin/field-hides', {
        ...input,
        ...overrideReasonBody(input.reason, input.internalNote ?? ''),
      }),
    );
  }

  /** `POST /api/admin/field-hides/:id/restore`: the value stands and is shown again. */
  restoreFieldHide(hideId: string, reason: string): Promise<AdminFieldHideResponse> {
    return firstValueFrom(
      this.http.post<AdminFieldHideResponse>(
        `/api/admin/field-hides/${encodeURIComponent(hideId)}/restore`,
        { reason },
      ),
    );
  }

  /** `POST /api/admin/field-hides/:id/status-reply`: record the status reply AECi sent
   *  the requester. Audit only; the vendor is not told. */
  recordFieldHideStatusReply(hideId: string, note: string): Promise<AdminFieldHideResponse> {
    return firstValueFrom(
      this.http.post<AdminFieldHideResponse>(
        `/api/admin/field-hides/${encodeURIComponent(hideId)}/status-reply`,
        { note },
      ),
    );
  }

  /**
   * `POST /api/admin/vendors/:id/hide` (AECI-1238, §11d.6): take the company off the
   * public site. Every product joined to it is hidden too, through a child hide row.
   * The reason is shown to the vendor; the internal note is never shown.
   */
  hideVendor(vendorId: string, body: ListingHideInput): Promise<AdminListingHideResponse> {
    return firstValueFrom(
      this.http.post<AdminListingHideResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/hide`,
        listingHideBody(body),
      ),
    );
  }

  /** `POST /api/admin/vendors/:id/restore` (AECI-1238): put the company back, with
   *  the products its hide took down. A product hidden on its own stays hidden. */
  restoreVendor(
    vendorId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminListingHideResponse> {
    return firstValueFrom(
      this.http.post<AdminListingHideResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/restore`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }

  /** `POST /api/admin/products/:id/hide` (AECI-1238): take one product off the public site. */
  hideProduct(productId: string, body: ListingHideInput): Promise<AdminListingHideResponse> {
    return firstValueFrom(
      this.http.post<AdminListingHideResponse>(
        `/api/admin/products/${encodeURIComponent(productId)}/hide`,
        listingHideBody(body),
      ),
    );
  }

  /**
   * `POST /api/admin/products/:id/restore` (AECI-1238). Refused with
   * `409 LISTING_HIDDEN_WITH_VENDOR` while the product's hide is its company's.
   */
  restoreProduct(
    productId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminListingHideResponse> {
    return firstValueFrom(
      this.http.post<AdminListingHideResponse>(
        `/api/admin/products/${encodeURIComponent(productId)}/restore`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }

  /** `GET /api/admin/vendors/:id/audit` — the `audit_log` viewer, newest first. */
  listAudit(
    id: string,
    query: Partial<Record<keyof AdminVendorAuditQuery, string | number>> = {},
  ): Promise<AdminVendorAuditResponse> {
    return firstValueFrom(
      this.http.get<AdminVendorAuditResponse>(
        `/api/admin/vendors/${encodeURIComponent(id)}/audit`,
        { params: toParams(query) },
      ),
    );
  }

  /**
   * `DELETE /api/admin/vendors/:id/seats/:userId` — revoke one seat.
   *
   * A seat revoke is NOT a license change and NOT a ban (§5.2): the vendor's
   * licenses and `vendors.verified` are untouched, and banning a person is
   * `/admin/users/:id`. It only un-grants this one person's access.
   *
   * AECI-1191: the body carries the admin's required `reason`, which the API
   * records in the `vendor_claim.seat_revoked` audit row. AECI-1159: the reason is
   * shown to the vendor's remaining seats, and the optional internal note is not.
   */
  revokeSeat(vendorId: string, userId: string, reason: string, internalNote = ''): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/seats/${encodeURIComponent(userId)}`,
        { body: overrideReasonBody(reason, internalNote) },
      ),
    );
  }

  /** `GET /api/admin/brand-asset-removals` (AECI-1618): every company with a removal pending. */
  listBrandAssetRemovals(): Promise<ListBrandAssetRemovalsResponse> {
    return firstValueFrom(
      this.http.get<ListBrandAssetRemovalsResponse>('/api/admin/brand-asset-removals'),
    );
  }

  /** `POST /api/admin/vendors/:id/brand-assets/hold` (AECI-1618). The API caps it at the limit. */
  holdBrandAssets(
    vendorId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminBrandAssetHoldResponse> {
    return firstValueFrom(
      this.http.post<AdminBrandAssetHoldResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/brand-assets/hold`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }

  /** `DELETE /api/admin/vendors/:id/brand-assets/hold` (AECI-1618). */
  liftBrandAssetHold(
    vendorId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminBrandAssetHoldResponse> {
    return firstValueFrom(
      this.http.delete<AdminBrandAssetHoldResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/brand-assets/hold`,
        { body: overrideReasonBody(reason, internalNote) },
      ),
    );
  }

  /**
   * `POST /api/admin/vendors/:id/return-to-aeci` — "Return records to AECi"
   * (AECI-1415, ADR 0042). The one action that moves ownership back to AECi, for a
   * mistaken claim approval. The API refuses while the vendor holds any seat
   * (`409 VENDOR_HAS_SEATS`). The reason is required and lands in the
   * `vendor.records_returned` audit row.
   */
  returnRecords(
    vendorId: string,
    reason: string,
    internalNote = '',
  ): Promise<AdminReturnRecordsResponse> {
    return firstValueFrom(
      this.http.post<AdminReturnRecordsResponse>(
        `/api/admin/vendors/${encodeURIComponent(vendorId)}/return-to-aeci`,
        overrideReasonBody(reason, internalNote),
      ),
    );
  }
}

/**
 * The body of an AECi override (AECI-1159): the vendor reason, and the internal
 * note only when one was written, so a blank note is never sent.
 */
export function overrideReasonBody(
  reason: string,
  internalNote: string,
): { reason: string; internalNote?: string } {
  const note = internalNote.trim();
  return note ? { reason, internalNote: note } : { reason };
}

/** What the admin form hands a hide call (AECI-1238). `AdminListingHideBodySchema`
 *  validates it on the API side. */
export interface ListingHideInput {
  kind: ListingHideKind;
  reason: string;
  internalNote?: string;
  /** `YYYY-MM-DD`, the date input's value. */
  receivedAt: string;
  sourceUrl?: string | null;
}

/**
 * The hide body as sent: the §11d.2 reason pair, plus the source link only when one
 * was entered, so a blank field is never sent as an empty string.
 */
function listingHideBody(body: ListingHideInput): {
  kind: ListingHideKind;
  receivedAt: string;
  reason: string;
  internalNote?: string;
  sourceUrl?: string;
} {
  const source = body.sourceUrl?.trim();
  return {
    kind: body.kind,
    receivedAt: body.receivedAt,
    ...overrideReasonBody(body.reason, body.internalNote ?? ''),
    ...(source ? { sourceUrl: source } : {}),
  };
}

function toParams(query: Record<string, string | number | boolean | undefined>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params = params.set(key, String(value));
  }
  return params;
}
