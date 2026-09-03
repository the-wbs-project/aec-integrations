import { TestBed } from '@angular/core/testing';

import type { ProductsListResponse } from '@aeci/shared';

import {
  createIndexSetup,
  registerIndexPageSuite,
  settle,
} from '../core/testing/index-page.harness';

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
        verified: false,
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
  emptyText: 'No products match these filters',
  errorText: "Couldn't load products",
  fixtureResponse,
  // AECI-143 — the index now renders the API-backed facet sidebar, which fetches
  // scoped counts from `/api/products/facets`; the harness drains that request.
  facetsUrl: '/api/products/facets',
});

// Products-only: the two review-driven sorts are unique to this index (the
// shared harness only exercises the generic `name` sort).
describe('ProductsIndex review-driven sort options', () => {
  it('offers "Highest rated" and "Most reviewed" in the sort dropdown', async () => {
    const { httpMock, router } = createIndexSetup(ProductsIndex, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/products').flush(fixtureResponse);
    await settle();
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector('select');
    const options = Array.from(select?.querySelectorAll('option') ?? []).map((o) => ({
      value: o.value,
      label: o.textContent?.trim(),
    }));
    expect(options).toEqual(
      expect.arrayContaining([
        { value: 'rating', label: 'Highest rated' },
        { value: 'reviews', label: 'Most reviewed' },
      ]),
    );

    for (const req of httpMock.match((r) => r.url === '/api/products/facets')) {
      req.flush({ categories: [], audiences: [], phases: [], trades: [] });
    }
    httpMock.verify();
  });
});
