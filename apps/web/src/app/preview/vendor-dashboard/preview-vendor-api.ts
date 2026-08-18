import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';

import type {
  AgreementAttestation,
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
  VendorClaim,
  VendorClaimResponse,
  VendorMeResponse,
  VendorSeat,
} from '@aeci/shared';
import { computeAgreement } from '@aeci/shared';

import { VendorApi, type VendorAttestationPosition } from '../../vendor/vendor-api';
import {
  VENDOR_DATA_OBJECTS_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_NOTIFICATIONS_FIXTURE,
  VENDOR_PRODUCT_VERSIONS_FIXTURE,
  VENDOR_SEATS_FIXTURE,
  VENDOR_TAXONOMY_FIXTURE,
} from '../../vendor/vendor-fixtures';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Build the error body the API Worker actually returns, so the preview
 *  exercises the same `readVendorApiError` branch the live surface does. */
function apiError(
  status: number,
  code: string,
  message: string,
  extra: { field?: string; details?: unknown } = {},
): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: { error: { code, message, ...extra }, trace_id: 'preview' },
  });
}

/**
 * Recompute a claim's agreement the way the server does.
 *
 * Deliberately the REAL `computeAgreement`, not a hand-written approximation:
 * a fake that guessed would show the preview states the engine cannot produce,
 * and the property this whole surface rests on — that one vendor's word never
 * reads as `confirmed` — would go unreviewed exactly where it is reviewed.
 *
 * The caller's own rows collapse to a single voter (all `mine` entries carry the
 * same `attested_by_vendor_id` in reality, however many slots they fill), and
 * the counterparty, when present, is a second one.
 */
function recomputeAgreement(claim: VendorClaim): VendorClaim['agreement'] {
  const votes: AgreementAttestation[] = [];
  for (const own of claim.mine) {
    votes.push({
      source: own.slot,
      asserted: own.asserted,
      attestedByVendorId: 'preview-self',
      retractedAt: null,
    });
  }
  if (claim.counterparty) {
    votes.push({
      source: 'vendor_b',
      asserted: claim.counterparty.asserted,
      attestedByVendorId: 'preview-counterparty',
      retractedAt: null,
    });
  }
  return computeAgreement(votes);
}

/**
 * Fixture-backed {@link VendorApi} for the dev-only vendor-dashboard preview
 * (AECI-522). It shadows the real client via DI so the exact same components
 * exercise realistic reads + writes without a vendor session or the API Worker:
 * mutations merge the diff into an in-memory copy and echo it back, so the
 * optimistic-save UX (and the form settling to a clean state) is fully
 * reviewable. No network is ever touched.
 */
// Intentionally component-scoped, not `providedIn: 'root'`: this fake is provided
// only in the vendor-dashboard preview's `providers` (shadowing the real
// `VendorApi`), so it must never leak into the app-wide injector.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
export class PreviewVendorApi extends VendorApi {
  private me: VendorMeResponse | null = null;
  private seats: VendorSeat[] = clone([...VENDOR_SEATS_FIXTURE]);
  private integrations: ListVendorIntegrationsResponse = clone(VENDOR_INTEGRATIONS_FIXTURE);
  private nextClaimSeq = 0;

  /** Point the fake at the fixture the preview is currently showing, so writes
   *  merge onto the matching vendor/products. Clones so the shared fixture
   *  constants are never mutated across preview sessions. */
  setFixture(
    me: VendorMeResponse,
    seats: readonly VendorSeat[],
    integrations: ListVendorIntegrationsResponse = VENDOR_INTEGRATIONS_FIXTURE,
  ): void {
    this.me = clone(me);
    this.seats = clone([...seats]);
    this.integrations = clone(integrations);
    this.nextClaimSeq = 0;
  }

  override async getMe(): Promise<VendorMeResponse> {
    // `setFixture` always runs (in the preview's effect) before any read.
    return clone(this.me!);
  }

  override async getSeats(): Promise<ListVendorSeatsResponse> {
    return { seats: clone(this.seats) };
  }

  override async updateProfile(
    input: UpdateVendorProfileInput,
  ): Promise<UpdateVendorProfileResponse> {
    if (this.me) Object.assign(this.me.vendor, input);
    return { vendor: clone(this.me!.vendor) };
  }

  override async updateProduct(
    id: string,
    input: UpdateVendorProductInput,
  ): Promise<UpdateVendorProductResponse> {
    const product = this.me?.products.find((p) => p.id === id);
    if (product) Object.assign(product, input);
    return { product: clone(product!) };
  }

