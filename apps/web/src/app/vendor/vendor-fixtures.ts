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
  TaxonomyResponse,
  TaxonomyTermWithCount,
  VendorMeResponse,
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
