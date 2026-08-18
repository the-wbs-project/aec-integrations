/**
 * Synthetic fixtures for the vendor dashboard (AECI-522) — feed the dev-only
 * preview (`preview/vendor-dashboard/`) and the component specs so the whole
 * surface can be reviewed + axe-scanned without a real vendor session.
 *
 * NOT production data. The shapes match `@aeci/shared` (`VendorMeResponse`,
 * `VendorSeat`, `TaxonomyResponse`) so the same presentational components render
 * fixtures here and live `/api/vendor/*` data on the real surface. A verified and
 * an unverified vendor are both provided so the verification state can be
 * reviewed in both directions.
 */
import type {
  DataObjectOption,
  ListVendorIntegrationsResponse,
  ProductVersion,
  TaxonomyResponse,
  TaxonomyTermWithCount,
  VendorIntegration,
  VendorMeResponse,
  VendorNotification,
  VendorProduct,
  VendorSeat,
} from '@aeci/shared';

function term(
  slug: string,
  name: string,
  display_order: number,
  product_count = 0,
): TaxonomyTermWithCount {
  return { id: `tax-${slug}`, slug, name, description: null, display_order, product_count };
}

/** The category/audience/phase vocabulary the product editor picks from. */
export const VENDOR_TAXONOMY_FIXTURE: TaxonomyResponse = {
  categories: [
    term('project-management', 'Project management', 1, 18),
    term('bim-authoring', 'BIM authoring', 2, 12),
    term('estimating', 'Estimating', 3, 9),
    term('document-control', 'Document control', 4, 7),
    term('field-reporting', 'Field reporting', 5, 6),
    term('reality-capture', 'Reality capture', 6, 4),
  ],
  audiences: [
    term('architects', 'Architects', 1, 14),
    term('structural-engineers', 'Structural engineers', 2, 11),
    term('general-contractors', 'General contractors', 3, 13),
    term('estimators', 'Estimators', 4, 8),
    term('project-managers', 'Project managers', 5, 15),
  ],
  phases: [
    term('preconstruction', 'Preconstruction', 1, 16),
    term('design', 'Design', 2, 19),
    term('construction', 'Construction', 3, 22),
    term('operations', 'Operations', 4, 7),
  ],
  // The fourth facet (AECI-538/544), which landed on `main` after these fixtures
  // were written and arrives here with the AECI-619 reconciliation. Slugs are real
  // entries from the governed closed vocabulary (`apps/api/seed/trades.sql`) — a
  // fixture must not invent one, because the trade facet is find-only and an
  // unseeded slug is exactly the state the vocabulary exists to prevent.
  trades: [
    term('concrete', 'Concrete', 1, 11),
    term('electrical', 'Electrical', 2, 9),
    term('hvac-mechanical', 'HVAC & Mechanical', 3, 8),
    term('structural-steel', 'Structural Steel & Metals', 4, 5),
  ],
};

const PRIMARY_PRODUCT: VendorProduct = {
  id: '00000000-0000-4000-8000-000000005201',
  slug: 'summit-model-coordination',
  name: 'Summit Model Coordination',
  is_primary: true,
  description:
    'Clash detection and model coordination for multidiscipline BIM teams, with issue tracking that syncs back to the authoring tools.',
  website: 'https://summitbim.example.com',
  tool_integrations_url: 'https://summitbim.example.com/integrations',
  api_docs_url: 'https://developers.summitbim.example.com',
  logo_url: null,
  category_slugs: ['bim-authoring', 'document-control'],
  audience_slugs: ['architects', 'structural-engineers'],
  phase_slugs: ['design', 'construction'],
  product_role: 'application',
  integration_count: 14,
  review_count: 6,
  updated_at: '2026-07-18T12:00:00.000Z',
};

