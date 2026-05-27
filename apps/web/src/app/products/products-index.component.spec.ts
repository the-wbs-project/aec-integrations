import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductsListResponse } from '@aeci/shared';

import { ProductsIndex } from './products-index';

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

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'products', component: ProductsIndex }]),
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  return { httpMock, router };
}

describe('ProductsIndex', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('fetches /api/products with default page=1 / perPage=24 / sort=created on init', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (request) =>
        request.url === '/api/products' &&
        request.params.get('page') === '1' &&
        request.params.get('perPage') === '24' &&
        request.params.get('sort') === 'created',
    );
    expect(req.request.method).toBe('GET');
    req.flush(fixtureResponse);

    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain('Products');
    expect(root.querySelector('a[href="/products/procore"]')).not.toBeNull();
    httpMock.verify();
  });

  it('reads ?sort=name from the URL and reflects it in the column header active state', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products?sort=name');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.params.get('sort') === 'name');
    req.flush(fixtureResponse);
    fixture.detectChanges();

    // name sorts ascending (A→Z), so aria-sort must be "ascending".
    const th = (fixture.nativeElement as HTMLElement).querySelector('th[aria-sort]');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
    httpMock.verify();
  });

  it('falls back to sort=created when the URL carries an unknown sort key', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products?sort=banana');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'created').flush(fixtureResponse);
    httpMock.verify();
  });

  it('navigates with ?sort=name&page=1 when a sortable header is activated', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products?page=3');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '3').flush(fixtureResponse);
    fixture.detectChanges();

    const nameHeaderButton = (fixture.nativeElement as HTMLElement).querySelector(
      'aec-sortable-column-header button',
    ) as HTMLButtonElement;
    nameHeaderButton.click();
    await fixture.whenStable();

    // Sort change resets to page 1.
    expect(router.url).toBe('/products?page=1&sort=name');
    // Allow the resulting second request to drain so the controller verifies clean.
    httpMock.expectOne((r) => r.url === '/api/products').flush(fixtureResponse);
    httpMock.verify();
  });

  it('shows the error row when a subsequent request fails after an initial success', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    // First request succeeds — data is now non-null.
    httpMock.expectOne((r) => r.url === '/api/products').flush(fixtureResponse);
    fixture.detectChanges();

    // Navigate to page 2.
    await router.navigateByUrl('/products?page=2');
    fixture.detectChanges();

    // Second request fails.
    httpMock.expectOne((r) => r.url === '/api/products').flush(
      { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
      { status: 500, statusText: 'Server Error' },
    );
    fixture.detectChanges();

    // The error row must be visible; stale page-1 data must not be shown.
    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load products");
    httpMock.verify();
  });

  it('renders the error row when the request fails', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/products');
    req.flush(
      { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
      {
        status: 500,
        statusText: 'Server Error',
      },
    );
    fixture.detectChanges();

    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load products");
    httpMock.verify();
  });

  it('shows the empty state when the API returns zero products', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(ProductsIndex);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === '/api/products')
      .flush({ data: [], page: 1, perPage: 24, total: 0 });
    fixture.detectChanges();

    const emptyRow = (fixture.nativeElement as HTMLElement).querySelector('tbody td');
    expect(emptyRow?.textContent).toContain('No products yet');
    httpMock.verify();
  });
});
