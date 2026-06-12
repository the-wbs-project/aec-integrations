import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PaginatedResponse } from '@aeci/shared';

import { createIndexSetup, settle } from '../../core/testing/index-page.harness';

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
 *
 * Async note (AECI-126): the controller fetches via `httpResource()`, which
 * dispatches from a reactive effect and applies the response on a microtask, so
 * a `settle()` boundary stands between flushing a request and asserting on the
 * resulting `data()` / `error()` / DOM. See the harness for why this is a
 * macrotask rather than `fixture.whenStable()`.
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
    await settle();
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
    await settle();
    expect(fixture.componentInstance.idx.sort()).toBe('name');
    httpMock.verify();
  });

  it('falls back to the default sort for an unknown ?sort', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sort=banana');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === 'created').flush(FIXTURE);
    await settle();
    expect(fixture.componentInstance.idx.sort()).toBe('created');
    httpMock.verify();
  });

  it('forwards a present passthrough param to the request and surfaces it in params()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sourceProductId=abc');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sourceProductId') === 'abc').flush(FIXTURE);
    await settle();
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
    await settle();
    httpMock.verify();
  });

  it('sets error() and clears data() when the request fails', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/test').flush(ERROR_BODY, SERVER_ERROR);
    await settle();
    fixture.detectChanges();

    expect(fixture.componentInstance.idx.error()).toBeTruthy();
    expect(fixture.componentInstance.idx.data()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.error')).not.toBeNull();
    httpMock.verify();
  });

  it('keeps the previous data() on screen while a re-navigation refetches (no blank flash) and toggles pending()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).toEqual(FIXTURE);
    expect(fixture.componentInstance.idx.pending()).toBe(false);

    // Navigate again. The new request is in flight: the prior rows stay on screen
    // (keep-previous, the flash fix) and pending() flips true so the grid can dim
    // instead of blanking to a loading state.
    await router.navigateByUrl('/test?page=2');
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).toEqual(FIXTURE);
    expect(fixture.componentInstance.idx.pending()).toBe(true);

    // Once the new response lands it replaces the retained one and pending clears.
    const NEXT: Resp = { data: [{ id: 'r2' }], page: 2, perPage: 24, total: 1 };
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(NEXT);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).toEqual(NEXT);
    expect(fixture.componentInstance.idx.pending()).toBe(false);
    httpMock.verify();
  });

  it('clears the retained data() when a re-navigation fails (an error never shows stale rows)', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).toEqual(FIXTURE);

    // Re-navigate, then fail the new request. Keep-previous must yield to the
    // error: data() goes null so the table shows its error row, not stale rows.
    await router.navigateByUrl('/test?page=2');
    await settle();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(ERROR_BODY, SERVER_ERROR);
    await settle();
    fixture.detectChanges();

    expect(fixture.componentInstance.idx.error()).toBeTruthy();
    expect(fixture.componentInstance.idx.data()).toBeNull();
    httpMock.verify();
  });

  it('onSortChange ignores an invalid key and navigates ?sort=&page=1 for a valid one', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?page=3');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '3').flush(FIXTURE);
    await settle();

    // Invalid key is a no-op: URL unchanged.
    fixture.componentInstance.idx.onSortChange('banana');
    await settle();
    expect(router.url).toBe('/test?page=3');

    // Valid key resets to page 1.
    fixture.componentInstance.idx.onSortChange('name');
    await settle();
    expect(router.url).toBe('/test?page=1&sort=name');

    // The param change re-dispatches the resource on the next change detection.
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    await settle();
    httpMock.verify();
  });

  it('onPageChange merge-navigates ?page=', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test?sort=name');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(FIXTURE);
    await settle();

    fixture.componentInstance.idx.onPageChange(4);
    await settle();
    // page merges in; existing sort is preserved.
    expect(router.url).toBe('/test?sort=name&page=4');

    // The param change re-dispatches the resource on the next change detection.
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '4').flush(FIXTURE);
    await settle();
    httpMock.verify();
  });

  it('setError() surfaces the error and clears data()', async () => {
    const { httpMock, router } = createIndexSetup(TestPaginatedIndexHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestPaginatedIndexHost);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.data()).not.toBeNull();

    fixture.componentInstance.idx.setError(new Error('boom'));
    fixture.detectChanges();

    expect(fixture.componentInstance.idx.error()).toBeTruthy();
    expect(fixture.componentInstance.idx.data()).toBeNull();
    httpMock.verify();
  });
});

