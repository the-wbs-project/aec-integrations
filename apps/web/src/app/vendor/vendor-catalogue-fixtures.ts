/**
 * Fixtures for the connector catalogue seat's Catalogue tab (AECI-1083), used by the
 * dev-only `/preview/vendor-dashboard` and by the component specs. Kept beside
 * `vendor-fixtures.ts` rather than in it, because that file is already long and
 * these are one screen's data.
 */
import type {
  VendorConnectorListing,
  VendorConnectorMapping,
  VendorMeResponse,
} from '@aeci/shared';

import { VENDOR_ME_CONNECTOR_SEAT_FIXTURE } from './vendor-fixtures';

/**
 * The same seat as {@link VENDOR_ME_CONNECTOR_SEAT_FIXTURE}, on a catalogue the
 * review lane still writes (`managed_by = 'review'`). A different product id and the
 * same slug, so `…/products/agave/catalogue` shows both states in the preview.
 */
export const VENDOR_ME_CONNECTOR_SEAT_REVIEW_FIXTURE: VendorMeResponse = {
  ...VENDOR_ME_CONNECTOR_SEAT_FIXTURE,
  products: [
    {
      ...VENDOR_ME_CONNECTOR_SEAT_FIXTURE.products[0]!,
      id: '00000000-0000-4000-8000-000000005232',
    },
  ],
};

/** The preview's stored catalogue: the header facts plus every live listing. The
 *  preview API derives the summary counts and pages from this, as the server does. */
export interface ConnectorCatalogFixture {
  readonly id: string;
  readonly managed_by: 'review' | 'vendor';
  readonly last_ingested_at: string | null;
  readonly listings: readonly VendorConnectorListing[];
}

const product = (n: string, slug: string, name: string) => ({
  id: `00000000-0000-4000-8000-00000000${n}`,
  slug,
  name,
});

/** Products the catalogue maps to. The first six are the preview's public product
 *  search results, so an edit can pick any of them. */
const P = {
  procore: product('5301', 'procore', 'Procore'),
  autodeskBuild: product('5302', 'autodesk-build', 'Autodesk Build'),
  acumatica: product('5303', 'acumatica', 'Acumatica'),
  procurepro: product('5304', 'procurepro', 'ProcurePro'),
  bluebeam: product('5305', 'bluebeam-revu', 'Bluebeam Revu'),
  sageIntacct: product('5306', 'sage-intacct', 'Sage Intacct'),
  viewpoint: product('5528', 'viewpoint-vista', 'Viewpoint Vista'),
  deltek: product('5525', 'deltek-vantagepoint', 'Deltek Vantagepoint'),
  egnyte: product('5526', 'egnyte', 'Egnyte'),
  msProject: product('5527', 'microsoft-project', 'Microsoft Project'),
};

type Seed = Pick<VendorConnectorMapping, 'status' | 'product' | 'decided_by'> &
  Partial<Pick<VendorConnectorMapping, 'confidence' | 'evidence_url'>>;

const ev = (slug: string) => `https://agave.example.com/integrations/${slug}`;

/**
 * One listing per row: `[slug, label, mappings]`. Thirty of them, so the tab pages
 * (25 a page), and every status and decider appears at least once, including
 * listings with no match, one with two matches, and a matched row whose product was
 * deleted.
 */
