import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';

import type {
  RetireIntegrationResponse,
  ClaimIntegrationResponse,
  UpdateVendorIntegrationInput,
  UpdateVendorIntegrationResponse,
  DecideContestInput,
  ListVendorContestsResponse,
  SubmitIntegrationContestInput,
  VendorContest,
  VendorContestResponse,
  CreateSeatInviteResponse,
  ResendSeatInviteResponse,
  AgreementAttestation,
  CreateVendorClaimInput,
  ListDataObjectsResponse,
  ListProductVersionsResponse,
  ListVendorIntegrationsResponse,
  ListVendorNotificationsResponse,
  ListVendorSeatsResponse,
  ProductUsefulness,
  TaxonomyResponse,
  UpdateVendorProductInput,
  UpdateVendorProductResponse,
  UpdateVendorProfileInput,
  UpdateVendorProfileResponse,
  VendorClaim,
  VendorClaimResponse,
  VendorMeResponse,
  VendorProductConnectorsResponse,
  VendorSeat,
  VendorUpdatesResponse,
} from '@aeci/shared';
import {
  INTEGRATION_EDIT_FIELDS,
  computeAgreement,
  contestValueProblem,
  integrationEditValueProblem,
  type ContextDirection,
} from '@aeci/shared';

import { VendorApi, type VendorAttestationPosition } from '../../vendor/vendor-api';
import {
  VENDOR_CONTEST_NOTIFICATIONS_FIXTURE,
  VENDOR_CONTESTS_FIXTURE,
  VENDOR_DATA_OBJECTS_FIXTURE,
  INTEGRATION_RETIRED_BY_OTHER,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_NOTIFICATIONS_FIXTURE,
  VENDOR_PRODUCT_CONNECTORS_FIXTURE,
  VENDOR_PRODUCT_VERSIONS_FIXTURE,
  VENDOR_SEATS_FIXTURE,
  VENDOR_TAXONOMY_FIXTURE,
  VENDOR_SEAT_INVITES_FIXTURE,
} from '../../vendor/vendor-fixtures';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A frozen freshness cursor for the preview (AECI-629).
 *
 * Deliberately CONSTANT: `VendorLiveSync` treats a revision that differs from
 * last-seen as stale, so a fixture whose cursor never moves means the preview
 * seeds its baseline once and then refetches nothing, forever. A clock-derived
 * value here would make the preview refetch on every poll and mask the diff bug
 * this endpoint exists to avoid.
 */
const PREVIEW_UPDATES: VendorUpdatesResponse = {
  revisions: {
    profile: '2026-08-18T12:00:00.000Z',
    entitlement: '2026-08-18T12:00:00.000Z',
    products: '2026-08-18T12:00:00.000Z',
    integrations: '2026-08-18T12:00:00.000Z',
    notifications: '2026-08-18T12:00:00.000Z',
    // A vendor with no requests keeps a `null` cursor forever. Kept as `null`
    // here so the preview exercises the value most likely to be mishandled.
    requests: null,
    // AECI-1008. Frozen like the rest: the preview's contest writes revalidate
    // the list directly, so the cursor never needs to move.
    contests: '2026-08-18T12:00:00.000Z',
  },
  server_time: '2026-08-18T12:00:00.000Z',
};

/** Build the error body the API Worker actually returns, so the preview
 *  exercises the same `readVendorApiError` branch the live surface does. */
/** The same direction seen from the other endpoint. */
function mirrorDirection(direction: ContextDirection): ContextDirection {
  if (direction === 'both') return 'both';
  return direction === 'outbound' ? 'inbound' : 'outbound';
}

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
/**
 * The default list plus a row the other endpoint's owner has retired (AECI-1010), so
 * the preview shows all three retire states: Retire on the owned, claimed card,
 * Restore once retired, and the read-only retired card. Kept out of the shared
 * fixture because the drill-down specs count its groups.
 */
const PREVIEW_INTEGRATIONS: ListVendorIntegrationsResponse = {
  integrations: [...VENDOR_INTEGRATIONS_FIXTURE.integrations, INTEGRATION_RETIRED_BY_OTHER],
};

// Intentionally component-scoped, not `providedIn: 'root'`: this fake is provided
// only in the vendor-dashboard preview's `providers` (shadowing the real
// `VendorApi`), so it must never leak into the app-wide injector.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
export class PreviewVendorApi extends VendorApi {
  private me: VendorMeResponse | null = null;
  private seats: VendorSeat[] = clone([...VENDOR_SEATS_FIXTURE]);
  private integrations: ListVendorIntegrationsResponse = clone(PREVIEW_INTEGRATIONS);
  private nextClaimSeq = 0;
  private contests: ListVendorContestsResponse = clone(VENDOR_CONTESTS_FIXTURE);
  private nextContestSeq = 0;

