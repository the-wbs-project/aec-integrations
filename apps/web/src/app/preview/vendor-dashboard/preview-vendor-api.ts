import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';

import {
  FileVetoObjectionSchema,
  REMOVAL_ELECTION_FIELDS,
  REMOVAL_REASON_LABELS,
} from '@aeci/shared';
import type {
  FileVetoObjectionInput,
  RemovalReasonCode,
  VetoObjectionResponse,
  AcceptLegalVersionRequest,
  AcceptLegalVersionResponse,
  VendorLegalAcceptanceResponse,
  THREAD_ACK_TEXT_VERSION,
  CreateRemovalElectionResponse,
  RemovalElectionResponse,
  AcceptSeatClaimResponse,
  GetVendorIntegrationThreadsResponse,
  GetVendorThreadByIdResponse,
  GetVendorThreadResponse,
  ListVendorThreadsResponse,
  ThreadCompany,
  VendorThread,
  VendorThreadById,
  VendorThreadListItem,
  VendorThreadListStatus,
  VendorThreadResult,
  ContestAnchorKind,
  RetireIntegrationResponse,
  ClaimIntegrationResponse,
  CreateVendorIntegrationInput,
  CreateVendorIntegrationResponse,
  ProductListItem,
  ProductsListResponse,
  VendorIntegration,
  UpdateVendorIntegrationInput,
  UpdateVendorIntegrationResponse,
  DecideContestInput,
  FileContestProtestInput,
  ReplyContestProtestInput,
  IntegrationLinkKind,
  IntegrationLinkResponse,
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
  ListVendorDeliveredPairsResponse,
  ListVendorNotificationsResponse,
  NotificationPreferencesResponse,
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
  VendorConnectorStubMappingEditResponse,
  UpdateConnectorStubMappingInput,
  VendorConnectorCatalogResponse,
  VendorChecklistResponse,
  VendorProductChecklistResponse,
  ReviewVendorProfileResponse,
  ReviewVendorProductResponse,
  ReviewVendorProductIntegrationsResponse,
  ListVendorHistoryFollowUpResponse,
  ListVendorHistoryResponse,
  ListVendorReviewsResponse,
  VendorReviewItem,
  VendorReviewResponseResult,
  CreateProductRequestInput,
  CreateProductRequestResponse,
  ListVendorProductRequestsResponse,
  VendorProductRequest,
  VendorAgreementAcceptance,
  VendorAgreementAcceptancesResponse,
  VendorBillingResponse,
  VendorLicenseResponse,
  AcceptLicenseGrantInput,
  AcceptLicenseGrantResponse,
  StripeBillingInterval,
  StripeRedirectResponse,
  AddStripeLicensesResponse,
  CreateLicenseReleaseRequestResponse,
  AcceptVendorProposalResponse,
  CreateVendorProductInput,
  CreateVendorProductResponse,
  ListVendorProposalsResponse,
  VendorProposal,
  PossibleDuplicateIntegration,
  PossibleDuplicatesResponse,
  AddOwnerFlowInput,
  ChangeOwnerFlowInput,
  ContextDirection as OwnerFlowDirection,
  CreateSyncServicePairInput,
  CreateSyncServicePairResponse,
  DecidePairContestInput,
  OwnedFlow,
  OwnedIntegration,
  OwnerFlowsResponse,
  PairContest,
  PairContestResponse,
  PairFlowDirection,
  SubmitPairContestInput,
  SyncServicePairVeto,
  VendorPairContestsResponse,
  VendorVetoesResponse,
  VetoWriteResponse,
} from '@aeci/shared';
import { capabilitiesFor } from '@aeci/shared/entitlements';
import { compareText } from '@aeci/shared/text-sort';
import {
  AGREEMENT_CHECKBOX_LABELS,
  PLANS_PAGE_CURRENT_VERSION,
  plansPageSha256,
  CreateProductRequestSchema,
  UpdateBillingEmailRequestSchema,
  UpdateVendorLegalNameRequestSchema,
  CONNECTOR_DECISION_STATUSES,
  CreateVendorIntegrationSchema,
  CONNECTOR_POWERED_FROZEN_EDIT_FIELDS,
  EMPTY_CONTESTABLE_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  attestationNoteProblem,
  computeAgreement,
  contestFieldsFor,
  contestValueProblem,
  integrationEditValueProblem,
  isAwaitingCounterpartAnswer,
  unusedAfterPurchase,
  countOwnerFlowsAwaitingAnswer,
  isSyncService,
  type ContestableFields,
  type ContextDirection,
  type IntegrationEditField,
} from '@aeci/shared';

import {
  VendorApi,
  type VendorAttestationPosition,
  type VendorConnectorCatalogFilters,
  type VendorHistoryFilters,
  type VendorReviewsFilters,
} from '../../vendor/vendor-api';
import {
  VENDOR_HISTORY_FIXTURE,
  VENDOR_HISTORY_FOLLOW_UP_FIXTURE,
  historyKindKeeps,
} from '../../vendor/vendor-history-fixtures';
import { LEGAL_NOTHING_PENDING_FIXTURE } from '../../vendor/vendor-legal-fixtures';
import { VENDOR_PROPOSALS_FIXTURE } from '../../vendor/vendor-proposal-fixtures';
import { VENDOR_REVIEWS_FIXTURE } from '../../vendor/vendor-review-fixtures';
import {
  VENDOR_CONNECTOR_CATALOG_FIXTURE,
  type ConnectorCatalogFixture,
} from '../../vendor/vendor-catalogue-fixtures';
import {
  VENDOR_CONTEST_NOTIFICATIONS_FIXTURE,
  VENDOR_CONTESTS_FIXTURE,
  VENDOR_DATA_OBJECTS_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_PENDING_GRANT_FIXTURE,
  CONTEST_RECEIVED_CLOSED_ON_OWNED,
  CONTEST_RECEIVED_ON_OWNED,
  INTEGRATION_CONNECTOR_OWNED,
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_OWNED_VIA_CONNECTOR,
  INTEGRATION_PROCORE_DETAIL,
  INTEGRATION_RETIRED_BY_AECI,
  INTEGRATION_RETIRED_BY_OTHER,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_OWNED_INTEGRATIONS_FIXTURE,
  VENDOR_DELIVERED_PAIRS_FIXTURE,
  VENDOR_SYNC_OWNED_FIXTURE,
  SYNC_SERVICE_PRODUCT,
  VENDOR_NOTIFICATIONS_FIXTURE,
  VENDOR_OVERRIDE_NOTIFICATIONS_FIXTURE,
  VENDOR_PRODUCT_CONNECTORS_FIXTURE,
  VENDOR_PRODUCT_REQUEST_NOTIFICATIONS_FIXTURE,
  VENDOR_PRODUCT_REQUESTS_FIXTURE,
  VENDOR_PRODUCT_VERSIONS_FIXTURE,
  VENDOR_SEATS_FIXTURE,
  VENDOR_TAXONOMY_FIXTURE,
  VENDOR_PENDING_SEAT_CLAIMS_FIXTURE,
  VENDOR_SEAT_INVITES_FIXTURE,
  VENDOR_ACCEPTANCES_FIXTURE,
  VENDOR_BILLING_FIXTURE,
  VENDOR_CHECKOUT_ACCEPTANCE_FIXTURE,
  NOTHING_CHECKED,
  productChecklistFixture,
  vendorChecklistFixture,
  type ChecklistFixtureState,
  type ProductChecklistFixtureState,
} from '../../vendor/vendor-fixtures';
import {
  PREVIEW_HYBRID_ENDPOINT_INTEGRATION,
  PREVIEW_RECEIVED_FLOW_REPORT,
  PREVIEW_RECEIVED_VETO,
  PREVIEW_RECEIVED_VETO_DECIDED,
  PREVIEW_RECEIVED_VETO_OBJECTED,
  PREVIEW_SYNC_EXTRA_OWNED,
  previewSyncConnectors,
} from './preview-sync-fixtures';

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
    // AECI-1083. Frozen: a preview save splices the PATCH echo in directly.
    catalogue: '2026-08-18T12:00:00.000Z',
    // AECI-1176. Frozen: no preview surface reads reviews yet (AECI-1179).
    reviews: '2026-08-18T12:00:00.000Z',
    // AECI-1538. Frozen, so the preview thread (AECI-1539) never re-reads on its own.
    threads: '2026-08-18T12:00:00.000Z',
  },
  server_time: '2026-08-18T12:00:00.000Z',
};

/**
 * One page of a catalogue fixture, filtered, searched and ordered the way
 * `GET /api/vendor/products/:id/connector-catalog` does it (AECI-1083): by name,
 * case-insensitive, the slug standing in for a missing label.
 */