const SECONDARY_PRODUCT: VendorProduct = {
  id: '00000000-0000-4000-8000-000000005202',
  slug: 'summit-field-issues',
  name: 'Summit Field Issues',
  is_primary: false,
  description: 'Punch-list and field-issue capture that rolls up into the coordination model.',
  website: null,
  tool_integrations_url: null,
  api_docs_url: null,
  logo_url: null,
  category_slugs: ['field-reporting'],
  audience_slugs: ['general-contractors', 'project-managers'],
  phase_slugs: ['construction'],
  product_role: 'application',
  integration_count: 3,
  review_count: 0,
  updated_at: '2026-07-02T09:30:00.000Z',
};

/** A verified, multi-seat vendor with two products and one open correction. */
export const VENDOR_ME_FIXTURE: VendorMeResponse = {
  vendor: {
    id: '00000000-0000-4000-8000-000000005200',
    slug: 'summit-bim',
    company_name: 'Summit BIM',
    verified: true,

    description:
      'Model coordination and field tooling for AEC teams. Founded by structural engineers.',
    website: 'https://summitbim.example.com',
    headquarters: 'Denver, CO',
    founded_year: 2014,
    public_private: 'private',
    parent_company: null,
    contact_email: 'hello@summitbim.example.com',
    phone_number: '+1 303 555 0142',
    logo_url: null,

    linkedin_url: 'https://www.linkedin.com/company/summit-bim',
    x_url: null,
    facebook_url: null,
    instagram_url: null,
    youtube_url: null,
    crunchbase_url: null,
    wiki_url: null,
    github_org: 'summit-bim',

    created_at: '2025-11-03T00:00:00.000Z',
    updated_at: '2026-07-18T12:00:00.000Z',
  },
  products: [PRIMARY_PRODUCT, SECONDARY_PRODUCT],
  requests: [
    {
      id: '00000000-0000-4000-8000-0000000052a1',
      kind: 'correction',
      target_type: 'product',
      target_id: PRIMARY_PRODUCT.id,
      status: 'in_review',
      created_at: '2026-07-20T15:00:00.000Z',
      resolved_at: null,
    },
    {
      id: '00000000-0000-4000-8000-0000000052a2',
      kind: 'claim',
      target_type: 'vendor',
      target_id: '00000000-0000-4000-8000-000000005200',
      status: 'resolved',
      created_at: '2026-06-01T10:00:00.000Z',
      resolved_at: '2026-06-04T14:00:00.000Z',
    },
  ],
  seat_count: 3,
};

/** An unverified single-seat vendor with no products or requests yet — the
 *  free/default baseline, for reviewing the "Unverified" + empty states. */
export const VENDOR_ME_UNVERIFIED_FIXTURE: VendorMeResponse = {
  vendor: {
    ...VENDOR_ME_FIXTURE.vendor,
    id: '00000000-0000-4000-8000-000000005210',
    slug: 'northwind-estimating',
    company_name: 'Northwind Estimating',
    verified: false,
    description: null,
    github_org: null,
    linkedin_url: null,
  },
  products: [],
  requests: [],
  seat_count: 1,
};

/** The seat roster for the verified vendor — three flat admins, one banned, one
 *  with an unresolved email (the local/preview degrade-to-null case). */
export const VENDOR_SEATS_FIXTURE: readonly VendorSeat[] = [
  {
    user_id: '00000000-0000-4000-8000-0000000052b1',
    display_name: 'Dana Ruiz',
    email: 'dana@summitbim.example.com',
    banned: false,
    created_at: '2026-06-04T14:00:00.000Z',
  },
  {
    user_id: '00000000-0000-4000-8000-0000000052b2',
    display_name: 'Priya Natarajan',
    email: 'priya@summitbim.example.com',
    banned: false,
    created_at: '2026-06-12T09:00:00.000Z',
  },
  {
    user_id: '00000000-0000-4000-8000-0000000052b3',
    display_name: null,
    email: null,
    banned: true,
    created_at: '2026-06-20T16:30:00.000Z',
  },
];

// ─── Attestations (AECI-606 / `STAGE_2_ATTESTATIONS_SPEC.md` §6) ─────────────

