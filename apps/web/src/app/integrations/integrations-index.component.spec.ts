import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { IntegrationsListResponse } from '@aeci/shared';

import { IntegrationsIndex } from './integrations-index';

const PRODUCT_UUID = '00000000-0000-4000-8000-000000020001';

const fixtureResponse: IntegrationsListResponse = {
  data: [
    {
      id: '00000000-0000-4000-8000-000000030001',
      name: 'Revit → Navisworks',
      mechanism_kind: 'native',
      mechanism_name: 'Desktop Connector',
      direction: 'bidirectional',
      source: { id: 's1', slug: 'revit', name: 'Revit', logo_url: null },
      target: { id: 't1', slug: 'navisworks', name: 'Navisworks', logo_url: null },
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
      provideRouter([{ path: 'integrations', component: IntegrationsIndex }]),
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  return { httpMock, router };
}

describe('IntegrationsIndex', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('fetches /api/integrations with default page=1 / perPage=24 / sort=name on init', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (request) =>
        request.url === '/api/integrations' &&
        request.params.get('page') === '1' &&
        request.params.get('perPage') === '24' &&
        request.params.get('sort') === 'name',
    );
    expect(req.request.method).toBe('GET');
    req.flush(fixtureResponse);

    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain('Integrations');
    expect(
      root.querySelector('a[href="/integrations/00000000-0000-4000-8000-000000030001"]'),
    ).not.toBeNull();
    httpMock.verify();
  });

  it('defaults the Name column header to ascending and active', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(fixtureResponse);
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th[aria-sort]');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
    httpMock.verify();
  });

  it('falls back to sort=name when the URL carries an unknown sort key', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations?sort=banana');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(fixtureResponse);
    httpMock.verify();
  });

  it('passes ?sourceProductId / ?targetProductId from the URL through to the API request', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl(
      `/integrations?sourceProductId=${PRODUCT_UUID}&targetProductId=${PRODUCT_UUID}`,
    );
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (r) =>
        r.url === '/api/integrations' &&
        r.params.get('sourceProductId') === PRODUCT_UUID &&
        r.params.get('targetProductId') === PRODUCT_UUID,
    );
    req.flush(fixtureResponse);
    httpMock.verify();
  });

  it('applying a raw UUID in the source filter updates ?sourceProductId without a slug lookup', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const sourceInput = root.querySelector('#filter-source') as HTMLInputElement;
    sourceInput.value = PRODUCT_UUID;
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();

    expect(router.url).toContain(`sourceProductId=${PRODUCT_UUID}`);
    // A UUID is used directly — no /api/products/:slug resolution call.
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    httpMock.verify();
  });

  it('applying a slug in the source filter resolves it via /api/products/:slug then filters by the id', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const sourceInput = root.querySelector('#filter-source') as HTMLInputElement;
    sourceInput.value = 'revit';
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    // The slug is resolved to a product id first.
    httpMock.expectOne('/api/products/revit').flush({ id: PRODUCT_UUID });
    await fixture.whenStable();

    expect(router.url).toContain(`sourceProductId=${PRODUCT_UUID}`);
    httpMock
      .expectOne(
        (r) => r.url === '/api/integrations' && r.params.get('sourceProductId') === PRODUCT_UUID,
      )
      .flush(fixtureResponse);
    httpMock.verify();
  });

  it('shows a no-match message and drops the filter when a slug does not resolve', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const sourceInput = root.querySelector('#filter-source') as HTMLInputElement;
    sourceInput.value = 'does-not-exist';
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    httpMock
      .expectOne('/api/products/does-not-exist')
      .flush(
        { error: { code: 'NOT_FOUND', message: 'missing' }, trace_id: 'x' },
        { status: 404, statusText: 'Not Found' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root.querySelector('#filter-source-error')?.textContent).toContain('does-not-exist');
    expect(router.url).not.toContain('sourceProductId');
    // The navigation still fires (page reset), so flush any refetch.
    for (const r of httpMock.match((req) => req.url === '/api/integrations'))
      r.flush(fixtureResponse);
    httpMock.verify();
  });

  it('shows the error row (not a no-match message) when the slug lookup returns a 500', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const sourceInput = root.querySelector('#filter-source') as HTMLInputElement;
    sourceInput.value = 'revit';
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    httpMock
      .expectOne('/api/products/revit')
      .flush(
        { error: { code: 'INTERNAL_ERROR', message: 'db unreachable' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    // A server error must NOT show "No product matches" — that would mislead
    // the user into thinking their slug is wrong when it's the server that failed.
    expect(root.querySelector('#filter-source-error')).toBeNull();
    // The table error row must appear.
    const errorRow = root.querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load integrations");
    // URL must not have gained a filter param.
    expect(router.url).not.toContain('sourceProductId');
    httpMock.verify();
  });

  it('shows the empty state when the API returns zero integrations', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === '/api/integrations')
      .flush({ data: [], page: 1, perPage: 24, total: 0 });
    fixture.detectChanges();

    const emptyRow = (fixture.nativeElement as HTMLElement).querySelector('tbody td');
    expect(emptyRow?.textContent).toContain('No integrations match');
    httpMock.verify();
  });

  it('renders the error row when the request fails', async () => {
    const { httpMock, router } = setup();
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === '/api/integrations')
      .flush(
        { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    fixture.detectChanges();

    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain("Couldn't load integrations");
    httpMock.verify();
  });
});
