/**
 * Curated AEC product fixtures for the `/preview/search-relevance` harness
 * (AECI-286). Shaped to the §7.1 `AlgoliaProductRecord` so the real
 * `SearchProductCard` renders them, with NO Algolia/staging dependency — the
 * harness runs in any workspace.
 *
 * The signals are deliberately spread so the candidate strategies diverge
 * visibly (see `ranking-strategies.ts`):
 *  - `procore` has dominant coverage (62) but middling rating;
 *  - `revit` / `bluebeam-revu` are highly rated with modest coverage, so
 *    Ratings-forward promotes them above Baseline's coverage order;
 *  - `proest` / `trimble-connect` carry `rating_overall_avg: null` /
 *    `review_count: 0` to mimic the §6 pre-Phase-5 "no reviews yet" state;
 *  - Coverage-weighted can lift a heavily-integrated product above a closer text
 *    match (e.g. `trimble-connect` over the exact-name match `fieldwire` on "field").
 *
 * These are illustrative, not the live catalog.
 */
import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

function product(
  n: number,
  fields: Omit<AlgoliaProductRecord, 'objectID' | 'logo_url'>,
): AlgoliaProductRecord {
  return {
    objectID: `aec00000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    logo_url: null,
    ...fields,
  };
}

export const FIXTURE_PRODUCTS: readonly AlgoliaProductRecord[] = [
  product(1, {
    name: 'Procore',
    slug: 'procore',
    vendor_name: 'Procore Technologies',
    vendor_slug: 'procore-technologies',
    description:
      'Construction project management platform for RFIs, submittals, scheduling, and field coordination.',
    categories: ['Project Management', 'Construction Management'],
    audiences: ['General Contractors', 'Owners'],
    phases: ['Construction'],
    integration_count: 62,
    review_count: 48,
    rating_overall_avg: 4.3,
    has_api_docs: true,
  }),
  product(2, {
    name: 'Autodesk Construction Cloud',
    slug: 'autodesk-construction-cloud',
    vendor_name: 'Autodesk',
    vendor_slug: 'autodesk',
    description:
      'Connected BIM and document management for design coordination and construction handover.',
    categories: ['BIM', 'Document Control'],
    audiences: ['General Contractors', 'Architects'],
    phases: ['Design', 'Construction'],
    integration_count: 54,
    review_count: 31,
    rating_overall_avg: 4.1,
    has_api_docs: true,
  }),
  product(3, {
    name: 'Revit',
    slug: 'revit',
    vendor_name: 'Autodesk',
    vendor_slug: 'autodesk',
    description: 'BIM authoring for architecture, structure, and MEP with model coordination.',
    categories: ['BIM', 'Design Authoring'],
    audiences: ['Architects', 'Engineers'],
    phases: ['Design'],
    integration_count: 40,
    review_count: 60,
    rating_overall_avg: 4.5,
    has_api_docs: true,
  }),
  product(4, {
    name: 'Navisworks',
    slug: 'navisworks',
    vendor_name: 'Autodesk',
    vendor_slug: 'autodesk',
    description: 'Model review and clash detection for BIM coordination across disciplines.',
    categories: ['BIM', 'Clash Detection'],
    audiences: ['BIM Managers', 'VDC'],
    phases: ['Design', 'Preconstruction'],
    integration_count: 22,
    review_count: 18,
    rating_overall_avg: 4.0,
    has_api_docs: false,
  }),
  product(5, {
    name: 'Bluebeam Revu',
    slug: 'bluebeam-revu',
    vendor_name: 'Bluebeam',
    vendor_slug: 'bluebeam',
    description: 'PDF markup, takeoff, and document collaboration for construction teams.',
    categories: ['Document Control', 'Markup'],
    audiences: ['General Contractors', 'Subcontractors'],
    phases: ['Preconstruction', 'Construction'],
    integration_count: 17,
    review_count: 40,
    rating_overall_avg: 4.6,
    has_api_docs: true,
  }),
  product(6, {
    name: 'PlanGrid',
    slug: 'plangrid',
    vendor_name: 'Autodesk',
    vendor_slug: 'autodesk',
    description: 'Construction drawings and field reporting in the field.',
    categories: ['Field Reporting', 'Document Control'],
    audiences: ['Field Teams'],
    phases: ['Construction'],
    integration_count: 9,
    review_count: 12,
    rating_overall_avg: 3.8,
    has_api_docs: true,
  }),
  product(7, {
    name: 'Fieldwire',
    slug: 'fieldwire',
    vendor_name: 'Hilti',
    vendor_slug: 'hilti',
    description: 'Field coordination, punch lists, and task management for jobsite crews.',
    categories: ['Field Reporting', 'Task Management'],
    audiences: ['Field Teams', 'Foremen'],
    phases: ['Construction'],
    integration_count: 6,
    review_count: 9,
    rating_overall_avg: 4.4,
    has_api_docs: true,
  }),
  product(8, {
    name: 'Newforma',
    slug: 'newforma',
    vendor_name: 'Newforma',
    vendor_slug: 'newforma',
    description: 'Project information management connecting email, documents, and RFIs.',
    categories: ['Project Information', 'Email Management'],
    audiences: ['Architects', 'Engineers'],
    phases: ['Design'],
    integration_count: 4,
    review_count: 5,
    rating_overall_avg: 3.6,
    has_api_docs: false,
  }),
  product(9, {
    name: 'Buildertrend',
    slug: 'buildertrend',
    vendor_name: 'Buildertrend',
    vendor_slug: 'buildertrend',
    description:
      'Residential construction management with scheduling, budgeting, and client portals.',
    categories: ['Construction Management', 'Scheduling'],
    audiences: ['Home Builders', 'Remodelers'],
    phases: ['Construction'],
    integration_count: 3,
    review_count: 27,
    rating_overall_avg: 4.2,
    has_api_docs: true,
  }),
  product(10, {
    name: 'STACK',
    slug: 'stack',
    vendor_name: 'STACK Construction Technologies',
    vendor_slug: 'stack-construction-technologies',
    description: 'Cloud takeoff and estimating for preconstruction bids.',
    categories: ['Estimating', 'Takeoff'],
    audiences: ['Estimators', 'General Contractors'],
    phases: ['Preconstruction'],
    integration_count: 5,
    review_count: 14,
    rating_overall_avg: 4.5,
    has_api_docs: true,
  }),
  product(11, {
    name: 'ProEst',
    slug: 'proest',
    vendor_name: 'Autodesk',
    vendor_slug: 'autodesk',
    description: 'Estimating and digital takeoff for accurate construction bids.',
    categories: ['Estimating'],
    audiences: ['Estimators'],
    phases: ['Preconstruction'],
    integration_count: 7,
    review_count: 0,
    rating_overall_avg: null,
    has_api_docs: true,
  }),
  product(12, {
    name: 'Trimble Connect',
    slug: 'trimble-connect',
    vendor_name: 'Trimble',
    vendor_slug: 'trimble',
    description: 'Common data environment for BIM collaboration and constructible models.',
    categories: ['BIM', 'Collaboration'],
    audiences: ['BIM Managers', 'Field Teams'],
    phases: ['Design', 'Construction'],
    integration_count: 19,
    review_count: 0,
    rating_overall_avg: null,
    has_api_docs: true,
  }),
  product(13, {
    name: 'ProjectWise',
    slug: 'projectwise',
    vendor_name: 'Bentley Systems',
    vendor_slug: 'bentley-systems',
    description: 'Engineering document management and design coordination for infrastructure.',
    categories: ['Document Control', 'BIM'],
    audiences: ['Engineers', 'Owners'],
    phases: ['Design'],
    integration_count: 12,
    review_count: 4,
    rating_overall_avg: 3.7,
    has_api_docs: true,
  }),
  product(14, {
    name: 'Smartsheet',
    slug: 'smartsheet',
    vendor_name: 'Smartsheet',
    vendor_slug: 'smartsheet',
    description: 'Work management and scheduling adapted for construction project tracking.',
    categories: ['Project Management', 'Scheduling'],
    audiences: ['Owners', 'Project Managers'],
    phases: ['Planning', 'Construction'],
    integration_count: 28,
    review_count: 22,
    rating_overall_avg: 4.1,
    has_api_docs: true,
  }),
];

export interface QueryPreset {
  readonly label: string;
  readonly value: string;
}

/** Representative queries chosen to make the strategies diverge visibly. */
export const REPRESENTATIVE_QUERIES: readonly QueryPreset[] = [
  { label: 'bim coordination', value: 'bim coordination' },
  { label: 'estimating', value: 'estimating' },
  { label: 'scheduling', value: 'scheduling' },
  { label: 'document control', value: 'document control' },
  { label: 'field', value: 'field' },
  { label: 'procore', value: 'procore' },
  { label: 'Browse (no query)', value: '' },
];