  /** Point the fake at the fixture the preview is currently showing, so writes
   *  merge onto the matching vendor/products. Clones so the shared fixture
   *  constants are never mutated across preview sessions. */
  setFixture(
    me: VendorMeResponse,
    seats: readonly VendorSeat[],
    integrations: ListVendorIntegrationsResponse = PREVIEW_INTEGRATIONS,
  ): void {
    this.me = clone(me);
    this.seats = clone([...seats]);
    this.integrations = clone(integrations);
    this.nextClaimSeq = 0;
    this.contests = clone(VENDOR_CONTESTS_FIXTURE);
    this.nextContestSeq = 0;
  }

  override async getMe(): Promise<VendorMeResponse> {
    // `setFixture` always runs (in the preview's effect) before any read.
    return clone(this.me!);
  }

  override async getSeats(): Promise<ListVendorSeatsResponse> {
    // `can_manage_seats` is true here so the preview exercises the §11a owner
    // controls (invite form, revoke, remove) — reviewing a surface with its
    // primary actions hidden is reviewing a different surface.
    return {
      seats: clone(this.seats),
      pending_invites: clone([...VENDOR_SEAT_INVITES_FIXTURE]),
      can_manage_seats: true,
    };
  }

  /** The §11a writes, fixture-side: no-ops that resolve, so the preview can click
   *  through the controls without a vendor session or a live D1. */
  override async inviteSeat(email: string): Promise<CreateSeatInviteResponse> {
    return {
      invite: {
        id: 'preview-invite',
        email,
        invited_by: 'Dana Ruiz',
        expires_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-08-26T00:00:00.000Z',
        // Matches the real handler: a just-created invite is inside its own
        // cooldown, so the roster's Resend control is correctly dead on arrival.
        last_sent_at: null,
        resend_state: 'cooling_down',
      },
    };
  }

  /** AECI-927. Echoes the fixture row with the fields a re-send actually moves,
   *  so the preview shows the post-send state rather than an unchanged row. */
  override async resendInvite(inviteId: string): Promise<ResendSeatInviteResponse> {
    const existing = VENDOR_SEAT_INVITES_FIXTURE.find((invite) => invite.id === inviteId);
    return {
      invite: {
        ...(existing ?? VENDOR_SEAT_INVITES_FIXTURE[0]!),
        id: inviteId,
        last_sent_at: '2026-08-26T10:00:00.000Z',
        resend_state: 'cooling_down',
      },
    };
  }

  override async revokeInvite(): Promise<void> {}

  override async removeSeat(): Promise<void> {}