/**
 * The closed `data_object` vocabulary as `GET /api/vendor/data-objects` serves
 * it — an excerpt, in `display_order`.
 *
 * **Every slug is a real entry** from the governed closed list
 * (`docs/DATA_OBJECT_VOCABULARY.md` §4), for the same reason the trades fixture
 * above says so: the facet is find-only, and an invented slug is precisely the
 * state the vocabulary exists to prevent — a picker offering a term the server
 * will reject. Note `issues` is deliberately NOT here: it is one of the five
 * terms the vocabulary holds out, so it is not seeded and would not resolve.
 */
export const VENDOR_DATA_OBJECTS_FIXTURE: readonly DataObjectOption[] = [
  {
    slug: 'models',
    name: 'Models',
    description: 'BIM / 3D models exchanged between authoring and coordination tools.',
  },
  {
    slug: 'drawings',
    name: 'Drawings',
    description: '2D sheets and plans (DWG/PDF) shared across design and field tools.',
  },
  {
    slug: 'rfis',
    name: 'RFIs',
    description: 'Requests for information raised and answered across project teams.',
  },
  {
    slug: 'submittals',
    name: 'Submittals',
    description: 'Product data, shop drawings and samples routed for review.',
  },
  {
    slug: 'punch-lists',
    name: 'Punch lists',
    description: 'Closeout items tracked to completion in the field.',
  },
  {
    slug: 'documents',
    name: 'Documents',
    description: 'General project documents and their revisions.',
  },
];

const OTHER_PROCORE = {
  id: '00000000-0000-4000-8000-000000005301',
  slug: 'procore',
  name: 'Procore',
  logo_url: null,
};

const OTHER_AUTODESK_BUILD = {
  id: '00000000-0000-4000-8000-000000005302',
  slug: 'autodesk-build',
  name: 'Autodesk Build',
  logo_url: null,
};

const CONTEXT_PRIMARY = {
  id: PRIMARY_PRODUCT.id,
  slug: PRIMARY_PRODUCT.slug,
  name: PRIMARY_PRODUCT.name,
  logo_url: null,
};

const CONTEXT_SECONDARY = {
  id: SECONDARY_PRODUCT.id,
  slug: SECONDARY_PRODUCT.slug,
  name: SECONDARY_PRODUCT.name,
  logo_url: null,
};

const V_2026_1 = '00000000-0000-4000-8000-000000005401';
const V_2025_2 = '00000000-0000-4000-8000-000000005402';

/** Release labels for the caller's own endpoint products. Only these may stamp
 *  an attestation (§8.2) — the counterpart product's versions would be a 400,
 *  which is why the tab never fetches them. */
export const VENDOR_PRODUCT_VERSIONS_FIXTURE: Readonly<Record<string, readonly ProductVersion[]>> =
  {
    [PRIMARY_PRODUCT.id]: [
      {
        id: V_2025_2,
        product_id: PRIMARY_PRODUCT.id,
        label: '2025.2',
        released_at: '2025-09-01',
        sunset_at: null,
        sort_key: 20250200,
        created_at: '2025-09-01T00:00:00.000Z',
        updated_at: '2025-09-01T00:00:00.000Z',
      },
      {
        id: V_2026_1,
        product_id: PRIMARY_PRODUCT.id,
        label: '2026.1',
        released_at: '2026-03-15',
        sunset_at: null,
        sort_key: 20260100,
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      },
    ],
    [SECONDARY_PRODUCT.id]: [],
  };

/**
 * The attestable surface. Deliberately covers every state the §6 tab has to
 * render, because the preview is where this gets reviewed:
 *
 *  - all four `agreement` states, including a `conflict` whose counterparty note
 *    is visible (§6: a conflict must be legible from the vendor's side);
 *  - an `origin: 'aeci'` claim the vendor has not voted on;
 *  - a claim carrying a note **and** both version stamps, which is the fixture
 *    the PUT-replaces regression test needs;
 *  - an integration where the caller owns BOTH endpoints — `mine` has two
 *    entries and it must still read `single_source`, because one company is one
 *    voter no matter how many slots it fills;
 *  - an integration where the caller owns `vendor_b` only, so the direction
 *    framing is reviewable in the preview and not only in a unit test;
 *  - an integration with no claims at all, for the per-card empty state;
 *  - a null `name` and a null `mechanism_kind`, for the nullable paths.
 */