function pageCatalogue(
  productId: string,
  fixture: ConnectorCatalogFixture,
  filters: VendorConnectorCatalogFilters,
): VendorConnectorCatalogResponse {
  const needle = filters.search.trim().toLowerCase();
  const matches = fixture.listings
    .filter((l) => {
      if (filters.state === 'undecided') {
        if (l.mappings.length > 0) return false;
      } else if (filters.state && !l.mappings.some((m) => m.status === filters.state)) {
        return false;
      }
      if (!needle) return true;
      return (
        l.slug.toLowerCase().includes(needle) || (l.label ?? '').toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => compareText(a.label ?? a.slug, b.label ?? b.slug) || compareText(a.id, b.id));
  const start = (filters.page - 1) * filters.perPage;
  return {
    data: matches.slice(start, start + filters.perPage),
    page: filters.page,
    perPage: filters.perPage,
    total: matches.length,
    product_id: productId,
    catalog: {
      id: fixture.id,
      managed_by: fixture.managed_by,
      last_ingested_at: fixture.last_ingested_at,
      listings: fixture.listings.length,
      unmatched: fixture.listings.filter((l) => l.mappings.length === 0).length,
      publishable: fixture.listings.flatMap((l) => l.mappings).filter((m) => m.publishable).length,
    },
  };
}

/** Build the error body the API Worker actually returns, so the preview
 *  exercises the same `readVendorApiError` branch the live surface does. */
/** The same direction seen from the other endpoint. */
function mirrorDirection(direction: ContextDirection): ContextDirection {
  if (direction === 'both') return 'both';
  return direction === 'outbound' ? 'inbound' : 'outbound';
}

/** The other company on the preview's seeded threads (AECI-1539). */
const PREVIEW_PROCORE = {
  id: '00000000-0000-4000-8000-0000000052f1',
  name: 'Procore Technologies',
};

/**
 * The preview's one seeded thread (AECI-1539), on the Procore disagreement over
 * Drawings: a message from each side, one deleted, one from a former member.
 */
const PREVIEW_THREAD: VendorThread = {
  id: '00000000-0000-4000-8000-0000000a9001',
  claim_id: '00000000-0000-4000-8000-000000005324',
  vendor_a: { id: VENDOR_ME_FIXTURE.vendor.id, name: VENDOR_ME_FIXTURE.vendor.company_name },
  vendor_b: PREVIEW_PROCORE,
  closed_at: null,
  closed_reason: null,
  help_requested_at: null,
  created_at: '2026-09-13T09:00:00.000Z',
  messages: [
    {
      id: '00000000-0000-4000-8000-0000000b9001',
      author_vendor: PREVIEW_PROCORE,
      author_removed: true,
      is_own: false,
      body: 'Our drawings sync is one way, from Summit into Procore. Which release adds the return path?',
      created_at: '2026-09-13T09:00:00.000Z',
      deleted_at: null,
    },
    {
      id: '00000000-0000-4000-8000-0000000b9002',
      author_vendor: {
        id: VENDOR_ME_FIXTURE.vendor.id,
        name: VENDOR_ME_FIXTURE.vendor.company_name,
      },
      author_removed: false,
      is_own: true,
      body: null,
      created_at: '2026-09-14T10:00:00.000Z',
      deleted_at: '2026-09-14T10:05:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-0000000b9003',
      author_vendor: {
        id: VENDOR_ME_FIXTURE.vendor.id,
        name: VENDOR_ME_FIXTURE.vendor.company_name,
      },
      author_removed: false,
      is_own: true,
      body: 'The 2026.1 release. Sheets marked for markup come back through the coordination workspace.',
      created_at: '2026-09-14T10:06:00.000Z',
      deleted_at: null,
    },
  ],
};

/**
 * A second seeded thread whose row was deleted (AECI-1551): detached, closed
 * `claim_removed`, named from its snapshot. It is only reachable by its id, from the
 * Conversations list, so the preview shows the read-only page too.
 */
const PREVIEW_DETACHED_THREAD: VendorThreadById = {
  id: '00000000-0000-4000-8000-0000000a9002',
  claim_id: null,
  data_object: { slug: 'rfis', name: 'RFIs' },
  can_write: false,
  acknowledged: false,
  vendor_a: { id: VENDOR_ME_FIXTURE.vendor.id, name: VENDOR_ME_FIXTURE.vendor.company_name },
  vendor_b: PREVIEW_PROCORE,
  closed_at: '2026-10-20T09:00:00.000Z',
  closed_reason: 'claim_removed',
  help_requested_at: null,
  created_at: '2026-10-01T09:00:00.000Z',
  messages: [
    {
      id: '00000000-0000-4000-8000-0000000b9101',
      author_vendor: PREVIEW_PROCORE,
      author_removed: false,
      is_own: false,
      body: 'Do your RFIs carry the due date across?',
      created_at: '2026-10-01T09:00:00.000Z',
      deleted_at: null,
    },
  ],
};

/** One Conversations row (AECI-1551) for a seeded thread, as the server builds it. */
function listItem(
  t: Omit<VendorThread, 'claim_id'> & { claim_id: string | null },
  own: string,
  dataObject: { slug: string; name: string } | null,
): VendorThreadListItem {
  const times = [
    t.created_at,
    t.messages.at(-1)?.created_at ?? '',
    t.help_requested_at ?? '',
    t.closed_at ?? '',
  ];
  return {
    id: t.id,
    claim_id: t.claim_id,
    counterparty: clone(t.vendor_a.id === own ? t.vendor_b : t.vendor_a),
    data_object: dataObject,
    message_count: t.messages.length,
    last_activity_at: times.reduce((a, b) => (b > a ? b : a)),
    closed_at: t.closed_at,
    closed_reason: t.closed_reason,
    help_requested_at: t.help_requested_at,
  };
}

/** The preview's Billing read: the fixture, with card payment switched on so the
 *  "Pay by card" panel renders (AECI-1502). */
/**
 * The preview's agreements, newest first: a card checkout of the Managed plan
 * agreement (with its Plans page, AECI-1619) and the claim's vendor terms.
 */
function previewAcceptances(): VendorAgreementAcceptance[] {
  return clone([VENDOR_CHECKOUT_ACCEPTANCE_FIXTURE, ...VENDOR_ACCEPTANCES_FIXTURE]);
}

function previewBilling(): VendorBillingResponse {
  const base = clone(VENDOR_BILLING_FIXTURE);
  const [assigned, pool, ended] = base.licenses;
  return {
    ...base,
    // AECI-1866: every status-chip tone shows. The pool subscription will not renew
    // ("Live" with a clock and its "Cancels at term end" badge), and a second ended row makes
    // the closed group read "Ended subscriptions (2)".
    licenses: [
      assigned!,
      { ...pool!, cancel_at_term_end: true },
      ended!,
      {
        ...ended!,
        id: '00000000-0000-4000-8000-0000000054a4',
        source: 'complimentary',
        starts_at: '2026-06-01',
        ends_at: '2027-05-31',
        ended_at: '2026-07-15T09:00:00.000Z',
        end_reason: 'released',
        reference: null,
      },
    ],
    stripe_checkout_available: true,
    // AECI-1615: one grant waiting, so the "Subscriptions waiting for you" card renders.
    pending_grants: [clone(VENDOR_PENDING_GRANT_FIXTURE)],
    // AECI-1812: `?billing=card` shows a company that already pays by card, so the
    // "Your Stripe plan" state and its "Add subscriptions" dialog can be seen and
    // axe-scanned. Read in the browser only: the Billing read never runs on the server.
    ...(previewCardPlan()
      ? {
          stripe: {
            interval: 'year' as const,
            quantity: 2,
            current_period_end: '2027-10-01T00:00:00.000Z',
            cancel_at_period_end: false,
            synced: true,
          },
          stripe_customer: true,
        }
      : {}),
  };
}

/** `?billing=card` on the preview URL (AECI-1812). */
function previewCardPlan(): boolean {
  const search = globalThis.location?.search ?? '';
  return new URLSearchParams(search).get('billing') === 'card';
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
 * AECI-1953: five rows on Summit Model Coordination and Bluebeam Revu, one of each
 * kind the create form's duplicate panel offers an action for. Pick Bluebeam Revu
 * as the other product to see the panel: a live row Summit owns but has not
 * claimed (Claim this one instead), one it has claimed (Open it), one it retired
 * (Open it to restore), one with no owner on file (Ask to be recorded), and one
 * AEC Integrations retired (Open it, since only AECi restores it).
 */
const OTHER_BLUEBEAM = {
  id: '00000000-0000-4000-8000-000000005305',
  slug: 'bluebeam-revu',
  name: 'Bluebeam Revu',
  logo_url: null,
};
function bluebeamRow(
  n: number,
  name: string,
  state: Pick<
    VendorIntegration,
    'is_owner' | 'owner' | 'claimed_at' | 'retired_at' | 'retired_by' | 'maintained_by'
  >,
): VendorIntegration {
  const id = `00000000-0000-4000-8000-0000000053e${n}`;
  return {
    ...INTEGRATION_OWNED_CLAIMED,
    id,
    name,
    mechanism_kind: 'api',
    mechanism_name: null,
    other_product: OTHER_BLUEBEAM,
    endpoint_vendors: state.owner ? [state.owner] : [],
    origin: 'aeci',
    created_at: `2026-0${n}-01T00:00:00.000Z`,
    claims: [],
    contestable_fields: {
      ...EMPTY_CONTESTABLE_FIELDS,
      name,
      mechanism_kind: 'api',
      direction: 'both',
      owner: state.owner?.id ?? null,
    },
    ...state,
  };
}
const SUMMIT = INTEGRATION_OWNED_CLAIMED.owner!;
const PREVIEW_BLUEBEAM_DUPLICATES: readonly VendorIntegration[] = [
  bluebeamRow(1, 'Summit Markups for Revu', {
    is_owner: true,
    owner: SUMMIT,
    claimed_at: null,
    retired_at: null,
    retired_by: null,
    maintained_by: 'aeci',
  }),
  bluebeamRow(2, 'Summit Issues in Revu', {
    is_owner: true,
    owner: SUMMIT,
    claimed_at: '2026-09-05T00:00:00.000Z',
    retired_at: null,
    retired_by: null,
    maintained_by: 'vendor',
  }),
  bluebeamRow(3, 'Summit Revu Bridge (legacy)', {
    is_owner: true,
    owner: SUMMIT,
    claimed_at: '2026-08-01T00:00:00.000Z',
    retired_at: '2026-09-10T00:00:00.000Z',
    retired_by: 'owner',
    maintained_by: 'vendor',
  }),
  bluebeamRow(4, 'Revu Studio Sync', {
    is_owner: false,
    owner: null,
    claimed_at: null,
    retired_at: null,
    retired_by: null,
    maintained_by: 'aeci',
  }),
  bluebeamRow(5, 'Summit Revu Export', {
    is_owner: true,
    owner: SUMMIT,
    claimed_at: '2026-08-15T00:00:00.000Z',
    retired_at: '2026-10-02T00:00:00.000Z',
    retired_by: 'aeci',
    maintained_by: 'vendor',
  }),
];

/**
 * The default list plus a row the other endpoint's owner has retired (AECI-1010), so
 * the preview shows all three retire states: Retire on the owned, claimed card,
 * Restore once retired, and the read-only retired card. Kept out of the shared
 * fixture because the drill-down specs count its groups.
 */
const PREVIEW_INTEGRATIONS: ListVendorIntegrationsResponse = {
  integrations: [
    // AECI-1149 to AECI-1153: the Procore row as the detail page reviews it (a dated
    // disagreement, a row each side added), in place of the list fixture's.
    ...VENDOR_INTEGRATIONS_FIXTURE.integrations.map((i) =>
      i.id === INTEGRATION_PROCORE_DETAIL.id &&
      i.context_product.id === INTEGRATION_PROCORE_DETAIL.context_product.id
        ? INTEGRATION_PROCORE_DETAIL
        : i,
    ),
    // A live row Summit owns and has claimed: pencils, a received request, Retire.
    INTEGRATION_OWNED_CLAIMED,
    INTEGRATION_RETIRED_BY_OTHER,
    INTEGRATION_RETIRED_BY_AECI,
    // AECI-1089: a connector-delivered row Summit owns, so the card's claim (or the
    // plan sentence, on the no-access presets) is reviewable.
    INTEGRATION_OWNED_VIA_CONNECTOR,
    // AECI-1090: a claimed connector-delivered row the caller owns.
    INTEGRATION_CONNECTOR_OWNED,
    // AECI-1953: one row of each duplicate-panel kind, for Bluebeam Revu.
    ...PREVIEW_BLUEBEAM_DUPLICATES,
  ],
  // AECI-1089: the owned evidenced pairs, for the "Integrations your company offers"
  // section on the primary product's tab.
  owned: [...VENDOR_OWNED_INTEGRATIONS_FIXTURE],
  // AECI-1153: recomputed from the list on every read (`getIntegrations`).
  counterpart_added_unanswered: 0,
};

/** AECI-2045: the `sync-service` preset's surface: the same list, plus the two pairs
 *  Summit Sync delivers that Summit owns. */
export const PREVIEW_SYNC_INTEGRATIONS: ListVendorIntegrationsResponse = {
  ...PREVIEW_INTEGRATIONS,
  // AECI-2045 QA: the hybrid Sync Service's own endpoint integration.
  integrations: [...PREVIEW_INTEGRATIONS.integrations, PREVIEW_HYBRID_ENDPOINT_INTEGRATION],
  owned: [
    ...VENDOR_OWNED_INTEGRATIONS_FIXTURE,
    ...VENDOR_SYNC_OWNED_FIXTURE,
    // AECI-2045 QA: a pair Trimble removed, and a pair the hybrid product delivers.
    ...PREVIEW_SYNC_EXTRA_OWNED,
  ],
};

/** The data object names the owner flow fakes use, by slug. */
function dataObjectName(slug: string): string | null {
  return VENDOR_DATA_OBJECTS_FIXTURE.find((d) => d.slug === slug)?.name ?? null;
}

/** A stored pair direction (§11e) as an owner flow's direction against `product_a`. */
function ownerDirectionOf(direction: PairFlowDirection): OwnerFlowDirection {
  return direction === 'a_to_b' ? 'outbound' : direction === 'b_to_a' ? 'inbound' : 'both';
}

/** The vetoes and the pair reports the `sync-service` preset starts from. */
function previewSyncRights(sync: boolean): {
  vetoes: VendorVetoesResponse;
  reports: VendorPairContestsResponse;
} {
  return sync
    ? {
        // AECI-2192: a removal with no objection, one with an open objection, and an
        // older one with free text and a declined objection, so every state renders.
        vetoes: {
          filed: [],
          received: [
            clone(PREVIEW_RECEIVED_VETO),
            clone(PREVIEW_RECEIVED_VETO_OBJECTED),
            clone(PREVIEW_RECEIVED_VETO_DECIDED),
          ],
        },
        reports: { submitted: [], received: [clone(PREVIEW_RECEIVED_FLOW_REPORT)] },
      }
    : { vetoes: { filed: [], received: [] }, reports: { submitted: [], received: [] } };
}

/** The contests the preview starts from: the shared fixture plus the owned,
 *  claimed row's received requests (AECI-1153). */
const PREVIEW_CONTESTS: ListVendorContestsResponse = {
  submitted: [...VENDOR_CONTESTS_FIXTURE.submitted],
  received: [
    CONTEST_RECEIVED_ON_OWNED,
    ...VENDOR_CONTESTS_FIXTURE.received,
    CONTEST_RECEIVED_CLOSED_ON_OWNED,
  ],
};

/**
 * An owner edit field's value on record in the fake. `pricing_url` (AECI-1154) is
 * its own field, not in the contest prefill map, exactly as on the wire.
 */
function editValueOf(
  row: { contestable_fields: ContestableFields; pricing_url: string | null },
  field: IntegrationEditField,
): string | null {
  return field === 'pricing_url' ? row.pricing_url : (row.contestable_fields[field] ?? null);
}

/** Write an owner edit field back into the fake's row. */
function setEditValue(
  row: { contestable_fields: ContestableFields; pricing_url: string | null },
  field: IntegrationEditField,
  value: string | null,
): void {
  if (field === 'pricing_url') row.pricing_url = value;
  else row.contestable_fields = { ...row.contestable_fields, [field]: value };
}

/** `counterpart_added_unanswered` as the server counts it (§7.6): distinct claim
 *  ids another company added and still says Yes to, unanswered, on attestable live
 *  rows (AECI-1315). */
function countCounterpartAdded(list: ListVendorIntegrationsResponse): number {
  const ids = new Set<string>();
  for (const entry of list.integrations) {
    if (!entry.attestable || entry.retired_at !== null) continue;
    for (const claim of entry.claims) {
      if (isAwaitingCounterpartAnswer(claim)) ids.add(claim.id);
    }
  }
  return ids.size;
}

/**
 * The public catalogue the preview's counterpart search answers from (AECI-1011).
 * Real-looking names, including the fixture's existing counterparts, so a search
 * for "pro" finds Procore and the "already on record" hint has something to show.
 */
const PREVIEW_CATALOGUE: readonly ProductListItem[] = [
  ['00000000-0000-4000-8000-000000005301', 'procore', 'Procore', 'Procore Technologies'],
  ['00000000-0000-4000-8000-000000005302', 'autodesk-build', 'Autodesk Build', 'Autodesk'],
  ['00000000-0000-4000-8000-000000005303', 'acumatica', 'Acumatica', 'Acumatica'],
  ['00000000-0000-4000-8000-000000005304', 'procurepro', 'ProcurePro', 'ProcurePro'],
  ['00000000-0000-4000-8000-000000005305', 'bluebeam-revu', 'Bluebeam Revu', 'Bluebeam'],
  ['00000000-0000-4000-8000-000000005306', 'sage-intacct', 'Sage Intacct', 'Sage'],
].map(([id, slug, name, vendor], index) => ({
  id: id!,
  slug: slug!,
  name: name!,
  logo_url: null,
  product_role: 'application' as const,
  connector_kind: null,
  vendor: {
    id: `00000000-0000-4000-8000-00000000560${index}`,
    slug: slug!,
    name: vendor!,
    logo_url: null,
    verified: false,
  },
  integration_count: 0,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}));

// Intentionally component-scoped, not `providedIn: 'root'`: this fake is provided
// only in the vendor-dashboard preview's `providers` (shadowing the real
// `VendorApi`), so it must never leak into the app-wide injector.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
export class PreviewVendorApi extends VendorApi {
  private me: VendorMeResponse | null = null;
  private seats: VendorSeat[] = clone([...VENDOR_SEATS_FIXTURE]);
  /** Invites revoked in this preview session (AECI-2129), so a revoke drops the row. */
  private revokedInvites = new Set<string>();
  private integrations: ListVendorIntegrationsResponse = clone(PREVIEW_INTEGRATIONS);
  private nextClaimSeq = 0;
  private contests: ListVendorContestsResponse = clone(PREVIEW_CONTESTS);
  private nextContestSeq = 0;
  private nextCreateSeq = 0;
  private nextProductSeq = 0;
  private productRequests: VendorProductRequest[] = clone([...VENDOR_PRODUCT_REQUESTS_FIXTURE]);
  private nextRequestSeq = 0;
  private checklistState: ChecklistFixtureState = NOTHING_CHECKED;

  // ── AECI-2045 QA: the Sync Service writes, against in-memory state ─────────
  private vetoes: VendorVetoesResponse = { filed: [], received: [] };
  private pairReports: VendorPairContestsResponse = { submitted: [], received: [] };
  private connectors: Record<string, VendorProductConnectorsResponse> = clone(
    VENDOR_PRODUCT_CONNECTORS_FIXTURE,
  );
  private nextSyncSeq = 0;

  /** Point the fake at the fixture the preview is currently showing, so writes
   *  merge onto the matching vendor/products. Clones so the shared fixture
   *  constants are never mutated across preview sessions. */
  private electedAt = new Map<string, string>();

  setFixture(
    me: VendorMeResponse,
    seats: readonly VendorSeat[],
    integrations: ListVendorIntegrationsResponse = PREVIEW_INTEGRATIONS,
    checklist: ChecklistFixtureState = NOTHING_CHECKED,
    sync = false,
  ): void {
    this.me = clone(me);
    const rights = previewSyncRights(sync);
    this.vetoes = rights.vetoes;
    this.pairReports = rights.reports;
    this.connectors = clone(sync ? previewSyncConnectors() : VENDOR_PRODUCT_CONNECTORS_FIXTURE);
    this.nextSyncSeq = 0;
    this.checklistState = clone(checklist);
    this.seats = clone([...seats]);
    this.revokedInvites = new Set();
    this.integrations = clone(integrations);
    this.nextClaimSeq = 0;
    this.contests = clone(PREVIEW_CONTESTS);
    this.nextContestSeq = 0;
    this.reviews = clone([...VENDOR_REVIEWS_FIXTURE]);
    this.billing = previewBilling();
    this.acceptances = previewAcceptances();
    this.proposals = clone([...VENDOR_PROPOSALS_FIXTURE]);
    this.electedAt = new Map();
  }

  // ── Proposed products (AECI-1417, E6b.5) ──────────────────────────────────
  private proposals: VendorProposal[] = clone([...VENDOR_PROPOSALS_FIXTURE]);

  override async listProposals(): Promise<ListVendorProposalsResponse> {
    return { proposals: clone(this.proposals), truncated: false };
  }

  /** Fixture-side: the handler's checks, then the product joins `/me` so the outcome
   *  link opens it, and the proposal leaves the list. */
  override async acceptProposal(proposalId: string): Promise<AcceptVendorProposalResponse> {
    const proposal = this.takeProposal(proposalId);
    if (proposal.vendors.some((v) => !v.exists)) {
      this.proposals.push(proposal);
      throw apiError(409, 'PROPOSAL_VENDOR_MISSING', 'A linked vendor no longer exists');
    }
    const slug = proposal.product.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const id = `preview-proposed-${proposal.id.slice(-4)}`;
    const template = this.me?.products[0];
    if (this.me && template) {
      this.me.products = [
        ...this.me.products,
        { ...clone(template), id, slug, name: proposal.product.name, is_primary: true },
      ];
    }
    return {
      proposal_id: proposal.id,
      product: { id, slug, name: proposal.product.name },
      dropped: proposal.terms
        .filter((t) => !t.exists)
        .map(({ facet, value }) => ({ facet, value })),
    };
  }

  /** AECI-1424, fixture-side: the handler's owner check, then the product joins
   *  `/me` so the result link opens it. A same-name product already on the vendor
   *  comes back as a possible duplicate, as the server's warning would. */
  override async createProduct(
    body: CreateVendorProductInput,
  ): Promise<CreateVendorProductResponse> {
    if (!this.me?.seat_owner) {
      throw apiError(403, 'FORBIDDEN', 'Only an owner seat may add a product');
    }
    const name = body.name.trim();
    const key = name.toLowerCase();
    const possible_duplicates: CreateVendorProductResponse['possible_duplicates'] = [
      ...this.me.products
        .filter((p) => p.name.trim().toLowerCase() === key)
        .map((p) => ({ kind: 'product' as const, id: p.id, name: p.name, slug: p.slug })),
      ...this.proposals
        .filter((p) => p.product.name.trim().toLowerCase() === key)
        .map((p) => ({ kind: 'proposal' as const, id: p.id, name: p.product.name })),
    ];
    const base = key.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'product';
    const taken = new Set(this.me.products.map((p) => p.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const id = `preview-created-${++this.nextProductSeq}`;
    const template = this.me.products[0];
    if (template) {
      this.me.products = [
        ...this.me.products,
        {
          ...clone(template),
          id,
          slug,
          name,
          description: body.description ?? null,
          website: body.website ?? null,
          logo_url: body.logo_url ?? null,
          tool_integrations_url: null,
          api_docs_url: null,
          usefulness: null,
          category_slugs: [...(body.category_slugs ?? [])],
          audience_slugs: [],
          phase_slugs: [],
          trade_slugs: [],
          integration_count: 0,
          review_count: 0,
          locked_fields: [],
          is_primary: false,
        },
      ];
    }
    return { product: { id, slug, name }, possible_duplicates };
  }

  override async declineProposal(proposalId: string): Promise<void> {
    this.takeProposal(proposalId);
  }

  private takeProposal(proposalId: string): VendorProposal {
    const index = this.proposals.findIndex((p) => p.id === proposalId);
    if (index < 0) throw apiError(404, 'NOT_FOUND', 'product_proposal not found');
    const [proposal] = this.proposals.splice(index, 1);
    return proposal!;
  }

  // ── Billing (AECI-1390, E5.4) ─────────────────────────────────────────────
  private billing: VendorBillingResponse = previewBilling();

  override async getBilling(): Promise<VendorBillingResponse> {
    // AECI-1865: the fake has no webhook gap, so the pool is its live rows on no product.
    return clone({ ...this.billing, pool_count: this.poolCount() });
  }

  private poolCount(): number {
    return this.billing.licenses.filter((l) => l.live && l.assigned_product === null).length;
  }

  private acceptances: VendorAgreementAcceptance[] = previewAcceptances();

  override async getAcceptances(): Promise<VendorAgreementAcceptancesResponse> {
    return { acceptances: clone(this.acceptances) };
  }

  /**
   * AECI-1615, fixture-side: the accept handler's checks, in its order, then the grant
   * leaves `pending_grants`, its licenses join the pool and a `grant` acceptance row
   * lands, so the whole tab reacts as it would live.
   */
  /** AECI-1677: the acceptance screen's state for the fixture on screen. */
  private legalState: VendorLegalAcceptanceResponse = LEGAL_NOTHING_PENDING_FIXTURE;

  setLegalFixture(state: VendorLegalAcceptanceResponse): void {
    this.legalState = clone(state);
  }

  override async getLegalAcceptance(): Promise<VendorLegalAcceptanceResponse> {
    return clone(this.legalState);
  }

  /** The accept succeeds and empties the pending list, as the real write does. */
  override async acceptLegalVersion(
    body: AcceptLegalVersionRequest,
  ): Promise<AcceptLegalVersionResponse> {
    this.legalState = clone(LEGAL_NOTHING_PENDING_FIXTURE);
    return {
      document: body.document,
      version: body.version,
      accepted_at: new Date().toISOString(),
      state: clone(this.legalState),
    };
  }

  override async acceptLicenseGrant(
    grantId: string,
    body: AcceptLicenseGrantInput,
  ): Promise<AcceptLicenseGrantResponse> {
    const grant = this.billing.pending_grants.find((g) => g.id === grantId);
    if (!grant) throw apiError(404, 'NOT_FOUND', 'Grant not found');
    if (body.version !== grant.terms_version) {
      throw apiError(409, 'LICENSE_GRANT_VERSION_CHANGED', 'Version changed', {
        details: { terms_version: grant.terms_version },
      });
    }
    if (body.signer_title.trim() === '') {
      throw apiError(400, 'VALIDATION_FAILED', 'Invalid signer title', { field: 'signer_title' });
    }
    const now = new Date().toISOString();
    const licenseIds: string[] = [];
    for (let i = 0; i < grant.quantity; i++) {
      const id = `00000000-0000-4000-8000-0000000056${String(this.billing.licenses.length).padStart(2, '0')}`;
      licenseIds.push(id);
      this.billing.licenses.unshift({
        id,
        source: grant.source === 'invoice' ? 'invoice' : 'complimentary',
        starts_at: now.slice(0, 10),
        ends_at: grant.ends_at.slice(0, 10),
        ended_at: null,
        end_reason: null,
        live: true,
        reference: grant.reference,
        assigned_product: null,
        assigned_at: null,
        release_at_renewal: false,
        cancel_at_term_end: false,
        open_release_request: null,
      });
    }
    this.billing.pending_grants = this.billing.pending_grants.filter((g) => g.id !== grantId);
    const acceptanceId = `00000000-0000-4000-8000-0000000057${String(this.acceptances.length).padStart(2, '0')}`;
    this.acceptances.unshift({
      ...clone(VENDOR_ACCEPTANCES_FIXTURE[0]!),
      id: acceptanceId,
      document: 'managed_plan',
      version: grant.terms_version,
      source: 'grant',
      accepted_at: now,
      signer_title: body.signer_title.trim(),
      method: 'portal_checkbox',
      license_grant_id: grant.id,
      grant_ends_at: grant.ends_at,
      seat_role: 'owner',
      // AECI-1619: a grant names no policies, and records the Plans page and its box.
      checkbox_label: AGREEMENT_CHECKBOX_LABELS.managed_plan.text,
      checkbox_label_sha256: AGREEMENT_CHECKBOX_LABELS.managed_plan.sha256,
      listing_accuracy_version: null,
      review_guidelines_version: null,
      plans_page_version: PLANS_PAGE_CURRENT_VERSION,
      plans_page_sha256: plansPageSha256(PLANS_PAGE_CURRENT_VERSION),
    });
    return {
      grant_id: grant.id,
      status: 'accepted',
      acceptance_id: acceptanceId,
      license_ids: licenseIds,
      warnings: [],
    };
  }

  /**
   * AECI-1502 (E9.4), fixture-side: no Stripe. Checkout "returns" straight to this
   * page with `?checkout=success`, so the banner and its wait can be reviewed (the
   * fake gains no licenses, so the wait runs to its timeout line). A second checkout
   * after an add would be refused, as the handler refuses it.
   */
  override async startCheckout(
    quantity: number,
    interval: StripeBillingInterval,
    signerTitle: string,
    unusedAcknowledged?: number,
  ): Promise<StripeRedirectResponse> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw apiError(400, 'VALIDATION_FAILED', 'Invalid quantity', { field: 'quantity' });
    }
    if (signerTitle.trim() === '') {
      throw apiError(400, 'VALIDATION_FAILED', 'Invalid signer title', { field: 'signer_title' });
    }
    const existing = this.billing.stripe;
    if (existing) {
      throw apiError(
        409,
        existing.interval === interval ? 'STRIPE_SUBSCRIPTION_EXISTS' : 'LICENSE_INTERVAL_MISMATCH',
        'Stripe plan exists',
        { details: { interval: existing.interval } },
      );
    }
    this.requireUnusedAcknowledged(quantity, unusedAcknowledged);
    const url = new URL(globalThis.location.href);
    url.searchParams.set('checkout', 'success');
    return { url: url.toString() };
  }

  /** AECI-1502, fixture-side: the add lands at once, as if the webhook were instant. */
  override async addStripeLicenses(
    quantity: number,
    unusedAcknowledged?: number,
  ): Promise<AddStripeLicensesResponse> {
    const sub = this.billing.stripe;
    if (!sub) throw apiError(409, 'STRIPE_SUBSCRIPTION_REQUIRED', 'No Stripe plan');
    this.requireUnusedAcknowledged(quantity, unusedAcknowledged);
    sub.quantity += quantity;
    for (let i = 0; i < quantity; i++) {
      this.billing.licenses.unshift({
        id: `00000000-0000-4000-8000-0000000055${String(this.billing.licenses.length).padStart(2, '0')}`,
        source: 'stripe',
        starts_at: new Date().toISOString().slice(0, 10),
        ends_at: sub.current_period_end?.slice(0, 10) ?? null,
        ended_at: null,
        end_reason: null,
        live: true,
        reference: null,
        assigned_product: null,
        assigned_at: null,
        release_at_renewal: false,
        cancel_at_term_end: false,
        open_release_request: null,
      });
    }
    return { ok: true, pending: true };
  }

  /** AECI-1865, as the handlers: a purchase that leaves subscriptions on no product
   *  needs `unused_acknowledged` equal to the count, or `409`. */
  private requireUnusedAcknowledged(quantity: number, acknowledged: number | undefined): void {
    const pool = this.poolCount();
    const productsWithoutSubscription = this.billing.assignable_products.length;
    const unused = unusedAfterPurchase({ quantity, pool, productsWithoutSubscription });
    if (unused > 0 && acknowledged !== unused) {
      throw apiError(409, 'UNUSED_SUBSCRIPTIONS_UNACKNOWLEDGED', 'Unused subscriptions', {
        details: { unused, pool, products_without_subscription: productsWithoutSubscription },
      });
    }
  }

  /** AECI-1502, fixture-side: the portal is Stripe's page, so the preview stays put.
   *  As the handler (AECI-1501): a lapsed customer still opens it, no customer is 409. */
  override async openBillingPortal(): Promise<StripeRedirectResponse> {
    if (!this.billing.stripe && !this.billing.stripe_customer)
      throw apiError(409, 'STRIPE_SUBSCRIPTION_REQUIRED', 'No Stripe plan');
    return { url: globalThis.location.href };
  }

  /** Fixture-side: the handler's schema (a `400` the preview can show), its
   *  lower-casing, then the stored value moves. */
  override async setBillingEmail(email: string | null): Promise<void> {
    if (!UpdateBillingEmailRequestSchema.safeParse({ billing_email: email }).success) {
      throw apiError(400, 'VALIDATION_FAILED', 'Enter a valid email address', {
        field: 'billing_email',
      });
    }
    if (this.billing.billing_account) {
      this.billing.billing_account.billing_email = email?.trim().toLowerCase() ?? null;
    }
  }

  /** Fixture-side (AECI-1625): the handler's schema, its normalising, then the stored
   *  value moves. */
  override async setLegalName(legalName: string | null): Promise<void> {
    const parsed = UpdateVendorLegalNameRequestSchema.safeParse({ legal_name: legalName });
    if (!parsed.success) {
      throw apiError(400, 'VALIDATION_FAILED', 'Invalid legal name', { field: 'legal_name' });
    }
    this.billing.legal_name = parsed.data.legal_name;
  }

  /**
   * AECI-1391 (E5.5), fixture-side: the E5.2 handler's checks, in its order, then the
   * license moves onto the product, the product leaves `assignable_products`, and its
   * `plan` on `/me` turns Managed, so the whole tab reacts as it would live.
   */
  override async assignLicense(
    licenseId: string,
    productId: string,
  ): Promise<VendorLicenseResponse> {
    const license = this.billing.licenses.find((l) => l.id === licenseId);
    if (!license) throw apiError(404, 'NOT_FOUND', 'License not found');
    if (!license.live) throw apiError(409, 'LICENSE_NOT_LIVE', 'License has ended');
    if (license.assigned_product) {
      throw apiError(409, 'LICENSE_ALREADY_ASSIGNED', 'License is already on a product');
    }
    const product = this.billing.assignable_products.find((p) => p.id === productId);
    if (!product) throw apiError(409, 'PRODUCT_ALREADY_LICENSED', 'Product already licensed');
    license.assigned_product = { ...product };
    license.assigned_at = new Date().toISOString();
    this.billing.assignable_products = this.billing.assignable_products.filter(
      (p) => p.id !== productId,
    );
    if (this.me) {
      this.me.products = this.me.products.map((p) =>
        p.id === productId
          ? {
              ...p,
              plan: {
                ...p.plan,
                tier: 'verified',
                status: 'active',
                period_end: license.ends_at
                  ? `${license.ends_at.slice(0, 10)}T00:00:00.000Z`
                  : null,
                ended_at: null,
                capabilities: [...capabilitiesFor('verified')],
              },
            }
          : p,
      );
    }
    return { license: clone(license) };
  }

  /** AECI-1391, fixture-side: the flag on a live, assigned license. */
  override async setReleaseAtRenewal(
    licenseId: string,
    release: boolean,
  ): Promise<VendorLicenseResponse> {
    const license = this.billing.licenses.find((l) => l.id === licenseId);
    if (!license) throw apiError(404, 'NOT_FOUND', 'License not found');
    if (!license.live || !license.assigned_product) {
      throw apiError(409, 'LICENSE_NOT_ASSIGNED', 'License is not on a product');
    }
    license.release_at_renewal = release;
    return { license: clone(license) };
  }

  /** AECI-1391, fixture-side: an open request on the license, as the real POST files. */
  override async requestLicenseRelease(
    licenseId: string,
    reason: string,
  ): Promise<CreateLicenseReleaseRequestResponse> {
    const license = this.billing.licenses.find((l) => l.id === licenseId);
    if (!license) throw apiError(404, 'NOT_FOUND', 'License not found');
    if (!license.live || !license.assigned_product) {
      throw apiError(409, 'LICENSE_NOT_ASSIGNED', 'License is not on a product');
    }
    if (license.open_release_request) {
      throw apiError(409, 'RELEASE_REQUEST_OPEN', 'A request is already open', {
        details: { request_id: license.open_release_request.id },
      });
    }
    const created_at = new Date().toISOString();
    const id = '00000000-0000-4000-8000-0000000054c1';
    license.open_release_request = { id, created_at };
    return {
      request: {
        id,
        license_id: licenseId,
        product_id: license.assigned_product.id,
        status: 'open',
        reason: reason.trim(),
        created_at,
        decided_at: null,
        decision_note: null,
      },
    };
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
      pending_invites: clone(
        VENDOR_SEAT_INVITES_FIXTURE.filter((invite) => !this.revokedInvites.has(invite.id)),
      ),
      can_manage_seats: true,
      // AECI-1368: one claim routed to the owners, so "Wants to join" renders.
      pending_claims: clone([...VENDOR_PENDING_SEAT_CLAIMS_FIXTURE]),
    };
  }

  /** AECI-1368, fixture-side: an accept echoes the invite the real handler issues. */
  override async acceptSeatClaim(claimId: string): Promise<AcceptSeatClaimResponse> {
    const claim =
      VENDOR_PENDING_SEAT_CLAIMS_FIXTURE.find((c) => c.id === claimId) ??
      VENDOR_PENDING_SEAT_CLAIMS_FIXTURE[0]!;
    return {
      invite: {
        id: 'preview-claim-invite',
        email: claim.submitter_email,
        invited_by: 'Dana Ruiz',
        expires_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-08-26T00:00:00.000Z',
        last_sent_at: null,
        resend_state: 'cooling_down',
      },
      invite_sent: true,
    };
  }

  override async declineSeatClaim(): Promise<void> {}

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

  /** AECI-2129: the row leaves the list, as it does after the real 204, so the
   *  preview shows where focus lands once a remove or revoke succeeds. */
  override async revokeInvite(inviteId: string): Promise<void> {
    this.revokedInvites.add(inviteId);
  }

  override async removeSeat(userId: string): Promise<void> {
    this.seats = this.seats.filter((seat) => seat.user_id !== userId);
  }

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

  // ─── Checklist and "Looks right" (AECI-1218) ────────────────────────────────
  //
  // The fake scores the fixture with the same rules AECI-1217 serves
  // (`vendorChecklistFixture`), and each "Looks right" ticks the step it stamps,
  // so the preview shows a checklist moving when the vendor acts.

  override async getChecklist(): Promise<VendorChecklistResponse> {
    return vendorChecklistFixture(this.me!, this.checklistState);
  }

  override async getProductChecklist(productId: string): Promise<VendorProductChecklistResponse> {
    const product = this.me?.products.find((p) => p.id === productId);
    if (!product) throw apiError(404, 'NOT_FOUND', 'Product not found');
    const checklist = productChecklistFixture(product, this.checklistState);
    if (!isSyncService(product.product_role, product.connector_kind)) return checklist;
    // AECI-2045: on a Sync Service, "Confirm data flows" counts the flows its owner has
    // not answered, by the rule the server's step and the Integrations tab both use.
    const awaiting = (this.integrations.owned ?? [])
      .filter((row) => row.connector?.id === product.id)
      .reduce((n, row) => n + countOwnerFlowsAwaitingAnswer(row), 0);
    const steps = checklist.steps.map((step) =>
      step.key === 'confirm_data_flows' && step.counts
        ? { ...step, status: awaiting === 0 ? ('done' as const) : ('todo' as const) }
        : step,
    );
    const counted = steps.filter((step) => step.counts);
    const done = counted.filter((step) => step.status === 'done').length;
    return { ...checklist, steps, done, complete: done === counted.length };
  }

  // AECI-1618: the removal election. The window runs from the fixture's own `ended_at`, so
  // a preset reaches it by date, and a confirm blanks the fixture's fields as the API does.

  private electionWindow(productId: string): { closesAt: string | null; elected: string | null } {
    const product = this.me?.products.find((p) => p.id === productId);
    if (!product) throw apiError(404, 'NOT_FOUND', 'Product not found');
    const ended = product.plan.ended_at ? Date.parse(product.plan.ended_at) : NaN;
    const elected = this.electedAt.get(productId) ?? null;
    if (Number.isNaN(ended)) return { closesAt: null, elected };
    const closes = new Date(ended + 30 * 86_400_000);
    closes.setUTCHours(23, 59, 59, 999);
    return { closesAt: closes.getTime() >= Date.now() ? closes.toISOString() : null, elected };
  }

  override async getRemovalElection(productId: string): Promise<RemovalElectionResponse> {
    const { closesAt, elected } = this.electionWindow(productId);
    const product = this.me!.products.find((p) => p.id === productId)!;
    const eligible = closesAt
      ? REMOVAL_ELECTION_FIELDS.filter((field) => product[field] !== null && product[field] !== '')
      : [];
    return { eligible_fields: eligible, closes_at: closesAt, elected_at: elected };
  }

  override async createRemovalElection(productId: string): Promise<CreateRemovalElectionResponse> {
    const { eligible_fields, closes_at } = await this.getRemovalElection(productId);
    if (!closes_at) throw apiError(409, 'REMOVAL_ELECTION_CLOSED', 'The window is closed');
    if (eligible_fields.length === 0) {
      throw apiError(409, 'REMOVAL_ELECTION_EMPTY', 'Nothing qualifies');
    }
    const elected_at = new Date().toISOString();
    this.electedAt.set(productId, elected_at);
    this.me = {
      ...this.me!,
      products: this.me!.products.map((p) =>
        p.id === productId
          ? {
              ...p,
              description: null,
              usefulness: null,
              tool_integrations_url: null,
              api_docs_url: null,
            }
          : p,
      ),
    };
    return { removed_fields: eligible_fields, elected_at };
  }

  override async reviewProfile(): Promise<ReviewVendorProfileResponse> {
    this.checklistState = { ...this.checklistState, company: true };
    return { last_reviewed_at: new Date().toISOString() };
  }

  override async reviewProduct(productId: string): Promise<ReviewVendorProductResponse> {
    this.tickProductStep(productId, 'details');
    return { product_id: productId, last_reviewed_at: new Date().toISOString() };
  }

  override async reviewProductIntegrations(
    productId: string,
  ): Promise<ReviewVendorProductIntegrationsResponse> {
    this.tickProductStep(productId, 'list');
    return {
      product_id: productId,
      integrations_reviewed_at: new Date().toISOString(),
      stamped_count: 0,
    };
  }

  private tickProductStep(productId: string, step: keyof ProductChecklistFixtureState): void {
    if (!this.me?.products.some((p) => p.id === productId))
      throw apiError(404, 'NOT_FOUND', 'Product not found');
    const current = this.checklistState.products[productId] ?? {
      details: false,
      list: false,
      claims: false,
      flows: false,
    };
    this.checklistState = {
      ...this.checklistState,
      products: { ...this.checklistState.products, [productId]: { ...current, [step]: true } },
    };
  }

  override async getTaxonomy(): Promise<TaxonomyResponse> {
    return clone(VENDOR_TAXONOMY_FIXTURE);
  }

  // ─── Attestations (AECI-606) ───────────────────────────────────────────────

  override async getIntegrations(): Promise<ListVendorIntegrationsResponse> {
    return clone({
      ...this.integrations,
      counterpart_added_unanswered: countCounterpartAdded(this.integrations),
    });
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
    return clone(this.connectors[productId] ?? { product_id: productId, connectors: [] });
  }

  /** AECI-2045: the pairs Summit Sync delivers under another owner. A row with an open
   *  `owner` request from the caller carries its id, as the server's read does. */
  override async listDeliveredPairs(productId: string): Promise<ListVendorDeliveredPairsResponse> {
    if (productId !== SYNC_SERVICE_PRODUCT.id) return { pairs: [] };
    return clone({
      pairs: VENDOR_DELIVERED_PAIRS_FIXTURE.pairs.map((pair) => ({
        ...pair,
        open_request_id:
          this.contests.submitted.find(
            (c) => c.integration_id === pair.id && c.field === 'owner' && c.status === 'open',
          )?.id ?? null,
      })),
    });
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
      owner_answer: null,
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
      // AECI-1153: the caller added it, so it reads `you`, and nothing disagrees yet.
      added_by: 'you',
      can_delete: true,
      created_at: now,
      disagreement: null,
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
    // AECI-1151: a No needs a reason, as the handler refuses it.
    const noteProblem = attestationNoteProblem(position.asserted, position.note);
    if (noteProblem) {
      throw apiError(400, 'ATTESTATION_NOTE_REQUIRED', noteProblem, { field: 'note' });
    }

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
    const wasConflict = claim.agreement === 'conflict';
    claim.agreement = recomputeAgreement(claim);
    // AECI-1153: a new run of `conflict` starts now; an unbroken one keeps its date.
    claim.disagreement =
      claim.agreement === 'conflict'
        ? wasConflict && claim.disagreement
          ? claim.disagreement
          : { id: claim.id, raised_at: now }
        : null;
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

  override async deleteClaim(claimId: string): Promise<void> {
    const found = this.findClaim(claimId);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Claim not found');
    if (found.claim.added_by !== 'you') {
      throw apiError(403, 'FORBIDDEN', 'Only the company that added this row can delete it.');
    }
    // The fixture has no `aeci` row to read, so the flag stands in for that half.
    if (found.claim.counterparty || !found.claim.can_delete) {
      throw apiError(409, 'CLAIM_NOT_DELETABLE', 'Another company has answered this row.');
    }
    for (const integration of this.integrations.integrations) {
      integration.claims = integration.claims.filter((c) => c.id !== claimId);
    }
  }

  override async getNotifications(): Promise<ListVendorNotificationsResponse> {
    // Newest first, as the ledger read orders them.
    const rows = [
      ...VENDOR_OVERRIDE_NOTIFICATIONS_FIXTURE,
      ...VENDOR_PRODUCT_REQUEST_NOTIFICATIONS_FIXTURE,
      ...VENDOR_CONTEST_NOTIFICATIONS_FIXTURE,
      ...VENDOR_NOTIFICATIONS_FIXTURE,
    ].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { notifications: clone(rows) };
  }

  // ─── Nudge mute (AECI-1204) ────────────────────────────────────────────────

  private nudgePrefs: NotificationPreferencesResponse = {
    nudges_muted: false,
    nudges_muted_at: null,
  };

  override async getNotificationPreferences(): Promise<NotificationPreferencesResponse> {
    return clone(this.nudgePrefs);
  }

  override async updateNotificationPreferences(
    nudgesMuted: boolean,
  ): Promise<NotificationPreferencesResponse> {
    if (nudgesMuted !== this.nudgePrefs.nudges_muted) {
      this.nudgePrefs = {
        nudges_muted: nudgesMuted,
        nudges_muted_at: nudgesMuted ? new Date().toISOString() : null,
      };
    }
    return clone(this.nudgePrefs);
  }

  // ─── Private row threads (AECI-1539) ────────────────────────────────────────

  /** One seeded thread, on the Procore disagreement, so the preview shows the
   *  list, a deleted message and a former member. Keyed on the claim id. */
  private threads = new Map<string, VendorThread>([
    [PREVIEW_THREAD.claim_id, clone(PREVIEW_THREAD)],
  ]);
  private nextThreadSeq = 0;
  /**
   * First-use acknowledgments (AECI-1616), keyed `integrationId:otherVendorId`. The
   * seeded thread's integration starts acknowledged, because the preview vendor has
   * already written there. Every other row shows the acknowledgment first.
   */
  private acks = new Set<string>();
  private ackKey(claimId: string | null, otherId: string): string {
    const integration = claimId === null ? undefined : this.integrationOfClaim(claimId);
    return `${integration?.id ?? ''}:${otherId}`;
  }
  private isAcknowledged(claimId: string | null, other: ThreadCompany | null): boolean {
    if (claimId === null || other === null) return false;
    if (claimId === PREVIEW_THREAD.claim_id) return true;
    return this.acks.has(this.ackKey(claimId, other.id));
  }

  /**
   * Who a first post on this integration's rows would go to (AECI-1551): the first
   * endpoint company that is not the caller's, as the server's `threadParties`
   * picks it. `null` on a row no two companies can attest (§15.2).
   */
  private firstPostTo(integration: VendorIntegration | undefined): ThreadCompany | null {
    if (!integration?.attestable) return null;
    const own = this.me?.vendor.id ?? VENDOR_ME_FIXTURE.vendor.id;
    const other = integration.endpoint_vendors.find((v) => v.id !== own);
    return other ? { id: other.id, name: other.name } : null;
  }

  /** The integration a claim sits on, from the preview's list. */
  private integrationOfClaim(claimId: string): VendorIntegration | undefined {
    return this.integrations.integrations.find((i) => i.claims.some((c) => c.id === claimId));
  }

  /** AECI-1546: the page's one summary read, from the same seeded threads. */
  override async getIntegrationThreads(
    integrationId: string,
  ): Promise<GetVendorIntegrationThreadsResponse> {
    const integration = this.integrations.integrations.find((i) => i.id === integrationId);
    const claimIds = new Set(integration?.claims.map((c) => c.id) ?? []);
    const vendorId = this.me?.vendor.id ?? VENDOR_ME_FIXTURE.vendor.id;
    const threads = [...this.threads.values()]
      .filter((t) => claimIds.has(t.claim_id))
      .sort((a, b) => (a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0))
      .map((t) => ({
        id: t.id,
        claim_id: t.claim_id,
        counterparty: clone(t.vendor_a.id === vendorId ? t.vendor_b : t.vendor_a),
        message_count: t.messages.length,
        latest_message_at: t.messages.at(-1)?.created_at ?? null,
        closed_at: t.closed_at,
        closed_reason: t.closed_reason,
        help_requested_at: t.help_requested_at,
      }));
    return { counterparty: clone(this.firstPostTo(integration)), threads };
  }

  override async getThread(claimId: string): Promise<GetVendorThreadResponse> {
    const thread = this.threads.get(claimId);
    if (!thread) {
      const counterparty = this.firstPostTo(this.integrationOfClaim(claimId));
      return {
        thread: null,
        counterparty: clone(counterparty),
        acknowledged: this.isAcknowledged(claimId, counterparty),
      };
    }
    const vendorId = this.me?.vendor.id ?? VENDOR_ME_FIXTURE.vendor.id;
    const counterparty = thread.vendor_a.id === vendorId ? thread.vendor_b : thread.vendor_a;
    return {
      thread: clone(thread),
      counterparty: clone(counterparty),
      acknowledged: this.isAcknowledged(claimId, counterparty),
    };
  }

  /**
   * AECI-1548, AECI-1551: one thread by id, for its permanent page. A thread on a
   * live row reads as it stands, named from its claim, and writable while it is
   * open on a live, attestable integration, as the server's `can_write` decides.
   * The detached seed reads closed and read-only. An unknown id is the `404`.
   */
  override async getThreadById(threadId: string): Promise<GetVendorThreadByIdResponse> {
    if (threadId === PREVIEW_DETACHED_THREAD.id) return { thread: clone(PREVIEW_DETACHED_THREAD) };
    const thread = [...this.threads.values()].find((t) => t.id === threadId);
    if (!thread) throw apiError(404, 'NOT_FOUND', `claim_thread not found: ${threadId}`);
    const integration = this.integrationOfClaim(thread.claim_id);
    const claim = integration?.claims.find((c) => c.id === thread.claim_id);
    const own = this.me?.vendor.id ?? VENDOR_ME_FIXTURE.vendor.id;
    const other = thread.vendor_a.id === own ? thread.vendor_b : thread.vendor_a;
    return {
      thread: {
        ...clone(thread),
        data_object: claim ? { slug: claim.data_object_slug, name: claim.data_object_name } : null,
        can_write:
          thread.closed_at === null &&
          !!integration &&
          !integration.retired_at &&
          this.firstPostTo(integration) !== null,
        acknowledged: this.isAcknowledged(thread.claim_id, other),
      },
    };
  }

  /** AECI-1551: the Conversations list, from the seeded threads, newest activity first. */
  override async listThreads(
    page: number,
    perPage: number,
    status: VendorThreadListStatus = 'all',
  ): Promise<ListVendorThreadsResponse> {
    const own = this.me?.vendor.id ?? VENDOR_ME_FIXTURE.vendor.id;
    const all: VendorThreadListItem[] = [
      ...[...this.threads.values()].map((t) => {
        const claim = this.integrationOfClaim(t.claim_id)?.claims.find((c) => c.id === t.claim_id);
        return listItem(
          t,
          own,
          claim ? { slug: claim.data_object_slug, name: claim.data_object_name } : null,
        );
      }),
      listItem(PREVIEW_DETACHED_THREAD, own, PREVIEW_DETACHED_THREAD.data_object),
    ]
      .filter((t) => status === 'all' || (status === 'open') === (t.closed_at === null))
      .sort((a, b) =>
        a.last_activity_at !== b.last_activity_at
          ? a.last_activity_at < b.last_activity_at
            ? 1
            : -1
          : a.id < b.id
            ? -1
            : 1,
      );
    return {
      data: all.slice((page - 1) * perPage, page * perPage),
      page,
      perPage,
      total: all.length,
    };
  }

  override async postThreadMessage(
    claimId: string,
    body: string,
    acknowledgmentVersion?: typeof THREAD_ACK_TEXT_VERSION,
  ): Promise<VendorThreadResult> {
    const vendor = this.me?.vendor ?? VENDOR_ME_FIXTURE.vendor;
    const now = new Date().toISOString();
    const existing = this.threads.get(claimId);
    // The row's real other company, as the server stamps it (AECI-1551).
    const other = this.firstPostTo(this.integrationOfClaim(claimId));
    if (!existing && !other) {
      throw apiError(409, 'THREAD_NOT_ATTESTABLE', 'This data row has no private thread.');
    }
    const recipient = existing
      ? existing.vendor_a.id === vendor.id
        ? existing.vendor_b
        : existing.vendor_a
      : other!;
    if (!this.isAcknowledged(claimId, recipient)) {
      if (acknowledgmentVersion === undefined) {
        throw apiError(409, 'THREAD_ACK_REQUIRED', 'Acknowledge the private-thread rules first.');
      }
      this.acks.add(this.ackKey(claimId, recipient.id));
    }
    const thread: VendorThread = existing ?? {
      id: `00000000-0000-4000-8000-0000000a${String(this.nextThreadSeq++).padStart(4, '0')}`,
      claim_id: claimId,
      vendor_a: { id: vendor.id, name: vendor.company_name },
      vendor_b: other!,
      closed_at: null,
      closed_reason: null,
      help_requested_at: null,
      created_at: now,
      messages: [],
    };
    thread.messages.push({
      id: `00000000-0000-4000-8000-0000000b${String(this.nextThreadSeq++).padStart(4, '0')}`,
      author_vendor: { id: vendor.id, name: vendor.company_name },
      author_removed: false,
      is_own: true,
      body: body.trim(),
      created_at: now,
      deleted_at: null,
    });
    this.threads.set(claimId, thread);
    return { thread: clone(thread) };
  }

  override async deleteThreadMessage(
    claimId: string,
    messageId: string,
  ): Promise<VendorThreadResult> {
    const thread = this.threads.get(claimId);
    if (!thread) throw apiError(404, 'NOT_FOUND', 'No thread on this row.');
    const message = thread.messages.find((m) => m.id === messageId);
    if (message && !message.deleted_at) {
      message.deleted_at = new Date().toISOString();
      message.body = null;
    }
    return { thread: clone(thread) };
  }

  override async requestThreadHelp(claimId: string): Promise<VendorThreadResult> {
    const thread = this.threads.get(claimId);
    if (!thread) throw apiError(404, 'NOT_FOUND', 'No thread on this row.');
    thread.help_requested_at ??= new Date().toISOString();
    return { thread: clone(thread) };
  }

  // ─── Field contests (AECI-1008) ────────────────────────────────────────────

  override async getContests(integrationId?: string): Promise<ListVendorContestsResponse> {
    if (!integrationId) return clone(this.contests);
    // AECI-1153: narrow both lists to one anchor row; a foreign id reads empty.
    return clone({
      submitted: this.contests.submitted.filter((c) => c.integration_id === integrationId),
      received: this.contests.received.filter((c) => c.integration_id === integrationId),
    });
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
    anchor: ContestAnchorKind = 'integration',
  ): Promise<VendorContestResponse> {
    // AECI-1225: the vendor named as owner says a row is not its own.
    const notOurs = this.notOurs(integrationId, body, anchor);
    if (notOurs) return notOurs;
    // AECI-2045: the connector product's vendor asks to be recorded as the owner.
    const delivered = this.askForDeliveredPair(integrationId, body);
    if (delivered) return delivered;
    // AECI-1092: an evidenced pair is looked up among the connectors fixture's
    // contest targets, which carry the same fields an integration entry does.
    const pairTargets = Object.values(VENDOR_PRODUCT_CONNECTORS_FIXTURE).flatMap((r) =>
      r.connectors.flatMap((g) => g.delivered_contest_targets ?? []),
    );
    const integration =
      anchor === 'evidenced_pair'
        ? pairTargets.find((p) => p.id === integrationId)
        : this.integrations.integrations.find(
            (i) =>
              i.id === integrationId &&
              (!body.context_product_id || i.context_product.id === body.context_product_id),
          );
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (integration.is_owner) {
      throw apiError(403, 'CONTEST_OWN_INTEGRATION', 'You own this integration');
    }
    // AECI-1155: website and connection link are no longer offered.
    if (!(contestFieldsFor(anchor) as readonly string[]).includes(body.field)) {
      throw apiError(400, 'VALIDATION_FAILED', `${body.field} cannot be contested`, {
        field: 'field',
      });
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
        (c) =>
          c.integration_id === integrationId &&
          c.anchor === anchor &&
          c.field === body.field &&
          c.status === 'open',
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
      anchor,
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
      protest: null,
      protest_opens_at: null,
      protest_closes_at: null,
      protest_basis: null,
      cooldown_until: null,
    };
    this.contests.submitted.unshift(contest);
    return { contest: clone(contest) };
  }

  /** AECI-2045 (§11b.2): an `owner` contest naming the caller on a pair its Sync Service
   *  delivers. Any other field is `403 CONTEST_CONNECTOR_OWNER_ONLY`, as on the server. */
  private askForDeliveredPair(
    integrationId: string,
    body: SubmitIntegrationContestInput,
  ): VendorContestResponse | null {
    const pair = VENDOR_DELIVERED_PAIRS_FIXTURE.pairs.find((p) => p.id === integrationId);
    const self = this.me?.vendor;
    if (!pair || !self) return null;
    if (body.field !== 'owner' || body.proposed_value !== self.id) {
      throw apiError(403, 'CONTEST_CONNECTOR_OWNER_ONLY', 'Only an owner request naming you');
    }
    const standing = this.contests.submitted.some(
      (c) => c.integration_id === integrationId && c.field === 'owner' && c.status === 'open',
    );
    if (standing) {
      throw apiError(409, 'CONTEST_DUPLICATE', 'You already have an open contest on this field');
    }
    const now = '2026-11-24T12:00:00.000Z';
    const contest: VendorContest = {
      id: `00000000-0000-4000-8000-${String(0xc100 + ++this.nextContestSeq).padStart(12, '0')}`,
      integration_id: integrationId,
      anchor: pair.anchor,
      integration_name: pair.name,
      context_product: pair.product_a,
      other_product: pair.product_b,
      field: 'owner',
      current_value: pair.owner?.id ?? null,
      proposed_value: self.id,
      current_label: pair.owner?.name ?? null,
      proposed_label: self.company_name,
      reason: body.reason,
      routed_to: 'aeci',
      status: 'open',
      submitter_vendor: { id: self.id, name: self.company_name },
      owner_vendor: pair.owner,
      decision_note: null,
      decided_at: null,
      created_at: now,
      updated_at: now,
      protest: null,
      protest_opens_at: null,
      protest_closes_at: null,
      protest_basis: null,
      cooldown_until: null,
    };
    this.contests.submitted.unshift(contest);
    return { contest: clone(contest) };
  }

  /**
   * AECI-1225: the vendor named as owner files an `owner` contest on its own row. The
   * server allows it only on a seeded, unclaimed row, and only for `owner`. It routes
   * to AECi, and the fake ticks the claim step of each product the row touches, as the
   * server's checklist stops counting the row. `null` when the caller is not the owner.
   */
  private notOurs(
    integrationId: string,
    body: SubmitIntegrationContestInput,
    anchor: ContestAnchorKind,
  ): VendorContestResponse | null {
    const self = this.me?.vendor;
    const owned = (this.integrations.owned ?? []).find(
      (row) => row.id === integrationId && row.anchor === anchor,
    );
    const endpoint = this.integrations.integrations.find(
      (i) => i.id === integrationId && i.is_owner && anchor === 'integration',
    );
    if (!self || (!owned && !endpoint)) return null;
    const claimedAt = owned ? owned.claimed_at : (endpoint?.claimed_at ?? null);
    if (body.field !== 'owner' || claimedAt !== null) {
      throw apiError(403, 'CONTEST_OWN_INTEGRATION', 'You own this integration');
    }
    if (body.proposed_value === self.id) {
      throw apiError(422, 'CONTEST_NO_CHANGE', 'Same as the current value', {
        field: 'proposed_value',
      });
    }
    const standing = this.contests.submitted.some(
      (c) =>
        c.integration_id === integrationId &&
        c.anchor === anchor &&
        c.field === 'owner' &&
        c.status === 'open',
    );
    if (standing) {
      throw apiError(409, 'CONTEST_DUPLICATE', 'You already have an open contest on this field');
    }
    const productA = owned ? owned.product_a : endpoint!.context_product;
    const productB = owned ? owned.product_b : endpoint!.other_product;
    const now = '2026-10-05T12:00:00.000Z';
    const me = { id: self.id, name: self.company_name };
    const proposedName =
      endpoint?.endpoint_vendors.find((v) => v.id === body.proposed_value)?.name ?? null;
    const contest: VendorContest = {
      id: `00000000-0000-4000-8000-${String(0xc100 + ++this.nextContestSeq).padStart(12, '0')}`,
      integration_id: integrationId,
      anchor,
      integration_name: owned ? owned.name : (endpoint?.name ?? null),
      context_product: productA,
      other_product: productB,
      field: 'owner',
      current_value: self.id,
      proposed_value: body.proposed_value,
      current_label: me.name,
      proposed_label: proposedName,
      reason: body.reason,
      routed_to: 'aeci',
      status: 'open',
      submitter_vendor: me,
      owner_vendor: me,
      decision_note: null,
      decided_at: null,
      created_at: now,
      updated_at: now,
      protest: null,
      protest_opens_at: null,
      protest_closes_at: null,
      protest_basis: null,
      cooldown_until: null,
    };
    this.contests.submitted.unshift(contest);
    const touched = [productA.id, productB.id, owned?.connector?.id];
    for (const product of this.me?.products ?? []) {
      if (touched.includes(product.id)) this.tickProductStep(product.id, 'claims');
    }
    return { contest: clone(contest) };
  }

  // ─── Integration ownership (AECI-1005 claim / AECI-1006 edit) ───────────────

  /** The claim, fixture-side: the same refusal order as the handler, then every
   *  entry for the integration (both frames when the caller owns both sides)
   *  reads as claimed. */
  override async claimIntegration(integrationId: string): Promise<ClaimIntegrationResponse> {
    const now = '2026-09-22T12:00:00.000Z';
    // A connector-delivered row claims on the same terms as any other: the seat is
    // the whole gate (ruling 14, AECI-1663).

    // The owned rows outside the attestable list (evidenced pairs and the like).
    const owned = (this.integrations.owned ?? []).find((row) => row.id === integrationId);
    if (owned) {
      if (owned.claimed_at) throw apiError(409, 'INTEGRATION_ALREADY_CLAIMED', 'Already claimed');
      owned.claimed_at = now;
      return {
        integration: {
          id: integrationId,
          owner_vendor_id: this.me?.vendor.id ?? '',
          claimed_at: now,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
      };
    }

    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const integration = entries[0];
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!integration.is_owner) {
      throw integration.owner
        ? apiError(403, 'INTEGRATION_NOT_OWNER', 'Another company owns this integration')
        : apiError(409, 'INTEGRATION_OWNER_UNKNOWN', 'No owner is on file');
    }
    if (integration.claimed_at) {
      throw apiError(409, 'INTEGRATION_ALREADY_CLAIMED', 'Already claimed');
    }
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
    // AECI-1090: an owned row outside the attestable list (an evidenced pair). Its
    // values are framed against product_a, as the form sends them, and a pair has no
    // type, so a type in the body is refused as the handler refuses it.
    const owned = (this.integrations.owned ?? []).find((row) => row.id === integrationId);
    if (owned) {
      if (!owned.claimed_at) throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Claim it first');
      const changed: (typeof INTEGRATION_EDIT_FIELDS)[number][] = [];
      for (const field of INTEGRATION_EDIT_FIELDS) {
        const raw = body[field];
        if (raw === undefined) continue;
        const value = raw === null || raw.trim() === '' ? null : raw.trim();
        if (field === 'mechanism_kind' && owned.anchor === 'evidenced_pair') {
          throw apiError(422, 'INTEGRATION_INVALID_VALUE', 'No type on this row', { field });
        }
        const problem = integrationEditValueProblem(field, value);
        if (problem) throw apiError(422, 'INTEGRATION_INVALID_VALUE', problem, { field });
        if (value === editValueOf(owned, field)) continue;
        changed.push(field);
        setEditValue(owned, field, value);
        if (field === 'name') owned.name = value;
        if (field === 'mechanism_name') owned.mechanism_name = value;
      }
      const at = '2026-09-23T12:00:00.000Z';
      return {
        integration: {
          id: integrationId,
          changed,
          maintained_by: 'vendor',
          last_reviewed_at: at,
          updated_at: at,
        },
      };
    }

    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const integration = entries[0];
    if (!integration) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!integration.is_owner) {
      throw apiError(403, 'INTEGRATION_NOT_OWNER', 'Another company owns this integration');
    }
    // AECI-1090: a connector-delivered row takes the edit from its owner on any
    // plan (ruling 14), with its type frozen, as the handler does.
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
      if (
        !integration.attestable &&
        CONNECTOR_POWERED_FROZEN_EDIT_FIELDS.has(field) &&
        value !== editValueOf(frame, field)
      ) {
        throw apiError(422, 'INTEGRATION_INVALID_VALUE', 'Frozen on this row', { field });
      }
      if (!integration.attestable && CONNECTOR_POWERED_FROZEN_EDIT_FIELDS.has(field)) continue;
      const problem = integrationEditValueProblem(field, value);
      if (problem) throw apiError(422, 'INTEGRATION_INVALID_VALUE', problem, { field });
      if (value === editValueOf(frame, field)) continue;
      changed.push(field);
      for (const entry of entries) {
        const sameFrame = entry.context_product.id === frame.context_product.id;
        // A both-sides row shows the mirrored direction on its other entry.
        const framed =
          field === 'direction' && value !== null && !sameFrame
            ? mirrorDirection(value as ContextDirection)
            : value;
        setEditValue(entry, field, framed);
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

  // ─── Protests to AECi (AECI-1009) ──────────────────────────────────────────

  /** File, fixture-side: the window the list already computed, then an open
   *  protest with a 14-day reply clock. */
  override async fileContestProtest(
    contestId: string,
    body: FileContestProtestInput,
  ): Promise<VendorContestResponse> {
    const contest = this.contests.submitted.find((c) => c.id === contestId);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Contest not found');
    const now = new Date();
    const opens = contest.protest_opens_at ? Date.parse(contest.protest_opens_at) : NaN;
    const closes = contest.protest_closes_at ? Date.parse(contest.protest_closes_at) : Infinity;
    if (
      contest.protest ||
      Number.isNaN(opens) ||
      now.getTime() < opens ||
      now.getTime() >= closes
    ) {
      throw apiError(409, 'PROTEST_NOT_AVAILABLE', 'Not protestable', {
        details: { reason: contest.protest ? 'already_protested' : 'window_closed' },
      });
    }
    const iso = now.toISOString();
    contest.status = 'declined';
    contest.protest = {
      status: 'open',
      basis: contest.protest_basis ?? 'declined',
      reason: body.reason,
      evidence_urls: [...new Set(body.evidence_urls ?? [])],
      protested_at: iso,
      reply_due_at: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
      reply: null,
      reply_evidence_urls: [],
      replied_at: null,
      decision_note: null,
      decided_at: null,
    };
    contest.protest_opens_at = null;
    contest.protest_closes_at = null;
    contest.protest_basis = null;
    contest.updated_at = iso;
    return { contest: clone(contest) };
  }

  override async replyContestProtest(
    contestId: string,
    body: ReplyContestProtestInput,
  ): Promise<VendorContestResponse> {
    const contest = this.contests.received.find((c) => c.id === contestId);
    if (!contest?.protest) throw apiError(404, 'NOT_FOUND', 'Contest not found');
    if (contest.protest.status !== 'open') {
      throw apiError(409, 'PROTEST_NOT_OPEN', 'This protest is closed');
    }
    if (contest.protest.reply !== null) {
      throw apiError(409, 'PROTEST_REPLY_EXISTS', 'Already replied');
    }
    const iso = new Date().toISOString();
    contest.protest.reply = body.reply;
    contest.protest.reply_evidence_urls = [...new Set(body.evidence_urls ?? [])];
    contest.protest.replied_at = iso;
    contest.updated_at = iso;
    return { contest: clone(contest) };
  }

  override async withdrawContestProtest(contestId: string): Promise<VendorContestResponse> {
    const contest = this.contests.submitted.find((c) => c.id === contestId);
    if (!contest?.protest) throw apiError(404, 'NOT_FOUND', 'Contest not found');
    if (contest.protest.status !== 'open') {
      throw apiError(409, 'PROTEST_NOT_OPEN', 'This protest is closed');
    }
    contest.protest.status = 'withdrawn';
    contest.updated_at = new Date().toISOString();
    return { contest: clone(contest) };
  }

  // ─── Vendor create (AECI-1011) ─────────────────────────────────────────────

  // ─── Vendor replies to reviews (AECI-1179) ─────────────────────────────────

  /** Per-session copy, so a preview reply sticks until the page reloads. */
  private reviews: VendorReviewItem[] = clone([...VENDOR_REVIEWS_FIXTURE]);

  /** The server's `can_reply`: the owned product's plan holds `review.reply`. */
  private canReplyOn(productId: string): boolean {
    const product = this.me?.products.find((p) => p.id === productId);
    return product?.plan.capabilities.includes('review.reply') ?? false;
  }

  /** The Changes page (AECI-1160). A vendor with no products is the new-vendor
   *  fixture, which has no history yet: that is the empty state. */
  override async listHistory(
    page: number,
    perPage: number,
    filters: VendorHistoryFilters = {},
  ): Promise<ListVendorHistoryResponse> {
    // By WHO acted, as the API filters (AECI-1194): `historyKindKeeps`.
    const kind = filters.kind ?? 'all';
    const rows = (this.me?.products.length ? VENDOR_HISTORY_FIXTURE : []).filter((r) =>
      historyKindKeeps(kind, r),
    );
    const start = (page - 1) * perPage;
    return clone({ data: rows.slice(start, start + perPage), page, perPage, total: rows.length });
  }

  /** The search follow-up of the asked-for rows (AECI-1160), as the API scopes it:
   *  only lines whose audit id was asked for. */
  override async getHistoryFollowUp(
    auditIds: readonly string[],
  ): Promise<ListVendorHistoryFollowUpResponse> {
    const asked = new Set(auditIds);
    return clone({
      data: VENDOR_HISTORY_FOLLOW_UP_FIXTURE.filter((l) => asked.has(l.audit_log_id)),
    });
  }

  override async listReviews(filters: VendorReviewsFilters): Promise<ListVendorReviewsResponse> {
    const owned = new Set((this.me?.products ?? []).map((p) => p.id));
    const rows = this.reviews
      .filter((i) => owned.has(i.product.id))
      .filter((i) => !filters.productId || i.product.id === filters.productId)
      .filter((i) => {
        if (!filters.replyStatus) return true;
        const state = i.response?.status ?? 'none';
        return state === filters.replyStatus;
      })
      .map((i) => ({ ...i, can_reply: this.canReplyOn(i.product.id) }));
    const start = (filters.page - 1) * filters.perPage;
    return clone({
      data: rows.slice(start, start + filters.perPage),
      page: filters.page,
      perPage: filters.perPage,
      total: rows.length,
    });
  }

  private ownedReview(reviewId: string): VendorReviewItem {
    const owned = new Set((this.me?.products ?? []).map((p) => p.id));
    const item = this.reviews.find((i) => i.review.id === reviewId && owned.has(i.product.id));
    if (!item) throw apiError(404, 'NOT_FOUND', 'Review not found');
    return item;
  }

  private requireReply(item: VendorReviewItem): void {
    if (!this.canReplyOn(item.product.id)) {
      throw apiError(403, 'ENTITLEMENT_REQUIRED', 'Replying needs review.reply', {
        details: { capability: 'review.reply' },
      });
    }
  }

  override async submitReviewResponse(
    reviewId: string,
    body: string,
  ): Promise<VendorReviewResponseResult> {
    const item = this.ownedReview(reviewId);
    this.requireReply(item);
    const now = new Date().toISOString();
    const current = item.response;
    if (current?.status === 'removed') {
      throw apiError(409, 'REVIEW_RESPONSE_REMOVED', 'Removed', { details: { status: 'removed' } });
    }
    if (current && (current.status === 'pending' || current.status === 'published')) {
      throw apiError(409, 'REVIEW_RESPONSE_EXISTS', 'Exists', {
        details: { status: current.status },
      });
    }
    item.response = {
      id: current?.id ?? `preview-reply-${reviewId}`,
      status: 'pending',
      body: body.trim(),
      rejection_reason: null,
      published_at: null,
      moderated_at: null,
      created_at: current?.created_at ?? now,
      updated_at: now,
    };
    return { response: clone(item.response) };
  }

  override async editReviewResponse(
    reviewId: string,
    body: string,
  ): Promise<VendorReviewResponseResult> {
    const item = this.ownedReview(reviewId);
    this.requireReply(item);
    const current = item.response;
    if (!current) throw apiError(404, 'NOT_FOUND', 'Reply not found');
    if (current.status === 'removed') {
      throw apiError(409, 'REVIEW_RESPONSE_REMOVED', 'Removed', { details: { status: 'removed' } });
    }
    if (current.status !== 'pending' && current.status !== 'published') {
      throw apiError(409, 'REVIEW_RESPONSE_WRONG_STATE', 'Wrong state', {
        details: { status: current.status },
      });
    }
    if (body.trim() === current.body) {
      throw apiError(422, 'REVIEW_RESPONSE_NO_CHANGE', 'Unchanged', { field: 'body' });
    }
    item.response = {
      ...current,
      status: 'pending',
      body: body.trim(),
      published_at: null,
      updated_at: new Date().toISOString(),
    };
    return { response: clone(item.response) };
  }

  /** Not gated, like the server (§11c.9). */
  override async withdrawReviewResponse(reviewId: string): Promise<VendorReviewResponseResult> {
    const item = this.ownedReview(reviewId);
    const current = item.response;
    if (!current) throw apiError(404, 'NOT_FOUND', 'Reply not found');
    if (current.status === 'removed') {
      throw apiError(409, 'REVIEW_RESPONSE_REMOVED', 'Removed', { details: { status: 'removed' } });
    }
    if (current.status !== 'pending' && current.status !== 'published') {
      throw apiError(409, 'REVIEW_RESPONSE_WRONG_STATE', 'Wrong state', {
        details: { status: current.status },
      });
    }
    item.response = {
      ...current,
      status: 'withdrawn',
      published_at: null,
      updated_at: new Date().toISOString(),
    };
    return { response: clone(item.response) };
  }

  // ─── The connector catalogue seat (AECI-1083) ─────────────────────────────

  /** Per-session copies of the catalogue fixtures, so a preview edit sticks until
   *  the page reloads and never mutates the shared constant. */
  private catalogues = new Map<string, ConnectorCatalogFixture>(
    Object.entries(clone(VENDOR_CONNECTOR_CATALOG_FIXTURE)),
  );

  override async getConnectorCatalog(
    productId: string,
    filters: VendorConnectorCatalogFilters,
  ): Promise<VendorConnectorCatalogResponse> {
    const own = this.me?.products.find((p) => p.id === productId);
    if (!own || own.product_role !== 'connector') {
      throw apiError(404, 'NOT_FOUND', 'Product not found');
    }
    const fixture = this.catalogues.get(productId);
    if (!fixture) {
      return {
        data: [],
        page: filters.page,
        perPage: filters.perPage,
        total: 0,
        product_id: productId,
        catalog: null,
      };
    }
    return clone(pageCatalogue(productId, fixture, filters));
  }

  override async updateConnectorMapping(
    mappingId: string,
    input: UpdateConnectorStubMappingInput,
  ): Promise<VendorConnectorStubMappingEditResponse> {
    for (const [productId, fixture] of this.catalogues) {
      const listing = fixture.listings.find((l) => l.mappings.some((m) => m.id === mappingId));
      if (!listing) continue;
      if (fixture.managed_by !== 'vendor') {
        throw apiError(
          409,
          'CATALOG_REVIEW_MANAGED',
          'This catalogue is still maintained through the review app.',
        );
      }
      const current = listing.mappings.find((m) => m.id === mappingId)!;
      const status = input.status ?? current.status;
      const productIdNext =
        input.productId !== undefined ? input.productId : (current.product?.id ?? null);
      const namesProduct = !(CONNECTOR_DECISION_STATUSES as readonly string[]).includes(status);
      if (namesProduct !== (productIdNext !== null)) {
        throw apiError(422, 'VALIDATION_FAILED', 'Two-column invariant', { field: 'productId' });
      }
      const product =
        productIdNext === null
          ? null
          : productIdNext === current.product?.id
            ? current.product
            : (PREVIEW_CATALOGUE.find((p) => p.id === productIdNext) ?? null);
      if (productIdNext !== null && product === null) {
        throw apiError(422, 'VALIDATION_FAILED', 'Not published', { field: 'productId' });
      }
      const clash = listing.mappings.some(
        (m) =>
          m.id !== mappingId &&
          (namesProduct
            ? m.product?.id === productIdNext
            : (CONNECTOR_DECISION_STATUSES as readonly string[]).includes(m.status)),
      );
      if (clash) throw apiError(409, 'MAPPING_CONFLICT', 'Conflict');

      const confidence = input.confidence !== undefined ? input.confidence : current.confidence;
      const evidenceUrl =
        input.evidenceUrl !== undefined ? input.evidenceUrl : current.evidence_url;
      const changed =
        status !== current.status ||
        productIdNext !== (current.product?.id ?? null) ||
        confidence !== current.confidence ||
        evidenceUrl !== current.evidence_url;
      const now = new Date().toISOString();
      const next = changed
        ? {
            ...current,
            status: status as typeof current.status,
            product: product ? { id: product.id, name: product.name, slug: product.slug } : null,
            confidence,
            evidence_url: evidenceUrl,
            decided_by: 'vendor' as const,
            decided_at: now,
            publishable: status === 'mapped' && product !== null,
          }
        : current;
      this.catalogues.set(productId, {
        ...fixture,
        listings: fixture.listings.map((l) =>
          l.id === listing.id
            ? { ...l, mappings: l.mappings.map((m) => (m.id === mappingId ? next : m)) }
            : l,
        ),
      });
      return {
        catalog_id: fixture.id,
        stub_id: listing.id,
        changed,
        mapping: {
          id: next.id,
          status: next.status,
          product: next.product,
          confidence: next.confidence,
          evidence_url: next.evidence_url,
          decided_by: next.decided_by,
          decided_at: next.decided_at,
          publishable: next.publishable,
        },
      };
    }
    throw apiError(404, 'NOT_FOUND', 'Mapping not found');
  }

  override async searchProducts(query: string, perPage = 8): Promise<ProductsListResponse> {
    const needle = query.trim().toLowerCase();
    // A to Z, the order the real `sort=name` search returns (AECI-1244).
    const items = PREVIEW_CATALOGUE.filter((p) => p.name.toLowerCase().includes(needle))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
      .slice(0, perPage);
    return { data: clone(items), total: items.length, page: 1, perPage };
  }

  /** The public product read, from the same small catalogue the search answers
   *  from (AECI-1377 deep link). An unknown slug is the real route's `404`. */
  override async getProduct(slug: string): Promise<ProductListItem> {
    const found = PREVIEW_CATALOGUE.find((p) => p.slug === slug);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Product not found');
    return clone(found);
  }

  /** The vendor's requests, one per status (AECI-1377). */
  override async listProductRequests(): Promise<ListVendorProductRequestsResponse> {
    return { requests: clone(this.productRequests) };
  }

  /** A request, fixture-side: the schema, the context-product `404`, and the
   *  open-duplicate `409` the handler applies (§4.7.6). */
  override async createProductRequest(
    body: CreateProductRequestInput,
  ): Promise<CreateProductRequestResponse> {
    const parsed = CreateProductRequestSchema.safeParse(body);
    if (!parsed.success) throw apiError(400, 'VALIDATION_FAILED', 'Check the body');
    if (!this.me?.products.some((p) => p.id === parsed.data.context_product_id)) {
      throw apiError(404, 'NOT_FOUND', 'Product not found');
    }
    const key = parsed.data.name.trim().toLowerCase();
    const existing = this.productRequests.find(
      (r) => r.status === 'open' && r.name.trim().toLowerCase() === key,
    );
    if (existing) {
      throw apiError(409, 'PRODUCT_REQUEST_EXISTS', 'Already asked', {
        details: { request_id: existing.id },
      });
    }
    const request: VendorProductRequest = {
      id: `00000000-0000-4000-8000-${String(910000000000 + this.nextRequestSeq++)}`,
      status: 'open',
      context_product_id: parsed.data.context_product_id,
      name: parsed.data.name,
      maker: parsed.data.maker,
      website: parsed.data.website || null,
      body: parsed.data.body ?? '',
      created_at: '2026-10-15T12:00:00.000Z',
      resolved_at: null,
      decline_reason: null,
      resolved_product: null,
    };
    this.productRequests = [request, ...this.productRequests];
    return { request: clone(request) };
  }

  /** The create, fixture-side: the schema and value rule the handler applies, the
   *  strong-match warning computed from the in-memory list (same pair, either
   *  orientation, owner the caller or unknown), and a new owned, claimed entry. */
  /** The create's strong-match rule, fixture-side (AECI-1953): the same pair, no
   *  connector, an owner that is the caller or unknown, retired rows included. */
  private possibleDuplicatesFor(
    vendorId: string,
    ownId: string,
    otherId: string,
  ): PossibleDuplicateIntegration[] {
    return this.integrations.integrations
      .filter(
        (entry) =>
          entry.context_product.id === ownId &&
          entry.other_product.id === otherId &&
          entry.powered_by === null &&
          (entry.owner === null || entry.owner.id === vendorId),
      )
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        mechanism_kind: entry.mechanism_kind,
        mechanism_name: entry.mechanism_name,
        orientation: 'same' as const,
        owner: entry.owner,
        claimed: entry.claimed_at !== null,
        retired: entry.retired_at !== null,
        retired_by: entry.retired_at === null ? null : (entry.retired_by ?? 'owner'),
      }));
  }

  /** `GET /api/vendor/integrations/possible-duplicates`, fixture-side: the create's
   *  endpoint `404`, then the same rule the create's 201 reports. */
  override async getPossibleDuplicates(
    productId: string,
    counterpartProductId: string,
  ): Promise<PossibleDuplicatesResponse> {
    const me = this.me;
    const own = me?.products.find((p) => p.id === productId);
    const other = PREVIEW_CATALOGUE.find((p) => p.id === counterpartProductId);
    if (!me || !own || !other || own.id === other.id) {
      throw apiError(404, 'NOT_FOUND', 'Product not found');
    }
    return { possible_duplicates: this.possibleDuplicatesFor(me.vendor.id, own.id, other.id) };
  }

  override async createIntegration(
    body: CreateVendorIntegrationInput,
  ): Promise<CreateVendorIntegrationResponse> {
    const parsed = CreateVendorIntegrationSchema.safeParse(body);
    if (!parsed.success) throw apiError(400, 'VALIDATION_FAILED', 'Check the body');
    for (const field of INTEGRATION_EDIT_FIELDS) {
      const value = parsed.data[field];
      if (value === undefined || value === null) continue;
      const problem = integrationEditValueProblem(field, value);
      if (problem) throw apiError(422, 'INTEGRATION_INVALID_VALUE', problem, { field });
    }
    const me = this.me;
    const own = me?.products.find((p) => p.id === parsed.data.product_id);
    const other = PREVIEW_CATALOGUE.find((p) => p.id === parsed.data.counterpart_product_id);
    if (!me || !own || !other) throw apiError(404, 'NOT_FOUND', 'Product not found');

    const duplicates = this.possibleDuplicatesFor(me.vendor.id, own.id, other.id);

    const now = '2026-09-22T12:00:00.000Z';
    const id = `00000000-0000-4000-8000-${String(900000000000 + this.nextCreateSeq++)}`;
    // The prefill map keeps its stored twelve (AECI-1155); `pricing_url` is its own
    // field (AECI-1154), and `owner` is the caller.
    const fields: ContestableFields = { ...EMPTY_CONTESTABLE_FIELDS, owner: me.vendor.id };
    for (const field of INTEGRATION_EDIT_FIELDS) {
      if (field !== 'pricing_url') fields[field] = parsed.data[field] ?? null;
    }
    const entry: VendorIntegration = {
      id,
      flows_maintained_by_owner: false,
      owner_flows: null,
      name: parsed.data.name ?? null,
      mechanism_kind: (parsed.data.mechanism_kind ?? null) as VendorIntegration['mechanism_kind'],
      mechanism_name: parsed.data.mechanism_name ?? null,
      context_product: { id: own.id, slug: own.slug, name: own.name, logo_url: null },
      other_product: { id: other.id, slug: other.slug, name: other.name, logo_url: null },
      slots: ['vendor_a'],
      attestable: true,
      powered_by: null,
      claims: [],
      is_owner: true,
      owner: { id: me.vendor.id, name: me.vendor.company_name },
      claimed_at: now,
      retired_at: null,
      retired_by: null,
      contestable_fields: fields,
      endpoint_vendors: [{ id: me.vendor.id, name: me.vendor.company_name }],
      own_links: { listing_url: null, docs_url: null },
      counterpart_links: { listing_url: null, docs_url: null },
      origin: 'vendor',
      created_at: now,
      maintained_by: 'vendor',
      last_reviewed_at: now,
      pricing_url: parsed.data.pricing_url ?? null,
    };
    this.integrations.integrations.push(entry);
    return {
      integration: {
        id,
        source_product_id: own.id,
        target_product_id: other.id,
        origin: 'vendor',
        owner_vendor_id: me.vendor.id,
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        created_at: now,
        updated_at: now,
      },
      possible_duplicates: duplicates,
    };
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
    // AECI-1091: an owned row outside the attestable list (an evidenced pair) takes
    // the same retire and restore, on the same terms.
    const owned = (this.integrations.owned ?? []).find((row) => row.id === integrationId);
    if (owned) return this.setOwnedRetired(owned, mode);
    const entries = this.integrations.integrations.filter((i) => i.id === integrationId);
    const first = entries[0];
    if (!first) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!first.is_owner) throw apiError(403, 'INTEGRATION_NOT_OWNER', 'Not the owner');
    // AECI-1091: a connector-delivered row retires on any plan (ruling 14).
    if (first.claimed_at === null) throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Not claimed');
    if (mode === 'retire' && first.retired_at !== null) {
      throw apiError(409, 'INTEGRATION_RETIRED', 'Already retired');
    }
    if (mode === 'restore' && first.retired_at === null) {
      throw apiError(409, 'INTEGRATION_NOT_RETIRED', 'Not retired');
    }
    // AECI-1046: only an admin restores an admin retire.
    if (mode === 'restore' && first.retired_by === 'aeci') {
      throw apiError(403, 'INTEGRATION_RETIRED_BY_AECI', 'Retired by AEC Integrations');
    }
    const now = '2026-09-22T12:00:00.000Z';
    const retiredAt = mode === 'retire' ? now : null;
    const retiredBy = mode === 'retire' ? ('owner' as const) : null;
    // Both entries when the caller owns both endpoints: one row, two views.
    for (const entry of entries) {
      entry.retired_at = retiredAt;
      entry.retired_by = retiredBy;
    }
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
      integration: {
        id: integrationId,
        retired_at: retiredAt,
        retired_by: retiredBy,
        updated_at: now,
      },
      withdrawn_contest_ids: [...new Set(withdrawn)],
    };
  }

  /** The owned-row half of {@link setRetired} (AECI-1091), with the server's refusal
   *  order: claimed, then state. No plan is asked for (ruling 14). */
  private setOwnedRetired(
    owned: NonNullable<ListVendorIntegrationsResponse['owned']>[number],
    mode: 'retire' | 'restore',
  ): RetireIntegrationResponse {
    if (owned.claimed_at === null) throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Not claimed');
    if (mode === 'retire' && owned.retired_at !== null) {
      throw apiError(409, 'INTEGRATION_RETIRED', 'Already retired');
    }
    if (mode === 'restore' && owned.retired_at === null) {
      throw apiError(409, 'INTEGRATION_NOT_RETIRED', 'Not retired');
    }
    if (mode === 'restore' && owned.retired_by === 'aeci') {
      throw apiError(403, 'INTEGRATION_RETIRED_BY_AECI', 'Retired by AEC Integrations');
    }
    // AECI-2042: an endpoint vendor's removal in force refuses the owner's restore.
    if (mode === 'restore' && this.vetoInForceOn(owned.id)) {
      throw apiError(409, 'INTEGRATION_VETOED', 'An endpoint vendor removed this integration');
    }
    const now = '2026-09-23T12:00:00.000Z';
    owned.retired_at = mode === 'retire' ? now : null;
    owned.retired_by = mode === 'retire' ? 'owner' : null;
    // AECI-2039: the owner keeps a Sync Service pair's flows while it is live.
    owned.flows_editable = owned.sync_service && owned.claimed_at !== null && !owned.retired_at;
    return {
      integration: {
        id: owned.id,
        retired_at: owned.retired_at,
        retired_by: owned.retired_by,
        updated_at: now,
      },
      withdrawn_contest_ids: [],
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

  // ─── Per-side integration links (AECI-1007) ────────────────────────────────

  /** Mirrors the handler: the entry must be the caller's own side, and a
   *  connector-powered row is `403 INTEGRATION_CONNECTOR_POWERED`. */
  override async putIntegrationLink(
    integrationId: string,
    productId: string,
    kind: IntegrationLinkKind,
    url: string,
  ): Promise<IntegrationLinkResponse> {
    return this.writeLink(integrationId, productId, kind, url);
  }

  override async deleteIntegrationLink(
    integrationId: string,
    productId: string,
    kind: IntegrationLinkKind,
  ): Promise<IntegrationLinkResponse> {
    return this.writeLink(integrationId, productId, kind, null);
  }

  private writeLink(
    integrationId: string,
    productId: string,
    kind: IntegrationLinkKind,
    url: string | null,
  ): IntegrationLinkResponse {
    const entry = this.integrations.integrations.find(
      (i) => i.id === integrationId && i.context_product.id === productId,
    );
    if (!entry) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!entry.attestable) {
      throw apiError(403, 'INTEGRATION_CONNECTOR_POWERED', 'Connector-powered integration');
    }
    const links = { ...entry.own_links, [kind === 'listing' ? 'listing_url' : 'docs_url']: url };
    entry.own_links = links;
    // AECI-1152: an owns-both row lists the same side as the other entry's
    // `counterpart_links`, so keep the two in step.
    for (const other of this.integrations.integrations) {
      if (other.id === integrationId && other.other_product.id === productId) {
        other.counterpart_links = { ...links };
      }
    }
    return clone({ integration_id: integrationId, product_id: productId, links });
  }

  // ─── AECI-2045 QA: the Sync Service writes (AECI-2039, AECI-2040, AECI-2042) ──
  // Every `VendorApi` method has a fake here (`preview-vendor-api.spec.ts` holds the
  // preview to that), so pressing Yes, No, Change, Add a row, the pair create, a removal
  // or a report succeeds against the in-memory fixture instead of a 401.

  private syncId(): string {
    this.nextSyncSeq += 1;
    return `00000000-0000-4000-8000-${(0x5800 + this.nextSyncSeq).toString(16).padStart(12, '0')}`;
  }

  /** Every place an owner flow lives: the owned rows, and the endpoint entries whose
   *  owner keeps their flows (`owner_flows`). One row can be two entries. */
  private ownerFlowHolders(): { id: string; editable: boolean; flows: OwnedFlow[] }[] {
    const owned = (this.integrations.owned ?? []).map((row) => ({
      id: row.id,
      editable: row.flows_editable,
      flows: row.flows,
    }));
    const endpoint = this.integrations.integrations.flatMap((entry) =>
      entry.owner_flows
        ? [{ id: entry.id, editable: entry.owner_flows.editable, flows: entry.owner_flows.flows }]
        : [],
    );
    return [...owned, ...endpoint];
  }

  /** The holders of one flow, refused as the server refuses a flow the caller cannot answer. */
  private holdersOfFlow(claimId: string) {
    const holders = this.ownerFlowHolders().filter((h) => h.flows.some((f) => f.id === claimId));
    if (holders.length === 0) throw apiError(404, 'NOT_FOUND', 'Flow not found');
    if (!holders[0]!.editable) {
      throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Claim this integration first');
    }
    return holders;
  }

  private ownerFlowsResponse(integrationId: string): OwnerFlowsResponse {
    const holder = this.ownerFlowHolders().find((h) => h.id === integrationId);
    return { integration_id: integrationId, flows: clone(holder?.flows ?? []) };
  }

  /** Confirm (Yes) or remove (No) one flow, on every entry that carries it. */
  private answerFlow(claimId: string, answer: OwnedFlow['answer']): string {
    let integrationId = '';
    for (const holder of this.holdersOfFlow(claimId)) {
      integrationId = holder.id;
      for (const flow of holder.flows) {
        if (flow.id !== claimId) continue;
        flow.answer = answer;
        flow.agreement =
          answer === 'yes'
            ? 'owner_confirmed'
            : flow.agreement === 'owner_confirmed'
              ? 'unverified'
              : flow.agreement;
      }
    }
    return integrationId;
  }

  /** Confirm the flow of `slug` in `direction` on a row, adding it when it is not listed. */
  private confirmFlowOn(
    integrationId: string,
    slug: string,
    name: string,
    direction: OwnerFlowDirection,
  ): void {
    const id = this.syncId();
    for (const holder of this.ownerFlowHolders().filter((h) => h.id === integrationId)) {
      const existing = holder.flows.find(
        (f) => f.data_object_slug === slug && f.direction === direction,
      );
      if (existing) {
        existing.answer = 'yes';
        existing.agreement = 'owner_confirmed';
      } else {
        holder.flows.push({
          id,
          data_object_slug: slug,
          data_object_name: name,
          direction,
          agreement: 'owner_confirmed',
          origin: 'vendor',
          answer: 'yes',
        });
      }
    }
  }

  override async setOwnerFlowAnswer(
    claimId: string,
    asserted: boolean,
  ): Promise<OwnerFlowsResponse> {
    return this.ownerFlowsResponse(this.answerFlow(claimId, asserted ? 'yes' : 'no'));
  }

  override async clearOwnerFlowAnswer(claimId: string): Promise<void> {
    this.answerFlow(claimId, null);
  }

  /** The old flow is answered No and the flow in the new direction confirmed (§6.15.3). */
  override async changeOwnerFlow(
    claimId: string,
    body: ChangeOwnerFlowInput,
  ): Promise<OwnerFlowsResponse> {
    const holders = this.holdersOfFlow(claimId);
    const flow = holders[0]!.flows.find((f) => f.id === claimId)!;
    if (flow.direction === body.direction) {
      throw apiError(422, 'CONTEST_NO_CHANGE', 'That is the direction on record now');
    }
    const integrationId = this.answerFlow(claimId, 'no');
    this.confirmFlowOn(integrationId, flow.data_object_slug, flow.data_object_name, body.direction);
    return this.ownerFlowsResponse(integrationId);
  }

  override async addOwnerFlow(
    integrationId: string,
    body: AddOwnerFlowInput,
  ): Promise<OwnerFlowsResponse> {
    const holder = this.ownerFlowHolders().find((h) => h.id === integrationId);
    if (!holder) throw apiError(404, 'NOT_FOUND', 'Integration not found');
    if (!holder.editable) {
      throw apiError(409, 'INTEGRATION_NOT_CLAIMED', 'Claim this integration first');
    }
    const slug = body.data_object;
    const name = dataObjectName(slug);
    if (!name) {
      throw apiError(400, 'VALIDATION_FAILED', `Unknown data object "${slug}"`, {
        field: 'data_object',
      });
    }
    this.confirmFlowOn(integrationId, slug, name, body.direction);
    return this.ownerFlowsResponse(integrationId);
  }

  /** AECI-2040: the Sync Service adds a pair it delivers, born claimed. */
  override async createSyncServicePair(
    body: CreateSyncServicePairInput,
  ): Promise<CreateSyncServicePairResponse> {
    const connector = this.me?.products.find((p) => p.id === body.connector_product_id);
    if (!connector) throw apiError(404, 'NOT_FOUND', 'Product not found');
    if (!isSyncService(connector.product_role, connector.connector_kind)) {
      throw apiError(422, 'CONNECTOR_NOT_SYNC_SERVICE', 'Not a Sync Service');
    }
    const first = PREVIEW_CATALOGUE.find((p) => p.id === body.product_id);
    const second = PREVIEW_CATALOGUE.find((p) => p.id === body.counterpart_product_id);
    if (!first || !second) throw apiError(404, 'NOT_FOUND', 'Product not found');
    if (first.id === second.id) {
      throw apiError(400, 'VALIDATION_FAILED', 'An integration needs two different products', {
        field: 'counterpart_product_id',
      });
    }
    const [a, b] = first.id < second.id ? [first, second] : [second, first];
    const sameKey = (x: string | undefined, y: string | undefined) =>
      (x === a.id && y === b.id) || (x === b.id && y === a.id);
    const vetoed = this.vetoes.received.some(
      (v) =>
        v.in_force &&
        v.pair.connector?.id === connector.id &&
        sameKey(v.pair.product_a?.id, v.pair.product_b?.id),
    );
    if (vetoed) {
      throw apiError(409, 'INTEGRATION_VETOED', 'An endpoint vendor removed this integration');
    }
    const existing = (this.integrations.owned ?? []).find(
      (row) => row.connector?.id === connector.id && sameKey(row.product_a.id, row.product_b.id),
    );
    if (existing) {
      throw apiError(409, 'INTEGRATION_ALREADY_ON_RECORD', 'Already on record', {
        details: {
          existing_id: existing.id,
          anchor: existing.anchor,
          retired: existing.retired_at !== null,
          owned_by_caller: true,
          claimed: existing.claimed_at !== null,
        },
      });
    }
    const id = this.syncId();
    const now = new Date().toISOString();
    const rawDirection = (body.direction ?? 'both') as OwnerFlowDirection;
    const direction = a.id === first.id ? rawDirection : mirrorDirection(rawDirection);
    const link = (p: ProductListItem) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      logo_url: p.logo_url,
    });
    const row: OwnedIntegration = {
      id,
      anchor: 'evidenced_pair',
      name: body.name ?? null,
      mechanism_kind: null,
      mechanism_name: body.mechanism_name ?? connector.name,
      product_a: link(a),
      product_b: link(b),
      connector: { id: connector.id, slug: connector.slug, name: connector.name, logo_url: null },
      connector_powered: true,
      claimed_at: now,
      retired_at: null,
      retired_by: null,
      contestable_fields: {
        ...EMPTY_CONTESTABLE_FIELDS,
        name: body.name ?? null,
        mechanism_name: body.mechanism_name ?? null,
        direction,
        description: body.description ?? null,
        listing_url: body.listing_url ?? null,
        docs_url: body.docs_url ?? null,
        pricing_model: body.pricing_model ?? null,
        maturity: body.maturity ?? null,
        owner: this.me!.vendor.id,
      },
      pricing_url: body.pricing_url ?? null,
      locked_fields: [],
      hidden_fields: [],
      sync_service: true,
      flows_editable: true,
      flows: [],
    };
    this.integrations = { ...this.integrations, owned: [...(this.integrations.owned ?? []), row] };
    return {
      pair: {
        id,
        connector_product_id: connector.id,
        product_a_id: a.id,
        product_b_id: b.id,
        origin: 'vendor',
        owner_vendor_id: this.me!.vendor.id,
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        created_at: now,
        updated_at: now,
      },
    };
  }

  private vetoInForceOn(integrationId: string): boolean {
    return this.vetoes.received.some((v) => v.in_force && v.pair.integration_id === integrationId);
  }

  /** The endpoint vendor's contest target for one delivered pair, with its group. */
  private rightsTarget(integrationId: string) {
    for (const [productId, response] of Object.entries(this.connectors)) {
      for (const group of response.connectors) {
        const target = group.delivered_contest_targets.find((t) => t.id === integrationId);
        if (target?.sync_service_rights) return { productId, group, target };
      }
    }
    throw apiError(404, 'NOT_FOUND', 'Integration not found');
  }

  /** Delivered pairs taken off a product by a veto, so a withdraw puts them back. */
  private readonly removedByVeto = new Map<
    string,
    {
      productId: string;
      connectorId: string;
      delivered: VendorProductConnectorsResponse['connectors'][number]['delivered'];
      targets: VendorProductConnectorsResponse['connectors'][number]['delivered_contest_targets'];
    }
  >();

  override async fileVeto(
    integrationId: string,
    reasonCode: RemovalReasonCode,
  ): Promise<VetoWriteResponse> {
    const { productId, group, target } = this.rightsTarget(integrationId);
    if (target.sync_service_rights!.veto_id) {
      throw apiError(409, 'VETO_DUPLICATE', 'Your company already removed this integration');
    }
    const now = new Date().toISOString();
    const [a, b] =
      target.context_product.id < target.other_product.id
        ? [target.context_product, target.other_product]
        : [target.other_product, target.context_product];
    const product = (p: { id: string; slug: string; name: string }) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
    });
    const veto: SyncServicePairVeto = {
      id: this.syncId(),
      pair: {
        integration_id: integrationId,
        anchor: 'evidenced_pair',
        name: target.name,
        connector: product(target.connector),
        product_a: product(a),
        product_b: product(b),
      },
      vendor_id: this.me!.vendor.id,
      vendor_name: this.me!.vendor.company_name,
      reason_code: reasonCode,
      reason: REMOVAL_REASON_LABELS[reasonCode],
      filed_at: now,
      in_force: true,
      ended_at: null,
      ended_how: null,
      end_reason: null,
      end_note: null,
      objection: null,
      other_vetoes_in_force: 0,
      updated_at: now,
    };
    this.vetoes.filed.unshift(veto);
    // The pair leaves the product at once, so the Connectors section drops it.
    this.removedByVeto.set(veto.id, {
      productId,
      connectorId: group.connector.id,
      delivered: group.delivered.filter((d) => d.id === integrationId),
      targets: [
        { ...target, sync_service_rights: { ...target.sync_service_rights!, veto_id: null } },
      ],
    });
    group.delivered = group.delivered.filter((d) => d.id !== integrationId);
    group.delivered_contest_targets = group.delivered_contest_targets.filter(
      (t) => t.id !== integrationId,
    );
    return { veto: clone(veto), pair_public: false };
  }

  override async withdrawVeto(vetoId: string): Promise<VetoWriteResponse> {
    const veto = this.vetoes.filed.find((v) => v.id === vetoId);
    if (!veto) throw apiError(404, 'NOT_FOUND', 'Removal not found');
    if (!veto.in_force) throw apiError(409, 'VETO_NOT_IN_FORCE', 'This removal has ended');
    const now = new Date().toISOString();
    veto.in_force = false;
    veto.ended_at = now;
    veto.ended_how = 'withdrawn';
    veto.updated_at = now;
    const removed = this.removedByVeto.get(vetoId);
    const group = removed
      ? this.connectors[removed.productId]?.connectors.find(
          (g) => g.connector.id === removed.connectorId,
        )
      : undefined;
    if (removed && group) {
      group.delivered = [...removed.delivered, ...group.delivered];
      group.delivered_contest_targets = [...removed.targets, ...group.delivered_contest_targets];
      this.removedByVeto.delete(vetoId);
    }
    return { veto: clone(veto), pair_public: true };
  }

  override async listVetoes(): Promise<VendorVetoesResponse> {
    return clone(this.vetoes);
  }

  /** AECI-2192: the owner objects. The rules the API holds: in force, one open, the
   *  three grounds, a link on "plainly false". Filing changes nothing else. */
  override async fileVetoObjection(
    vetoId: string,
    body: FileVetoObjectionInput,
  ): Promise<VetoObjectionResponse> {
    const veto = this.vetoes.received.find((v) => v.id === vetoId);
    if (!veto) throw apiError(404, 'NOT_FOUND', 'Removal not found');
    if (!veto.in_force) throw apiError(409, 'VETO_NOT_IN_FORCE', 'This removal has ended');
    if (veto.objection?.status === 'open') {
      throw apiError(409, 'VETO_OBJECTION_DUPLICATE', 'An objection is already open');
    }
    const parsed = FileVetoObjectionSchema.safeParse(body);
    if (!parsed.success) throw apiError(400, 'VALIDATION_FAILED', 'Invalid objection');
    const now = new Date().toISOString();
    veto.objection = {
      id: this.syncId(),
      ground: parsed.data.ground,
      explanation: parsed.data.explanation,
      source_url: parsed.data.source_url ?? null,
      vendor_name: this.me!.vendor.company_name,
      status: 'open',
      decision_note: null,
      decided_at: null,
      created_at: now,
    };
    veto.updated_at = now;
    return { objection: clone(veto.objection) };
  }

  override async submitPairContest(
    integrationId: string,
    body: SubmitPairContestInput,
  ): Promise<PairContestResponse> {
    const { target } = this.rightsTarget(integrationId);
    const rights = target.sync_service_rights!;
    const now = new Date().toISOString();
    let flow: PairContest['flow'] = null;
    if (body.kind === 'existence') {
      if (rights.open_reports.includes('existence')) {
        throw apiError(409, 'PAIR_CONTEST_DUPLICATE', 'You already have this report open');
      }
    } else {
      const named = rights.flows.find((f) => f.claim_id === body.claim_id);
      if (!named) throw apiError(404, 'NOT_FOUND', 'Flow not found');
      if (rights.open_flow_claim_ids.includes(body.claim_id)) {
        throw apiError(409, 'PAIR_CONTEST_DUPLICATE', 'You already have this report open');
      }
      if ((body.proposed_direction ?? null) === named.direction) {
        throw apiError(422, 'CONTEST_NO_CHANGE', 'That is the direction on record now');
      }
      flow = {
        claim_id: named.claim_id,
        data_object_slug: named.data_object_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        data_object_name: named.data_object_name,
        current_direction: named.direction,
        proposed_direction: body.proposed_direction ?? null,
      };
    }
    const routedTo = body.kind === 'data_flow' && rights.flows_decided_by_owner ? 'owner' : 'aeci';
    const product = (p: { id: string; slug: string; name: string }) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
    });
    const [a, b] =
      target.context_product.id < target.other_product.id
        ? [target.context_product, target.other_product]
        : [target.other_product, target.context_product];
    const contest: PairContest = {
      id: this.syncId(),
      kind: body.kind,
      pair: {
        integration_id: integrationId,
        anchor: 'evidenced_pair',
        name: target.name,
        connector: product(target.connector),
        product_a: product(a),
        product_b: product(b),
      },
      flow,
      reason: body.reason,
      submitter_vendor_id: this.me!.vendor.id,
      submitter_name: this.me!.vendor.company_name,
      routed_to: routedTo,
      owner_vendor_id: routedTo === 'owner' ? (target.owner?.id ?? null) : null,
      owner_name: target.owner?.name ?? null,
      status: 'open',
      decision_note: null,
      decided_at: null,
      accept_mode: null,
      protest: null,
      protest_closes_at: null,
      created_at: now,
      updated_at: now,
    };
    this.pairReports.submitted.unshift(contest);
    target.sync_service_rights =
      body.kind === 'existence'
        ? { ...rights, open_reports: [...rights.open_reports, 'existence'] }
        : {
            ...rights,
            open_reports: rights.open_reports.includes('data_flow')
              ? rights.open_reports
              : [...rights.open_reports, 'data_flow'],
            open_flow_claim_ids: [...rights.open_flow_claim_ids, body.claim_id],
          };
    return { contest: clone(contest) };
  }

  override async listPairContests(): Promise<VendorPairContestsResponse> {
    return clone(this.pairReports);
  }

  override async withdrawPairContest(id: string): Promise<PairContestResponse> {
    const contest = this.pairReports.submitted.find((c) => c.id === id);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Report not found');
    if (contest.status !== 'open') throw apiError(409, 'CONTEST_NOT_OPEN', 'No longer open');
    contest.status = 'withdrawn';
    contest.updated_at = new Date().toISOString();
    const integrationId = contest.pair.integration_id;
    if (integrationId) {
      try {
        const { target } = this.rightsTarget(integrationId);
        const rights = target.sync_service_rights!;
        const claimId = contest.flow?.claim_id;
        const flowIds = rights.open_flow_claim_ids.filter((c) => c !== claimId);
        target.sync_service_rights = {
          ...rights,
          open_flow_claim_ids: flowIds,
          open_reports: rights.open_reports.filter((kind) =>
            kind === contest.kind ? kind === 'data_flow' && flowIds.length > 0 : true,
          ),
        };
      } catch {
        // The pair has left the product since. Nothing to update on it.
      }
    }
    return { contest: clone(contest) };
  }

  /** The owner's accept writes its answer, as `planOwnerFlowChange` does (§11e.4). */
  override async decidePairContest(
    id: string,
    body: DecidePairContestInput,
  ): Promise<PairContestResponse> {
    const contest = this.pairReports.received.find((c) => c.id === id);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Report not found');
    if (contest.status !== 'open') throw apiError(409, 'CONTEST_NOT_OPEN', 'No longer open');
    const now = new Date().toISOString();
    if (body.decision === 'accept' && contest.flow) {
      const { claim_id: claimId, proposed_direction: proposed } = contest.flow;
      const integrationId = this.answerFlow(claimId, 'no');
      if (proposed) {
        this.confirmFlowOn(
          integrationId,
          contest.flow.data_object_slug,
          contest.flow.data_object_name,
          ownerDirectionOf(proposed),
        );
      }
      contest.accept_mode = proposed ? 'flow-redirected' : 'flow-removed';
    }
    contest.status = body.decision === 'accept' ? 'accepted' : 'declined';
    contest.decision_note = body.note ?? null;
    contest.decided_at = now;
    contest.updated_at = now;
    return { contest: clone(contest) };
  }

  override async protestPairContest(id: string, reason: string): Promise<PairContestResponse> {
    const contest = this.pairReports.submitted.find((c) => c.id === id);
    if (!contest) throw apiError(404, 'NOT_FOUND', 'Report not found');
    if (!contest.protest_closes_at || contest.protest) {
      throw apiError(409, 'PROTEST_NOT_ALLOWED', 'This report cannot be protested now');
    }
    const now = new Date().toISOString();
    contest.protest = {
      status: 'open',
      basis: contest.status === 'declined' ? 'declined' : 'silence',
      reason,
      protested_at: now,
      decision_note: null,
      decided_at: null,
    };
    contest.protest_closes_at = null;
    contest.updated_at = now;
    return { contest: clone(contest) };
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
