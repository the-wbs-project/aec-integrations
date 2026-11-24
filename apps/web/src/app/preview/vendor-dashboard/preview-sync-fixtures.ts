import type {
  EvidencedPairContestTarget,
  OwnedIntegration,
  PairContest,
  SyncServicePairVeto,
  VendorIntegration,
  VendorMeResponse,
  VendorProduct,
  VendorProductConnectorsResponse,
} from '@aeci/shared';
import { EMPTY_CONTESTABLE_FIELDS } from '@aeci/shared';

import {
  SYNC_SERVICE_PRODUCT,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_SYNC_SERVICE_FIXTURE,
  VENDOR_PRODUCT_CONNECTORS_FIXTURE,
} from '../../vendor/vendor-fixtures';

/**
 * The `sync-service` preset's extra rows (AECI-2045 QA), so every Sync Service state is
 * reachable in `/preview/vendor-dashboard` without a session:
 *
 * 1. the owner's pairs with answered and unanswered flows (the shared fixture's
 *    Procore and Acumatica, plus a pair the hybrid product delivers);
 * 2. pairs recorded under another company, with the ask (the shared fixture's delivered
 *    pairs);
 * 3. a pair an endpoint vendor removed (Acumatica and Trimble Connect, vetoed by Trimble)
 *    on the owner's side: "Removed by Trimble" on its page and in Messages, and a
 *    restore refused with `INTEGRATION_VETOED` once the owner retires it;
 * 4. the endpoint vendor's view: on Summit Model Coordination's tab, a pair another
 *    company's Sync Service (Rivet Sync) delivers, with `sync_service_rights` set, so
 *    the three actions render;
 * 5. a data flow report in the owner's received inbox (Acumatica on the Invoices flow).
 *
 * Kept out of `vendor-fixtures.ts` because specs count that file's rows.
 */

const SUMMIT_ID = VENDOR_ME_FIXTURE.vendor.id;
const PRIMARY =
  VENDOR_ME_FIXTURE.products.find((p) => p.is_primary) ?? VENDOR_ME_FIXTURE.products[0]!;

const link = (id: string, slug: string, name: string) => ({ id, slug, name, logo_url: null });

const SYNC_LINK = link(
  SYNC_SERVICE_PRODUCT.id,
  SYNC_SERVICE_PRODUCT.slug,
  SYNC_SERVICE_PRODUCT.name,
);
const PROCORE = link('00000000-0000-4000-8000-000000005301', 'procore', 'Procore');
const ACUMATICA = link('00000000-0000-4000-8000-000000005303', 'acumatica', 'Acumatica');
const SAGE = link('00000000-0000-4000-8000-000000005306', 'sage-intacct', 'Sage Intacct');
const TRIMBLE_CONNECT = link(
  '00000000-0000-4000-8000-000000005280',
  'trimble-connect',
  'Trimble Connect',
);

/** A `hybrid` Sync Service: an endpoint product that also delivers finished pairs. */
export const PREVIEW_SYNC_HYBRID_PRODUCT: VendorProduct = {
  ...SYNC_SERVICE_PRODUCT,
  id: '00000000-0000-4000-8000-000000005270',
  slug: 'summit-field-link',
  name: 'Summit Field Link',
  description: 'Field issue tracking that also runs finished syncs to accounting products.',
  product_role: 'hybrid',
  connector_kind: 'sync_service',
};
const HYBRID_LINK = link(
  PREVIEW_SYNC_HYBRID_PRODUCT.id,
  PREVIEW_SYNC_HYBRID_PRODUCT.slug,
  PREVIEW_SYNC_HYBRID_PRODUCT.name,
);

/** The preset's `/me`: the shared Sync Service vendor plus the hybrid product. */
export const PREVIEW_SYNC_ME: VendorMeResponse = {
  ...VENDOR_ME_SYNC_SERVICE_FIXTURE,
  products: [...VENDOR_ME_SYNC_SERVICE_FIXTURE.products, PREVIEW_SYNC_HYBRID_PRODUCT],
};

/** The pair Trimble removed from Trimble Connect (§11e.2). */
export const PREVIEW_VETOED_PAIR_ID = '00000000-0000-4000-8000-000000005271';
/** The pair the hybrid product delivers. */
export const PREVIEW_HYBRID_PAIR_ID = '00000000-0000-4000-8000-000000005272';