const INTEGRATION_PROCORE: VendorIntegration = {
  id: '00000000-0000-4000-8000-000000005310',
  name: 'Summit Model Coordination ↔ Procore',
  mechanism_kind: 'native',
  mechanism_name: 'Native connector',
  context_product: CONTEXT_PRIMARY,
  other_product: OTHER_PROCORE,
  slots: ['vendor_a'],
  claims: [
    {
      id: '00000000-0000-4000-8000-000000005321',
      integration_id: '00000000-0000-4000-8000-000000005310',
      data_object_slug: 'models',
      data_object_name: 'Models',
      direction: 'outbound',
      // Nobody has voted, and the claim came from AECi's own curation.
      agreement: 'unverified',
      origin: 'aeci',
      mine: [],
      counterparty: null,
    },
    {
      id: '00000000-0000-4000-8000-000000005322',
      integration_id: '00000000-0000-4000-8000-000000005310',
      data_object_slug: 'rfis',
      data_object_name: 'RFIs',
      direction: 'outbound',
      // One voter. Never `confirmed` — the counterparty's silence is not assent.
      agreement: 'single_source',
      origin: 'vendor',
      mine: [
        {
          slot: 'vendor_a',
          asserted: true,
          note: 'Only for RFIs created after 2025.',
          introduced_version_id: V_2025_2,
          deprecated_version_id: null,
          updated_at: '2026-08-01T10:00:00.000Z',
        },
      ],
      counterparty: null,
    },
    {
      id: '00000000-0000-4000-8000-000000005323',
      integration_id: '00000000-0000-4000-8000-000000005310',
      data_object_slug: 'submittals',
      data_object_name: 'Submittals',
      direction: 'inbound',
      agreement: 'confirmed',
      origin: 'vendor',
      mine: [
        {
          slot: 'vendor_a',
          asserted: true,
          note: null,
          introduced_version_id: null,
          deprecated_version_id: null,
          updated_at: '2026-08-02T10:00:00.000Z',
        },
      ],
      counterparty: { asserted: true, note: 'Two-way since our 2026 release.' },
    },
    {
      id: '00000000-0000-4000-8000-000000005324',
      integration_id: '00000000-0000-4000-8000-000000005310',
      data_object_slug: 'drawings',
      data_object_name: 'Drawings',
      direction: 'both',
      agreement: 'conflict',
      origin: 'vendor',
      mine: [
        {
          slot: 'vendor_a',
          asserted: true,
          note: 'Sheets sync both ways through the coordination workspace.',
          introduced_version_id: V_2026_1,
          deprecated_version_id: null,
          updated_at: '2026-08-05T10:00:00.000Z',
        },
      ],
      counterparty: { asserted: false, note: 'We do not ingest sheets from this tool.' },
    },
  ],
};

const INTEGRATION_BOTH_ENDPOINTS: VendorIntegration = {
  id: '00000000-0000-4000-8000-000000005311',
  name: null,
  mechanism_kind: 'api',
  mechanism_name: null,
  context_product: CONTEXT_PRIMARY,
  other_product: CONTEXT_SECONDARY,
  slots: ['vendor_a', 'vendor_b'],
  claims: [
    {
      id: '00000000-0000-4000-8000-000000005331',
      integration_id: '00000000-0000-4000-8000-000000005311',
      data_object_slug: 'punch-lists',
      data_object_name: 'Punch lists',
      direction: 'both',
      // TWO attestations, ONE voter: the agreement engine dedupes by attesting
      // vendor, so owning both endpoints cannot manufacture `confirmed`.
      agreement: 'single_source',
      origin: 'vendor',
      mine: [
        {
          slot: 'vendor_a',
          asserted: true,
          note: 'Rolls up into the coordination model.',
          introduced_version_id: V_2026_1,
          deprecated_version_id: null,
          updated_at: '2026-08-06T10:00:00.000Z',
        },
        {
          slot: 'vendor_b',
          asserted: true,
          note: 'Rolls up into the coordination model.',
          introduced_version_id: null,
          deprecated_version_id: null,
          updated_at: '2026-08-06T10:00:00.000Z',
        },
      ],
      counterparty: null,
    },
  ],
};