  /** The freshness cursor, frozen. See {@link PREVIEW_UPDATES}. */
  override async getUpdates(): Promise<VendorUpdatesResponse> {
    return clone(PREVIEW_UPDATES);
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
    if (product) {
      Object.assign(product, input);
      // AECI-963. The wire shape carries `slug` + `points` only — the real handler
      // resolves each group's display `name` from the taxonomy row before storing
      // it, because that name renders verbatim on the public page. A bare
      // `Object.assign` would leave the preview echoing name-less groups and the
      // form would paint blank labels for a bug that does not exist in production.
      if (input.usefulness !== undefined) {
        product.usefulness =
          input.usefulness === null ? null : resolvePreviewUsefulness(input.usefulness);
      }
    }
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

  override async listProductConnectors(
    productId: string,
  ): Promise<VendorProductConnectorsResponse> {
    return clone(
      VENDOR_PRODUCT_CONNECTORS_FIXTURE[productId] ?? { product_id: productId, connectors: [] },
    );
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
    // Newest first, as the ledger read orders them.
    const rows = [...VENDOR_CONTEST_NOTIFICATIONS_FIXTURE, ...VENDOR_NOTIFICATIONS_FIXTURE].sort(
      (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0),
    );
    return { notifications: clone(rows) };
  }

  // ─── Field contests (AECI-1008) ────────────────────────────────────────────

  override async getContests(): Promise<ListVendorContestsResponse> {
    return clone(this.contests);
  }

  /**
   * Mirrors the handler's refusals in its order: owner 403, value 422, no-change
   * 422, duplicate 409. Every contest routes to AECi here. Production routes a
   * content contest on a claimed integration to its owner (AECI-1005); the preview
   * has no claimed state to route on.
   */
  override async submitContest(
    integrationId: string,
    body: SubmitIntegrationContestInput,
  ): Promise<VendorContestResponse> {
    const integration = this.integrations.integrations.find(
      (i) =>
        i.id === integrationId &&
        (!body.context_product_id || i.context_product.id === body.context_product_id),
    );
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (integration.is_owner) {
      throw apiError(403, 'CONTEST_OWN_INTEGRATION', 'You own this integration');
    }
    const problem = contestValueProblem(body.field, body.proposed_value);
    if (problem) {
      throw apiError(422, 'CONTEST_INVALID_VALUE', problem, { field: 'proposed_value' });
    }
    const current = integration.contestable_fields[body.field] ?? null;
    if (current === body.proposed_value) {
      throw apiError(422, 'CONTEST_NO_CHANGE', 'Same as the current value', {
        field: 'proposed_value',
      });
    }
    if (
      this.contests.submitted.some(
        (c) => c.integration_id === integrationId && c.field === body.field && c.status === 'open',
      )
    ) {
      throw apiError(409, 'CONTEST_DUPLICATE', 'You already have an open contest on this field');
    }

    const now = '2026-09-18T12:00:00.000Z';
    const nameOf = (id: string | null) =>
      id === null ? null : (integration.endpoint_vendors.find((v) => v.id === id)?.name ?? null);
    const self = this.me?.vendor;
    const contest: VendorContest = {
      id: `00000000-0000-4000-8000-${String(0xc100 + ++this.nextContestSeq).padStart(12, '0')}`,
      integration_id: integration.id,
      integration_name: integration.name,
      context_product: integration.context_product,
      other_product: integration.other_product,
      field: body.field,
      current_value: current,
      proposed_value: body.proposed_value,
      current_label: body.field === 'owner' ? nameOf(current) : null,
      proposed_label: body.field === 'owner' ? nameOf(body.proposed_value) : null,
      reason: body.reason,
      routed_to: 'aeci',
      status: 'open',
      submitter_vendor: { id: self?.id ?? '', name: self?.company_name ?? '' },
      owner_vendor: integration.owner,
      decision_note: null,
      decided_at: null,
      created_at: now,
      updated_at: now,
    };
    this.contests.submitted.unshift(contest);
    return { contest: clone(contest) };
  }

  // ─── Integration ownership (AECI-1005 claim / AECI-1006 edit) ───────────────

  /** The claim, fixture-side: the same refusal order as the handler, then every
   *  entry for the integration (both frames when the caller owns both sides)
   *  reads as claimed. */
  override async claimIntegration(integrationId: string): Promise<ClaimIntegrationResponse> {
    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const integration = entries[0];
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!integration.is_owner) {
      throw integration.owner
        ? apiError(403, 'INTEGRATION_NOT_OWNER', 'Another company owns this integration')
        : apiError(409, 'INTEGRATION_OWNER_UNKNOWN', 'No owner is on file');
    }
    if (!integration.attestable) {
      throw apiError(403, 'INTEGRATION_CONNECTOR_POWERED', 'Connector-delivered integration');
    }
    if (integration.claimed_at) {
      throw apiError(409, 'INTEGRATION_ALREADY_CLAIMED', 'Already claimed');
    }
    const now = '2026-09-22T12:00:00.000Z';
    for (const entry of entries) entry.claimed_at = now;
    return {
      integration: {
        id: integrationId,
        owner_vendor_id: integration.owner?.id ?? '',
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
      },
    };
  }