export const PREVIEW_SYNC_EXTRA_OWNED: readonly OwnedIntegration[] = [
  {
    id: PREVIEW_VETOED_PAIR_ID,
    anchor: 'evidenced_pair',
    name: 'Acumatica and Trimble Connect',
    mechanism_kind: null,
    mechanism_name: 'Summit Sync',
    product_a: ACUMATICA,
    product_b: TRIMBLE_CONNECT,
    connector: SYNC_LINK,
    connector_powered: true,
    claimed_at: '2026-11-18T00:00:00.000Z',
    retired_at: null,
    retired_by: null,
    contestable_fields: {
      ...EMPTY_CONTESTABLE_FIELDS,
      name: 'Acumatica and Trimble Connect',
      mechanism_name: 'Summit Sync',
      direction: 'inbound',
      owner: SUMMIT_ID,
    },
    pricing_url: null,
    locked_fields: [],
    hidden_fields: [],
    sync_service: true,
    flows_editable: true,
    flows: [
      {
        id: '00000000-0000-4000-8000-000000005273',
        data_object_slug: 'documents',
        data_object_name: 'Documents',
        direction: 'inbound',
        agreement: 'owner_confirmed',
        origin: 'vendor',
        answer: 'yes',
      },
    ],
  },
  {
    id: PREVIEW_HYBRID_PAIR_ID,
    anchor: 'evidenced_pair',
    name: 'Procore and Sage Intacct',
    mechanism_kind: null,
    mechanism_name: 'Summit Field Link',
    product_a: PROCORE,
    product_b: SAGE,
    connector: HYBRID_LINK,
    connector_powered: true,
    claimed_at: '2026-11-19T00:00:00.000Z',
    retired_at: null,
    retired_by: null,
    contestable_fields: {
      ...EMPTY_CONTESTABLE_FIELDS,
      name: 'Procore and Sage Intacct',
      mechanism_name: 'Summit Field Link',
      direction: 'outbound',
      owner: SUMMIT_ID,
    },
    pricing_url: null,
    locked_fields: [],
    hidden_fields: [],
    sync_service: true,
    flows_editable: true,
    flows: [
      {
        id: '00000000-0000-4000-8000-000000005274',
        data_object_slug: 'invoices',
        data_object_name: 'Invoices',
        direction: 'outbound',
        agreement: 'unverified',
        origin: 'aeci',
        answer: null,
      },
    ],
  },
];

/** The hybrid product's own endpoint integration, so its tab has both sections. */
const TEMPLATE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;
export const PREVIEW_HYBRID_ENDPOINT_INTEGRATION: VendorIntegration = {
  ...TEMPLATE,
  id: '00000000-0000-4000-8000-000000005275',
  name: 'Summit Field Link for Procore',
  context_product: HYBRID_LINK,
  other_product: PROCORE,
  owner_flows: null,
  claims: TEMPLATE.claims.slice(0, 2).map((claim, index) => ({
    ...claim,
    id: `00000000-0000-4000-8000-00000000527${6 + index}`,
    integration_id: '00000000-0000-4000-8000-000000005275',
  })),
};

/** Trimble's removal of the vetoed pair, as the owner receives it. */
export const PREVIEW_RECEIVED_VETO: SyncServicePairVeto = {
  id: '00000000-0000-4000-8000-000000005278',
  pair: {
    integration_id: PREVIEW_VETOED_PAIR_ID,
    anchor: 'evidenced_pair',
    name: 'Acumatica and Trimble Connect',
    connector: { id: SYNC_LINK.id, slug: SYNC_LINK.slug, name: SYNC_LINK.name },
    product_a: { id: ACUMATICA.id, slug: ACUMATICA.slug, name: ACUMATICA.name },
    product_b: { id: TRIMBLE_CONNECT.id, slug: TRIMBLE_CONNECT.slug, name: TRIMBLE_CONNECT.name },
  },
  vendor_id: '00000000-0000-4000-8000-0000000052f3',
  vendor_name: 'Trimble',
  reason: 'We have not certified this sync with Trimble Connect and do not support it.',
  filed_at: '2026-11-21T09:30:00.000Z',
  in_force: true,
  ended_at: null,
  ended_how: null,
  end_note: null,
  other_vetoes_in_force: 0,
  updated_at: '2026-11-21T09:30:00.000Z',
};