const INTEGRATION_VENDOR_B: VendorIntegration = {
  id: '00000000-0000-4000-8000-000000005312',
  name: 'Autodesk Build ↔ Summit Field Issues',
  mechanism_kind: 'marketplace-app',
  mechanism_name: 'Autodesk App Store listing',
  // The caller holds endpoint B here, so `context_product` is still ITS product
  // and `direction` is still framed outward from it. Nothing in the UI may reach
  // for `source`/`target`.
  context_product: CONTEXT_SECONDARY,
  other_product: OTHER_AUTODESK_BUILD,
  slots: ['vendor_b'],
  claims: [
    {
      id: '00000000-0000-4000-8000-000000005341',
      integration_id: '00000000-0000-4000-8000-000000005312',
      data_object_slug: 'documents',
      data_object_name: 'Documents',
      direction: 'inbound',
      agreement: 'unverified',
      origin: 'aeci',
      mine: [],
      counterparty: null,
    },
  ],
};

const INTEGRATION_NO_CLAIMS: VendorIntegration = {
  id: '00000000-0000-4000-8000-000000005313',
  name: null,
  mechanism_kind: null,
  mechanism_name: null,
  context_product: CONTEXT_SECONDARY,
  other_product: OTHER_PROCORE,
  slots: ['vendor_a'],
  claims: [],
};

export const VENDOR_INTEGRATIONS_FIXTURE: ListVendorIntegrationsResponse = {
  integrations: [
    INTEGRATION_PROCORE,
    INTEGRATION_BOTH_ENDPOINTS,
    INTEGRATION_VENDOR_B,
    INTEGRATION_NO_CLAIMS,
  ],
};

/** A vendor whose products carry no integrations. The API returns exactly this
 *  — a 200 with an empty list, never a 404. */
export const VENDOR_INTEGRATIONS_EMPTY_FIXTURE: ListVendorIntegrationsResponse = {
  integrations: [],
};

/**
 * The §7 detector ledger as the in-portal list reads it.
 *
 * `aeci-denied` is absent on purpose: it is an ops-routed signal whose ledger
 * rows carry `vendorId: null`, so it can never match a vendor caller. It stays
 * in the type union, so the UI's `switch` must remain total — but no fixture
 * should imply a vendor will ever see one.
 */
export const VENDOR_NOTIFICATIONS_FIXTURE: readonly VendorNotification[] = [
  {
    id: '00000000-0000-4000-8000-000000005351',
    detector: 'open-conflict',
    claim_id: '00000000-0000-4000-8000-000000005324',
    integration_id: INTEGRATION_PROCORE.id,
    data_object: { slug: 'drawings', name: 'Drawings' },
    counterpart_product: { slug: 'procore', name: 'Procore' },
    pair_path: '/products/procore/integrations/summit-model-coordination',
    created_at: '2026-08-06T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000005352',
    detector: 'silent-counterparty',
    claim_id: '00000000-0000-4000-8000-000000005322',
    integration_id: INTEGRATION_PROCORE.id,
    data_object: { slug: 'rfis', name: 'RFIs' },
    counterpart_product: { slug: 'procore', name: 'Procore' },
    pair_path: '/products/procore/integrations/summit-model-coordination',
    created_at: '2026-07-30T08:00:00.000Z',
  },
  {
    // The tolerant-mapper degrade case: an older row whose snapshot no longer
    // carries every field. It must still render, not disappear or throw.
    id: '00000000-0000-4000-8000-000000005353',
    detector: 'stale-version',
    claim_id: '00000000-0000-4000-8000-000000005331',
    integration_id: INTEGRATION_BOTH_ENDPOINTS.id,
    data_object: null,
    counterpart_product: null,
    pair_path: null,
    created_at: '2026-06-15T08:00:00.000Z',
  },
];
