import type { VendorsListResponse } from '@aeci/shared';

import { registerIndexPageSuite } from '../core/testing/index-page.harness';

import { VendorsIndex } from './vendors-index';

// The seven cases shared with the products index live in `index-page.harness.ts`
// (AECI-113); only the vendors fixture + config live here.
const fixtureResponse: VendorsListResponse = {
  data: [
    {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      company_name: 'Procore Technologies',
      logo_url: null,
      verified: true,
      headquarters: 'Carpinteria, CA',
      founded_year: 2002,
      product_count: 3,
      integration_count: 12,
      review_count: 0,
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-06-15T00:00:00.000Z',
    },
  ],
  page: 1,
  perPage: 24,
  total: 1,
};

registerIndexPageSuite({
  describeName: 'VendorsIndex',
  component: VendorsIndex,
  routePath: 'vendors',
  apiUrl: '/api/vendors',
  defaultSort: 'created',
  h1Text: 'Vendors',
  detailHref: '/vendors/procore',
  emptyText: 'No vendors yet',
  errorText: "Couldn't load vendors",
  fixtureResponse,
});