  override async getTaxonomy(): Promise<TaxonomyResponse> {
    return clone(VENDOR_TAXONOMY_FIXTURE);
  }

  // ─── Attestations (AECI-606) ───────────────────────────────────────────────

  override async getIntegrations(): Promise<ListVendorIntegrationsResponse> {
    return clone(this.integrations);
  }

  override async getDataObjects(): Promise<ListDataObjectsResponse> {
    return { data_objects: clone([...VENDOR_DATA_OBJECTS_FIXTURE]) };
  }

  override async listProductVersions(productId: string): Promise<ListProductVersionsResponse> {
    return { versions: clone([...(VENDOR_PRODUCT_VERSIONS_FIXTURE[productId] ?? [])]) };
  }

  override async createClaim(input: CreateVendorClaimInput): Promise<VendorClaimResponse> {
    const integration = this.integrations.integrations.find((i) => i.id === input.integration_id);
    if (!integration) {
      throw apiError(404, 'NOT_FOUND', 'Integration not found');
    }

    const term = VENDOR_DATA_OBJECTS_FIXTURE.find((d) => d.slug === input.data_object);
    if (!term) {
      // Find-only: the vocabulary owns the matching, and the picker is what
      // stops a vendor reaching this branch at all.
      throw apiError(400, 'VALIDATION_FAILED', `Unknown data object "${input.data_object}"`, {
        field: 'data_object',
      });
    }

    // The identity triple `(integration, data_object, direction)`. Returning the
    // existing id is what lets the UI pivot to PUT instead of dead-ending — the
    // whole reason this branch is worth faking.
    const clash = integration.claims.find(
      (c) => c.data_object_slug === term.slug && c.direction === input.direction,
    );
    if (clash) {
      throw apiError(
        400,
        'VALIDATION_FAILED',
        `A "${term.name}" claim already exists in that direction on this integration`,
        { field: 'data_object', details: { claim_id: clash.id } },
      );
    }

    const now = new Date('2026-08-18T12:00:00.000Z').toISOString();
    const claim: VendorClaim = {
      id: `preview-claim-${++this.nextClaimSeq}`,
      integration_id: integration.id,
      data_object_slug: term.slug,
      data_object_name: term.name,
      direction: input.direction,
      // Creating a claim IS affirming it — there is no `asserted` on the input,
      // and every owned slot gets a row.
      agreement: 'unverified',
      origin: 'vendor',
      mine: integration.slots.map((slot) => ({
        slot,
        asserted: true,
        note: input.note ?? null,
        introduced_version_id: input.introduced_version_id ?? null,
        deprecated_version_id: input.deprecated_version_id ?? null,
        updated_at: now,
      })),
      counterparty: null,
    };
    claim.agreement = recomputeAgreement(claim);
    integration.claims.push(claim);
    return { claim: clone(claim) };
  }

  override async upsertAttestation(
    claimId: string,
    position: VendorAttestationPosition,
  ): Promise<VendorClaimResponse> {
    const found = this.findClaim(claimId);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Claim not found');
    const { integration, claim } = found;

    const now = new Date('2026-08-18T12:00:00.000Z').toISOString();
    // REPLACE, never merge. Faking a merge here would make a genuine
    // PUT-treated-as-PATCH bug look correct in the one place it gets reviewed.
    claim.mine = integration.slots.map((slot) => ({
      slot,
      asserted: position.asserted,
      note: position.note,
      introduced_version_id: position.introduced_version_id,
      deprecated_version_id: position.deprecated_version_id,
      updated_at: now,
    }));
    claim.agreement = recomputeAgreement(claim);
    return { claim: clone(claim) };
  }

  override async retractAttestation(claimId: string): Promise<void> {
    const found = this.findClaim(claimId);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Claim not found');

    // Nothing of the caller's to retract is a 404, deliberately not an
    // idempotent 204 — §26.1 wants no audit row without a state change.
    if (found.claim.mine.length === 0)
      throw apiError(404, 'NOT_FOUND', 'No attestation to retract');

    found.claim.mine = [];
    found.claim.agreement = recomputeAgreement(found.claim);
  }

  override async getNotifications(): Promise<ListVendorNotificationsResponse> {
    return { notifications: clone([...VENDOR_NOTIFICATIONS_FIXTURE]) };
  }

  private findClaim(claimId: string) {
    for (const integration of this.integrations.integrations) {
      const claim = integration.claims.find((c) => c.id === claimId);
      if (claim) return { integration, claim };
    }
    return null;
  }
}