/** Acumatica's report on the Invoices flow of Procore and Acumatica (§11e.4). */
export const PREVIEW_RECEIVED_FLOW_REPORT: PairContest = {
  id: '00000000-0000-4000-8000-000000005279',
  kind: 'data_flow',
  pair: {
    integration_id: '00000000-0000-4000-8000-000000005263',
    anchor: 'evidenced_pair',
    name: 'Procore and Acumatica',
    connector: { id: SYNC_LINK.id, slug: SYNC_LINK.slug, name: SYNC_LINK.name },
    product_a: { id: PROCORE.id, slug: PROCORE.slug, name: PROCORE.name },
    product_b: { id: ACUMATICA.id, slug: ACUMATICA.slug, name: ACUMATICA.name },
  },
  flow: {
    claim_id: '00000000-0000-4000-8000-000000005265',
    data_object_slug: 'invoices',
    data_object_name: 'Invoices',
    current_direction: 'b_to_a',
    proposed_direction: 'both',
  },
  reason: 'Invoices sync both ways: paid status comes back from Procore.',
  submitter_vendor_id: '00000000-0000-4000-8000-0000000053a1',
  submitter_name: 'Acumatica',
  routed_to: 'owner',
  owner_vendor_id: SUMMIT_ID,
  owner_name: VENDOR_ME_FIXTURE.vendor.company_name,
  status: 'open',
  decision_note: null,
  decided_at: null,
  accept_mode: null,
  protest: null,
  protest_closes_at: null,
  created_at: '2026-11-22T10:00:00.000Z',
  updated_at: '2026-11-22T10:00:00.000Z',
};

/** The endpoint vendor's view: Rivet Sync, another company's Sync Service, delivers a
 *  pair on Summit Model Coordination. Summit is not its owner, so the rights render. */
export const PREVIEW_ENDPOINT_PAIR_ID = '00000000-0000-4000-8000-000000005281';
const RIVET_SYNC = link('00000000-0000-4000-8000-000000005282', 'rivet-sync', 'Rivet Sync');
const PRIMARY_LINK = link(PRIMARY.id, PRIMARY.slug, PRIMARY.name);

export const PREVIEW_ENDPOINT_RIGHTS_TARGET: EvidencedPairContestTarget = {
  id: PREVIEW_ENDPOINT_PAIR_ID,
  name: 'Summit Model Coordination and Procore',
  context_product: PRIMARY_LINK,
  other_product: PROCORE,
  connector: RIVET_SYNC,
  contestable_fields: {
    ...EMPTY_CONTESTABLE_FIELDS,
    name: 'Summit Model Coordination and Procore',
    mechanism_name: 'Rivet Sync',
    direction: 'both',
    owner: '00000000-0000-4000-8000-000000005283',
  },
  endpoint_vendors: [
    { id: '00000000-0000-4000-8000-0000000053a2', name: 'Procore Technologies' },
    { id: SUMMIT_ID, name: VENDOR_ME_FIXTURE.vendor.company_name },
  ],
  owner: { id: '00000000-0000-4000-8000-000000005283', name: 'Rivetworks' },
  is_owner: false,
  retired: false,
  sync_service_rights: {
    veto_id: null,
    open_reports: [],
    open_flow_claim_ids: [],
    flows: [
      {
        claim_id: '00000000-0000-4000-8000-000000005284',
        data_object_name: 'Issues',
        direction: PRIMARY.id < PROCORE.id ? 'a_to_b' : 'b_to_a',
      },
      {
        claim_id: '00000000-0000-4000-8000-000000005285',
        data_object_name: 'Models and drawings',
        direction: 'both',
      },
    ],
    flows_decided_by_owner: true,
  },
};

/** Summit Model Coordination's Connectors section with Rivet Sync added. */
export function previewSyncConnectors(): Record<string, VendorProductConnectorsResponse> {
  const base = VENDOR_PRODUCT_CONNECTORS_FIXTURE[PRIMARY.id]!;
  return {
    ...VENDOR_PRODUCT_CONNECTORS_FIXTURE,
    [PRIMARY.id]: {
      ...base,
      connectors: [
        {
          connector: RIVET_SYNC,
          catalog_as_of: null,
          delivered: [
            {
              ...base.connectors[0]!.delivered[0]!,
              id: PREVIEW_ENDPOINT_PAIR_ID,
              name: 'Summit Model Coordination and Procore',
              mechanism_name: 'Rivet Sync',
              direction: 'both',
              target: PROCORE,
              via: RIVET_SYNC,
              context_direction: 'both',
            },
          ],
          delivered_contest_targets: [PREVIEW_ENDPOINT_RIGHTS_TARGET],
          reachable: [],
        },
        ...base.connectors,
      ],
    },
  };
}