const ROWS: ReadonlyArray<readonly [string, string | null, readonly Seed[]]> = [
  [
    'procore',
    'Procore',
    [
      {
        status: 'mapped',
        product: P.procore,
        decided_by: 'aeci',
        confidence: 'high',
        evidence_url: ev('procore'),
      },
    ],
  ],
  [
    'autodesk-construction-cloud',
    'Autodesk Construction Cloud',
    [{ status: 'mapped', product: P.autodeskBuild, decided_by: 'automatic', confidence: 'medium' }],
  ],
  [
    'acumatica',
    'Acumatica Construction Edition',
    [{ status: 'mapped', product: P.acumatica, decided_by: 'vendor', confidence: 'high' }],
  ],
  [
    'procurepro',
    'ProcurePro',
    [{ status: 'mapped', product: P.procurepro, decided_by: 'aeci', confidence: 'high' }],
  ],
  [
    'bluebeam',
    'Bluebeam',
    [{ status: 'mapped', product: P.bluebeam, decided_by: 'automatic', confidence: 'low' }],
  ],
  [
    'sage-300-cre',
    'Sage 300 CRE',
    [{ status: 'ruled_out', product: P.sageIntacct, decided_by: 'aeci', confidence: 'high' }],
  ],
  [
    'sage-intacct',
    'Sage Intacct',
    [{ status: 'mapped', product: P.sageIntacct, decided_by: 'aeci', confidence: 'high' }],
  ],
  [
    'viewpoint-vista',
    'Viewpoint Vista',
    [{ status: 'mapped', product: P.viewpoint, decided_by: 'aeci', confidence: 'medium' }],
  ],
  [
    'viewpoint-spectrum',
    'Viewpoint Spectrum',
    [{ status: 'no_record', product: null, decided_by: 'aeci' }],
  ],
  [
    'deltek-vantagepoint',
    'Deltek Vantagepoint',
    [{ status: 'mapped', product: P.deltek, decided_by: 'automatic', confidence: 'medium' }],
  ],
  [
    'egnyte',
    'Egnyte',
    [{ status: 'mapped', product: P.egnyte, decided_by: 'aeci', confidence: 'high' }],
  ],
  [
    'microsoft-project',
    'Microsoft Project',
    [{ status: 'mapped', product: P.msProject, decided_by: 'automatic', confidence: 'medium' }],
  ],
  [
    'quickbooks-online',
    'QuickBooks Online',
    [{ status: 'out_of_scope', product: null, decided_by: 'aeci' }],
  ],
  ['salesforce', 'Salesforce', [{ status: 'out_of_scope', product: null, decided_by: 'aeci' }]],
  ['cmic', 'CMiC', []],
  [
    'foundation-software',
    'Foundation Software',
    [{ status: 'ambiguous_parked', product: null, decided_by: 'aeci' }],
  ],
  ['jonas-construction', 'Jonas Construction', []],
  ['hh2', 'hh2', [{ status: 'no_record', product: null, decided_by: 'automatic' }]],
  [
    'autodesk-build',
    'Autodesk Build',
    [
      {
        status: 'mapped',
        product: P.autodeskBuild,
        decided_by: 'vendor',
        confidence: 'high',
        evidence_url: ev('autodesk-build'),
      },
      { status: 'ruled_out', product: P.procore, decided_by: 'vendor', confidence: 'high' },
    ],
  ],
  [
    'legacy-erp',
    'Legacy ERP connector',
    [{ status: 'mapped', product: null, decided_by: 'aeci', confidence: 'low' }],
  ],
  ['spectrum-data-exchange', null, []],
  [
    'trimble-viewpoint-team',
    'Trimble Viewpoint Team',
    [{ status: 'ambiguous_parked', product: null, decided_by: 'automatic' }],
  ],
  ['netsuite', 'NetSuite', [{ status: 'out_of_scope', product: null, decided_by: 'vendor' }]],
  ['sage-100-contractor', 'Sage 100 Contractor', []],
  ['e-builder', 'e-Builder', [{ status: 'no_record', product: null, decided_by: 'aeci' }]],
  ['p6', 'Oracle Primavera P6', [{ status: 'no_record', product: null, decided_by: 'aeci' }]],
  ['smartsheet', 'Smartsheet', [{ status: 'out_of_scope', product: null, decided_by: 'aeci' }]],
  ['buildertrend', 'Buildertrend', []],
  ['kojo', 'Kojo', [{ status: 'no_record', product: null, decided_by: 'automatic' }]],
  ['workmax', 'WorkMax', []],
];

/** Every listing, with ids stemmed by `prefix` so the two presets never share one. */
export function catalogueListings(prefix: string): VendorConnectorListing[] {
  return ROWS.map(([slug, label, seeds], i) => {
    const n = String(i).padStart(2, '0');
    return {
      id: `${prefix}-st-${n}`,
      slug,
      label,
      url: ev(slug),
      mappings: seeds.map((m, j) => ({
        id: `${prefix}-map-${n}-${j}`,
        status: m.status,
        product: m.product,
        confidence: m.confidence ?? null,
        evidence_url: m.evidence_url ?? null,
        decided_by: m.decided_by,
        decided_at: m.decided_by === 'automatic' ? null : '2026-09-10T15:00:00.000Z',
        // §9a.4's gate, applied here the way the server applies it.
        publishable: m.status === 'mapped' && m.product !== null && m.decided_by !== 'automatic',
      })),
    };
  });
}

/** `GET /api/vendor/products/:id/connector-catalog`, keyed by product id. */
export const VENDOR_CONNECTOR_CATALOG_FIXTURE: Readonly<Record<string, ConnectorCatalogFixture>> = {
  // Vendor-managed: the seat maintains it, and every match has Edit.
  [VENDOR_ME_CONNECTOR_SEAT_FIXTURE.products[0]!.id]: {
    id: 'rec-agave-catalog',
    managed_by: 'vendor',
    last_ingested_at: '2026-09-20T06:00:00.000Z',
    listings: catalogueListings('agv'),
  },
  // Review-managed: the AECi team still maintains it, so the tab is read-only.
  [VENDOR_ME_CONNECTOR_SEAT_REVIEW_FIXTURE.products[0]!.id]: {
    id: 'rec-agave-catalog-review',
    managed_by: 'review',
    last_ingested_at: '2026-09-20T06:00:00.000Z',
    listings: catalogueListings('agr'),
  },
};