/**
 * Append-mode host: exercises the opt-in `mode: 'append'` accumulation path that
 * powers the infinite-scroll listings (`/products`, taxonomy browse). It renders
 * `idx.items()` (the flattened, accumulated buffer) plus the derived
 * `loadedCount` / `hasMore`, so the tests can assert pages fold together as
 * `loadMore()` advances — none of which the replace-mode host above touches.
 */
@Component({
  template: `
    @for (row of idx.items(); track row.id) {
      <span class="row">{{ row.id }}</span>
    }
    <span class="count">{{ idx.loadedCount() }}</span>
    <span class="more">{{ idx.hasMore() }}</span>
  `,
})
class TestAppendHost {
  readonly idx: PaginatedIndex<Resp> = createPaginatedIndex<Resp>({
    apiPath: '/api/test',
    validSorts: new Set(['created', 'name']),
    defaultSort: 'created',
    mode: 'append',
  });
}

describe('createPaginatedIndex append mode', () => {
  // Two pages of a 25-item result set (perPage 24 ⇒ ceil(25/24) = 2 pages).
  const PAGE1: Resp = { data: [{ id: 'p1' }], page: 1, perPage: 24, total: 25 };
  const PAGE2: Resp = { data: [{ id: 'p2' }], page: 2, perPage: 24, total: 25 };

  const rowIds = (fixture: { nativeElement: unknown }): string[] =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('.row')].map(
      (n) => n.textContent ?? '',
    );

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('accumulates the next page on loadMore() and keeps the page out of the URL', async () => {
    const { httpMock, router } = createIndexSetup(TestAppendHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestAppendHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '1').flush(PAGE1);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.loadedCount()).toBe(1);
    expect(fixture.componentInstance.idx.hasMore()).toBe(true);

    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(PAGE2);
    await settle();
    fixture.detectChanges();

    // Both pages are folded into the rendered list, ascending.
    expect(rowIds(fixture)).toEqual(['p1', 'p2']);
    expect(fixture.componentInstance.idx.loadedCount()).toBe(2);
    // Paging is internal: the page number never enters the address bar.
    expect(router.url).toBe('/test');
    httpMock.verify();
  });

  it('stops at the final page: hasMore() flips false and loadMore() no-ops past the end', async () => {
    const { httpMock, router } = createIndexSetup(TestAppendHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestAppendHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '1').flush(PAGE1);
    await settle();
    fixture.detectChanges();

    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(PAGE2);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.hasMore()).toBe(false);

    // Past the last page loadMore() is inert — no request fires.
    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectNone((r) => r.url === '/api/test');
    httpMock.verify();
  });

  it('retries the same page (no skip) when a loadMore() fetch fails, then the next one', async () => {
    const { httpMock, router } = createIndexSetup(TestAppendHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestAppendHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '1').flush(PAGE1);
    await settle();
    fixture.detectChanges();

    // First loadMore → page 2 request FAILS. Items are retained (page 1 stays),
    // and the buffer's highest page is still 1.
    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(ERROR_BODY, SERVER_ERROR);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.loadedCount()).toBe(1);

    // The next loadMore() must RETRY page 2 — not skip ahead to page 3 — so the
    // failed page's items are not lost. (A blind `targetPage + 1` would request
    // page 3 here and drop page 2 forever.)
    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(PAGE2);
    await settle();
    fixture.detectChanges();

    expect(rowIds(fixture)).toEqual(['p1', 'p2']);
    httpMock.verify();
  });

  it('resets the buffer to page 1 on a sort change (accumulated pages clear)', async () => {
    const { httpMock, router } = createIndexSetup(TestAppendHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestAppendHost);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '1').flush(PAGE1);
    await settle();
    fixture.detectChanges();
    fixture.componentInstance.idx.loadMore();
    fixture.detectChanges();
    httpMock.expectOne((r) => r.params.get('page') === '2').flush(PAGE2);
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.idx.loadedCount()).toBe(2);

    // A sort change resets the buffer and refetches page 1 (and keeps ?page= out
    // of the URL in append mode).
    fixture.componentInstance.idx.onSortChange('name');
    await settle();
    fixture.detectChanges();
    expect(router.url).toBe('/test?sort=name');
    const SORTED_PAGE1: Resp = { data: [{ id: 's1' }], page: 1, perPage: 24, total: 25 };
    httpMock.expectOne((r) => r.params.get('sort') === 'name').flush(SORTED_PAGE1);
    await settle();
    fixture.detectChanges();

    // Only the fresh page 1 remains — the previously accumulated page 2 is gone.
    expect(rowIds(fixture)).toEqual(['s1']);
    expect(fixture.componentInstance.idx.loadedCount()).toBe(1);
    httpMock.verify();
  });
});

