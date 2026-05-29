import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorsListResponse } from '@aeci/shared';

import { VendorsIndex } from './vendors-index';

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

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'vendors', component: VendorsIndex }]),
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  return { httpMock, router };
}

describe('VendorsIndex', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('fetches /api/vendors with default page=1 / perPage=24 / sort=created on init', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (request) =>
        request.url === '/api/vendors' &&
        request.params.get('page') === '1' &&
        request.params.get('perPage') === '24' &&
        request.params.get('sort') === 'created',
    );
    expect(req.request.method).toBe('GET');
    req.flush(fixtureResponse);

    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain('Vendors');
    expect(root.querySelector('a[href="/vendors/procore"]')).not.toBeNull();
    httpMock.verify();
  });

  it('reads ?sort=name from the URL and reflects it in the column header active state', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors?sort=name');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.params.get('sort') === 'name');
    req.flush(fixtureResponse);
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th[aria-sort]');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
    httpMock.verify();
  });

  it('falls back to sort=created when the URL carries an unknown sort key', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors?sort=banana');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'created').flush(fixtureResponse);
    httpMock.verify();
  });

  it('navigates with ?sort=name&page=1 when a sortable header is activated', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors?page=3');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '3').flush(fixtureResponse);
    fixture.detectChanges();

    const nameHeaderButton = (fixture.nativeElement as HTMLElement).querySelector(
      'aec-sortable-column-header button',
    ) as HTMLButtonElement;
    nameHeaderButton.click();
    await fixture.whenStable();

    expect(router.url).toBe('/vendors?page=1&sort=name');
    httpMock.expectOne((r) => r.url === '/api/vendors').flush(fixtureResponse);
    httpMock.verify();
  });

  it('shows the error row when a subsequent request fails after an initial success', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/vendors').flush(fixtureResponse);
    fixture.detectChanges();

    await router.navigateByUrl('/vendors?page=2');
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === '/api/vendors')
      .flush(
        { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    fixture.detectChanges();

    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load vendors");
    httpMock.verify();
  });

  it('renders the error row when the request fails', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/vendors');
    req.flush(
      { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
      {
        status: 500,
        statusText: 'Server Error',
      },
    );
    fixture.detectChanges();

    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load vendors");
    httpMock.verify();
  });

  it('shows the empty state when the API returns zero vendors', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/vendors');
    const fixture = TestBed.createComponent(VendorsIndex);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === '/api/vendors')
      .flush({ data: [], page: 1, perPage: 24, total: 0 });
    fixture.detectChanges();

    const emptyRow = (fixture.nativeElement as HTMLElement).querySelector('tbody td');
    expect(emptyRow?.textContent).toContain('No vendors yet');
    httpMock.verify();
  });
});
