import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { IntegrationsListResponse } from '@aeci/shared';

import {
  createIndexSetup,
  registerIndexCommonCases,
  settle,
} from '../core/testing/index-page.harness';

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

// The four cases common to all three index pages live in `index-page.harness.ts`
// (AECI-113). Integration defaults to sort=name and has source/target filtering
// that products/vendors lack, so its sort/header + filter cases stay here.
registerIndexCommonCases({
  describeName: 'IntegrationsIndex',
  component: IntegrationsIndex,
  routePath: 'integrations',
  apiUrl: '/api/integrations',
  defaultSort: 'name',
  h1Text: 'Integrations',
  detailHref: '/integrations/00000000-0000-4000-8000-000000030001',
  emptyText: 'No integrations match',
  errorText: "Couldn't load integrations",
  fixtureResponse,
});

describe('IntegrationsIndex — sort header + source/target filters', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('defaults the Name column header to ascending and active', async () => {
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
    await router.navigateByUrl('/integrations');
    const fixture = TestBed.createComponent(IntegrationsIndex);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(fixtureResponse);
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th[aria-sort]');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
    httpMock.verify();
  });

  it('passes ?sourceProductId / ?targetProductId from the URL through to the API request', async () => {
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
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
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
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
    await settle();

    expect(router.url).toContain(`sourceProductId=${PRODUCT_UUID}`);
    // A UUID is used directly — no /api/products/:slug resolution call. The
    // navigation re-dispatches the resource on the next change detection.
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/integrations').flush(fixtureResponse);
    await settle();
    httpMock.verify();
  });

  it('applying a slug in the source filter resolves it via /api/products/:slug then filters by the id', async () => {
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
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
    await settle();

    expect(router.url).toContain(`sourceProductId=${PRODUCT_UUID}`);
    // The navigation re-dispatches the resource on the next change detection.
    fixture.detectChanges();
    httpMock
      .expectOne(
        (r) => r.url === '/api/integrations' && r.params.get('sourceProductId') === PRODUCT_UUID,
      )
      .flush(fixtureResponse);
    await settle();
    httpMock.verify();
  });

  it('shows a no-match message and drops the filter when a slug does not resolve', async () => {
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
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
    await settle();
    fixture.detectChanges();

    expect(root.querySelector('#filter-source-error')?.textContent).toContain('does-not-exist');
    expect(router.url).not.toContain('sourceProductId');
    // The navigation still fires (page reset), so flush any refetch.
    for (const r of httpMock.match((req) => req.url === '/api/integrations'))
      r.flush(fixtureResponse);
    httpMock.verify();
  });

  it('shows the error row (not a no-match message) when the slug lookup returns a 500', async () => {
    const { httpMock, router } = createIndexSetup(IntegrationsIndex, 'integrations');
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
    await settle();
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
});
