import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PaginatedResponse } from '@aeci/shared';

import { createIndexSetup } from '../../core/testing/index-page.harness';

import { type PaginatedIndex, createPaginatedIndex } from './paginated-index-controller';

type Row = { id: string };
type Resp = PaginatedResponse<Row>;

const FIXTURE: Resp = { data: [{ id: 'r1' }], page: 1, perPage: 24, total: 1 };
const ERROR_BODY = { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' };
const SERVER_ERROR = { status: 500, statusText: 'Server Error' };

/**
 * Host for exercising the shared `createPaginatedIndex` pipeline directly (the
 * "one set of tests" for the logic per AECI-107). It registers `created` and
 * `name` as valid sorts (default `created`) and one passthrough param,
 * mirroring how the real index pages configure the controller. It reuses the
 * AECI-113 `createIndexSetup` TestBed helper so the wiring matches the
 * entity-component specs.
 */
@Component({
  template: `
    @if (idx.data(); as response) {
      <span class="total">{{ response.total }}</span>
    }
    @if (idx.error()) {
      <span class="error">error</span>
    }
    <span class="sort">{{ idx.sort() }}</span>
  `,
})
class TestPaginatedIndexHost {
  readonly idx: PaginatedIndex<Resp> = createPaginatedIndex<Resp>({
    apiPath: '/api/test',
    validSorts: new Set(['created', 'name']),
    defaultSort: 'created',
    passthroughParams: ['sourceProductId'],
    meta: {
      entity: 'index',
      name: 'Test',
      description: null,
      canonical: 'https://aecintegrations.com/test',
    },
  });
}

describe('createPaginatedIndex', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('fetches the configured apiPath with default page/perPage/sort on construction', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (r) =>
        r.url === '/api/test' &&
        r.params.get('page') === '1' &&
        r.params.get('perPage') === '24' &&
        r.params.get('sort') === 'created',
    );
    expect(req.request.method).toBe('GET');
    req.flush(FIXTURE);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.total')?.textContent).toBe('1');
    httpMock.verify();
  });

  it('reflects a valid ?sort from the URL in sort()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sort=name');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(FIXTURE);
    expect(fixture.componentInstance.idx.sort()).toBe('name');
    httpMock.verify();
  });

  it('falls back to the default sort for an unknown ?sort', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sort=banana');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'created').flush(FIXTURE);
    expect(fixture.componentInstance.idx.sort()).toBe('created');
    httpMock.verify();
  });

  it('forwards a present passthrough param to the request and surfaces it in params()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sourceProductId=abc');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sourceProductId') === 'abc').flush(FIXTURE);
    expect(fixture.componentInstance.idx.params()['sourceProductId']).toBe('abc');
    httpMock.verify();
  });

  it('omits an absent passthrough param from the request', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/test');
    expect(req.request.params.has('sourceProductId')).toBe(false);
    req.flush(FIXTURE);
    httpMock.verify();
  });

  it('sets error() and clears data() when the request fails', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/test').flush(ERROR_BODY, SERVER_ERROR);
    fixture.detectChanges();

    expect(fixture.componentInstance.idx.error()).toBeTruthy();
    expect(fixture.componentInstance.idx.data()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.error')).not.toBeNull();
    httpMock.verify();
  });

  it('resets data() to null on re-navigation so stale rows never show under a fresh request', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).not.toBeNull();

    // Navigate again. The new request is in flight, so data must reset to null.
    await router.navigateByUrl('/test?page=2');
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).toBeNull();

    httpMock.expectOne((r) => r.params.get('page') === '2').flush(FIXTURE);
    httpMock.verify();
  });

  it('onSortChange ignores an invalid key and navigates ?sort=&page=1 for a valid one', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?page=3');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '3').flush(FIXTURE);

    // Invalid key is a no-op: URL unchanged.
    fixture.componentInstance.idx.onSortChange('banana');
    await fixture.whenStable();
    expect(router.url).toBe('/test?page=3');

    // Valid key resets to page 1.
    fixture.componentInstance.idx.onSortChange('name');
    await fixture.whenStable();
    expect(router.url).toBe('/test?page=1&sort=name');

    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    httpMock.verify();
  });

  it('onPageChange merge-navigates ?page=', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sort=name');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(FIXTURE);

    fixture.componentInstance.idx.onPageChange(4);
    await fixture.whenStable();
    // page merges in; existing sort is preserved.
    expect(router.url).toBe('/test?sort=name&page=4');

    httpMock.expectOne((r) => r.params.get('page') === '4').flush(FIXTURE);
    httpMock.verify();
  });

  it('setError() surfaces the error and clears data()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).not.toBeNull();

    fixture.componentInstance.idx.setError(new Error('boom'));
    fixture.detectChanges();

    expect(fixture.componentInstance.idx.error()).toBeTruthy();
    expect(fixture.componentInstance.idx.data()).toBeNull();
    httpMock.verify();
  });
});
