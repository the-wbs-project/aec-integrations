import type { ProductsListResponse } from '@aeci/shared';

import { registerIndexPageSuite } from '../core/testing/index-page.harness';

import { ProductsIndex } from './products-index';

// The seven cases shared with the vendors index live in `index-page.harness.ts`
// (AECI-113); only the products fixture + config live here.
const fixtureResponse: ProductsListResponse = {
  data: [
    {
      id: '00000000-0000-4000-8000-000000020001',
      slug: 'procore',
      name: 'Procore',
      logo_url: null,
      product_role: 'application',
      vendor: {
        id: '00000000-0000-4000-8000-000000010001',
        name: 'Procore Technologies',
        slug: 'procore',
        logo_url: null,
      },
      primary_category: {
        id: '00000000-0000-4000-8000-000000030001',
        name: 'Project Management',
        slug: 'project-management',
      },
      integration_count: 12,
      review_count: 3,
      rating_overall_avg: 4.5,
      rating_onboarding_avg: 4.2,
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-06-15T00:00:00.000Z',
    },
  ],
  page: 1,
  perPage: 24,
  total: 1,
};

registerIndexPageSuite({
  describeName: 'ProductsIndex',
  component: ProductsIndex,
  routePath: 'products',
  apiUrl: '/api/products',
  defaultSort: 'created',
  h1Text: 'Products',
  detailHref: '/products/procore',
  emptyText: 'No products yet',
  errorText: "Couldn't load products",
  fixtureResponse,
});