/**
 * AECI-143 host: exercises the `baseParams` (fixed, non-URL filter params) and
 * `enabled` (fetch gate) config options, and the now-optional `meta` (omitted —
 * the taxonomy browse page lets its resolver own meta). Mirrors how the browse
 * page locks `{kind}_id` while a cross-filter rides the URL.
 */
@Component({
  template: `@if (idx.data(); as response) {
    <span class="total">{{ response.total }}</span>
  }`,
})
class TestBaseParamsHost {
  readonly fetchEnabled = signal(true);
  readonly lockId = signal<string | undefined>('locked-1');
  readonly idx: PaginatedIndex<Resp> = createPaginatedIndex<Resp>({
    apiPath: '/api/test',
    validSorts: new Set(['created', 'name']),
    defaultSort: 'created',
    baseParams: () => ({ category_id: this.lockId() }),
    passthroughParams: ['audience_id'],
    enabled: () => this.fetchEnabled(),
    // no `meta` — verifies the optional-meta path constructs without throwing.
  });
}

describe('createPaginatedIndex baseParams + enabled (AECI-143)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('merges baseParams into the request alongside URL passthroughs', async () => {
    const { httpMock, router } = createIndexSetup(TestBaseParamsHost, 'test');
    await router.navigateByUrl('/test?audience_id=A');
    const fixture = TestBed.createComponent(TestBaseParamsHost);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (r) =>
        r.url === '/api/test' &&
        r.params.get('category_id') === 'locked-1' &&
        r.params.get('audience_id') === 'A',
    );
    req.flush(FIXTURE);
    await settle();
    httpMock.verify();
  });

  it('skips a baseParams key whose value is undefined', async () => {
    const { httpMock, router } = createIndexSetup(TestBaseParamsHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestBaseParamsHost);
    fixture.componentInstance.lockId.set(undefined);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/test');
    expect(req.request.params.has('category_id')).toBe(false);
    req.flush(FIXTURE);
    await settle();
    httpMock.verify();
  });

  it('does not fetch while enabled() is false, then fetches once it flips true', async () => {
    const { httpMock, router } = createIndexSetup(TestBaseParamsHost, 'test');
    await router.navigateByUrl('/test');
    const fixture = TestBed.createComponent(TestBaseParamsHost);
    fixture.componentInstance.fetchEnabled.set(false);
    fixture.detectChanges();

    // Gate closed → no request dispatched at all.
    httpMock.expectNone((r) => r.url === '/api/test');

    // Open the gate → the resource recomputes and fires.
    fixture.componentInstance.fetchEnabled.set(true);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/test').flush(FIXTURE);
    await settle();
    httpMock.verify();
  });
});
