/**
 * Fixtures for the portal "Proposed products" tab (AECI-1417, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.22), shared by the dev-only preview (`/preview/vendor-dashboard/proposals`) and the
 * component specs.
 *
 * Two proposals, so the tab shows both shapes: one whose every value resolves and that
 * names a co-maker, and one with values that would be dropped and a company that no
 * longer exists, so its Accept is unavailable.
 */
import type { VendorProposal } from '@aeci/shared';

export const VENDOR_PROPOSALS_FIXTURE: readonly VendorProposal[] = [
  {
    id: '00000000-0000-4000-8000-000000006101',
    proposed_at: '2026-10-17T09:30:00.000Z',
    product: {
      name: 'Summit Clash Review',
      description_excerpt:
        'Runs clash detection on federated models and routes each clash to the trade that owns it.',
      website: 'https://summitbim.example/clash-review',
      product_role: 'application',
    },
    vendors: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        name: 'Summit BIM',
        is_primary: true,
        owned: true,
        exists: true,
      },
      {
        id: '00000000-0000-4000-8000-000000000199',
        name: 'Northwind Estimating',
        is_primary: false,
        owned: false,
        exists: true,
      },
    ],
    terms: [
      { facet: 'category', value: 'Model Coordination', name: 'Model Coordination', exists: true },
      {
        facet: 'audience',
        value: 'General Contractors',
        name: 'General Contractors',
        exists: true,
      },
      { facet: 'phase', value: 'Preconstruction', name: 'Preconstruction', exists: true },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000006102',
    proposed_at: '2026-10-18T14:05:00.000Z',
    product: {
      name: 'Summit Field Capture',
      description_excerpt: null,
      website: null,
      product_role: 'application',
    },
    vendors: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        name: 'Summit BIM',
        is_primary: true,
        owned: true,
        exists: true,
      },
      {
        id: '00000000-0000-4000-8000-000000000198',
        name: 'Retired Partner Co',
        is_primary: false,
        owned: false,
        exists: false,
      },
    ],
    terms: [
      { facet: 'category', value: 'Reality Capture', name: 'Reality Capture', exists: true },
      { facet: 'category', value: 'Drone Ops', name: null, exists: false },
      { facet: 'trade', value: 'Surveying', name: null, exists: false },
    ],
  },
];