  /** The owner's edit, fixture-side: the handler's gate and value rule, applied
   *  to every frame of the integration so the two entries of a both-sides row
   *  stay in step. `direction` is re-framed per entry, as the server does. */
  override async updateIntegration(
    integrationId: string,
    body: UpdateVendorIntegrationInput,
  ): Promise<UpdateVendorIntegrationResponse> {
    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const integration = entries[0];
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!integration.is_owner) {
      throw apiError(403, 'INTEGRATION_NOT_OWNER', 'Another company owns this integration');
    }
    if (!integration.attestable) {
      throw apiError(403, 'INTEGRATION_CONNECTOR_POWERED', 'Connector-delivered integration');
    }
    if (!integration.claimed_at) {
      throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Claim it first');
    }
    const frame =
      entries.find((e) => e.context_product.id === body.context_product_id) ?? integration;
    const changed: (typeof INTEGRATION_EDIT_FIELDS)[number][] = [];
    for (const field of INTEGRATION_EDIT_FIELDS) {
      const raw = body[field];
      if (raw === undefined) continue;
      const value = raw === null || raw.trim() === '' ? null : raw.trim();
      const problem = integrationEditValueProblem(field, value);
      if (problem) throw apiError(422, 'INTEGRATION_INVALID_VALUE', problem, { field });
      if (value === (frame.contestable_fields[field] ?? null)) continue;
      changed.push(field);
      for (const entry of entries) {
        const sameFrame = entry.context_product.id === frame.context_product.id;
        // A both-sides row shows the mirrored direction on its other entry.
        const framed =
          field === 'direction' && value !== null && !sameFrame
            ? mirrorDirection(value as ContextDirection)
            : value;
        entry.contestable_fields = { ...entry.contestable_fields, [field]: framed };
        if (field === 'name') entry.name = value;
        if (field === 'mechanism_name') entry.mechanism_name = value;
        if (field === 'mechanism_kind' && value !== null) {
          entry.mechanism_kind = value as typeof entry.mechanism_kind;
        }
      }
    }
    const now = '2026-09-22T12:00:00.000Z';
    return {
      integration: {
        id: integrationId,
        changed,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        updated_at: now,
      },
    };
  }

  override async withdrawContest(contestId: string): Promise<VendorContestResponse> {
    const contest = this.contests.submitted.find((c) => c.id === contestId);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Contest not found');
    if (contest.status !== 'open') {
      throw apiError(409, 'CONTEST_NOT_OPEN', 'This contest is no longer open');
    }
    contest.status = 'withdrawn';
    contest.updated_at = '2026-09-18T12:00:00.000Z';
    return { contest: clone(contest) };
  }

  /** AECI-1010. Mirrors the server's owner / claimed / state checks, and closes the
   *  row's open contests on retire, so the preview shows the real outcomes. */
  override async retireIntegration(integrationId: string): Promise<RetireIntegrationResponse> {
    return this.setRetired(integrationId, 'retire');
  }

  override async restoreIntegration(integrationId: string): Promise<RetireIntegrationResponse> {
    return this.setRetired(integrationId, 'restore');
  }

  private setRetired(integrationId: string, mode: 'retire' | 'restore'): RetireIntegrationResponse {
    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const first = entries[0];
    if (!first) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!first.is_owner) throw apiError(403, 'INTEGRATION_NOT_OWNER', 'Not the owner');
    if (!first.attestable) {
      throw apiError(403, 'INTEGRATION_CONNECTOR_POWERED', 'Connector-powered');
    }
    if (first.claimed_at === null) throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Not claimed');
    if (mode === 'retire' && first.retired_at !== null) {
      throw apiError(409, 'INTEGRATION_RETIRED', 'Already retired');
    }
    if (mode === 'restore' && first.retired_at === null) {
      throw apiError(409, 'INTEGRATION_NOT_RETIRED', 'Not retired');
    }
    const now = '2026-09-22T12:00:00.000Z';
    const retiredAt = mode === 'retire' ? now : null;
    // Both entries when the caller owns both endpoints: one row, two views.
    for (const entry of entries) entry.retired_at = retiredAt;
    const withdrawn: string[] = [];
    if (mode === 'retire') {
      for (const contest of [...this.contests.submitted, ...this.contests.received]) {
        if (contest.integration_id === integrationId && contest.status === 'open') {
          contest.status = 'withdrawn';
          contest.updated_at = now;
          withdrawn.push(contest.id);
        }
      }
    }
    return {
      integration: { id: integrationId, retired_at: retiredAt, updated_at: now },
      withdrawn_contest_ids: [...new Set(withdrawn)],
    };
  }

  override async decideContest(
    contestId: string,
    body: DecideContestInput,
  ): Promise<VendorContestResponse> {
    const contest = this.contests.received.find((c) => c.id === contestId);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Contest not found');
    if (contest.status !== 'open') {
      throw apiError(409, 'CONTEST_NOT_OPEN', 'This contest is no longer open');
    }
    const now = '2026-09-18T12:00:00.000Z';
    contest.status = body.decision === 'accept' ? 'accepted' : 'declined';
    contest.decision_note = body.note ?? null;
    contest.decided_at = now;
    contest.updated_at = now;
    return { contest: clone(contest) };
  }

  private findClaim(claimId: string) {
    for (const integration of this.integrations.integrations) {
      const claim = integration.claims.find((c) => c.id === claimId);
      if (claim) return { integration, claim };
    }
    return null;
  }
}

/**
 * The preview's stand-in for the server's `resolveUsefulness` (AECI-963).
 *
 * Fills each group's canonical `name` from {@link VENDOR_TAXONOMY_FIXTURE} and
 * drops a group whose slug the fixture vocabulary does not know — the real handler
 * 400s there, but a preview that threw would be a worse lie than one that mirrors
 * find-only resolution. An all-empty result normalises to `null`, exactly as the
 * handler does, so "cleared" has one encoding on both sides.
 */
function resolvePreviewUsefulness(
  input: NonNullable<UpdateVendorProductInput['usefulness']>,
): ProductUsefulness | null {
  const resolve = (
    groups: readonly { slug: string; points: string[] }[],
    terms: readonly { slug: string; name: string }[],
  ) =>
    groups.flatMap((group) => {
      const term = terms.find((t) => t.slug === group.slug);
      return term ? [{ slug: term.slug, name: term.name, points: [...group.points] }] : [];
    });

  const audiences = resolve(input.audiences, VENDOR_TAXONOMY_FIXTURE.audiences);
  const phases = resolve(input.phases, VENDOR_TAXONOMY_FIXTURE.phases);
  return audiences.length === 0 && phases.length === 0 ? null : { audiences, phases };
}
