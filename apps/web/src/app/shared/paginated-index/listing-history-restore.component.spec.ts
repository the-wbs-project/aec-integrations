import { Location } from '@angular/common';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaginatedResponse } from '@aeci/shared';

import { settle } from '../../core/testing/index-page.harness';

import { LISTING_HISTORY_MAX_AGE_MS, ListingHistoryStore } from './listing-history-store';
import { type PaginatedIndex, createPaginatedIndex } from './paginated-index-controller';

type Row = { id: string };
type Resp = PaginatedResponse<Row>;

// Three pages of a 49-item result (perPage 24).
const page = (n: number, prefix = 'p'): Resp => ({
  data: [{ id: `${prefix}${n}` }],
  page: n,
  perPage: 24,
  total: 49,
});

/**
 * A routed append-mode listing, so Back is a real router `popstate` navigation
 * (SpyLocation emits it) and the host is built inside that navigation, the way
 * `/products` is.
 */
@Component({
  template: `@for (row of idx.items(); track row.id) {
    <span class="row">{{ row.id }}</span>
  }`,
})
class ListHost {
  readonly idx: PaginatedIndex<Resp> = createPaginatedIndex<Resp>({
    apiPath: '/api/test',
    validSorts: new Set(['created', 'name']),
    defaultSort: 'created',
    passthroughParams: ['category_id'],
    mode: 'append',
  });
}

@Component({ template: `<p>detail</p>` })
class DetailHost {}

async function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withXhr()),
      provideHttpClientTesting(),
      provideLocationMocks(),
      provideRouter([
        { path: 'list', component: ListHost },
        { path: 'other-list', component: ListHost },
        { path: 'detail', component: DetailHost },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create();
  // What the app's initial navigation does: listen for Back/Forward.
  TestBed.inject(Router).setUpLocationChangeListener();
  const httpMock = TestBed.inject(HttpTestingController);
  const location = TestBed.inject(Location);
  const rows = (): string[] =>
    [...(harness.routeNativeElement?.querySelectorAll('.row') ?? [])].map(
      (n) => n.textContent ?? '',
    );
  const host = (): ListHost => harness.routeDebugElement!.componentInstance as ListHost;
  return { harness, httpMock, location, rows, host };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Open a listing fresh, load `pages` pages, then leave for the detail page. */
async function browseThenLeave(env: Env, url: string, pages: number, prefix = 'p') {
  await env.harness.navigateByUrl(url);
  env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, prefix));
  await settle();
  env.harness.detectChanges();
  for (let n = 2; n <= pages; n++) {
    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === String(n)).flush(page(n, prefix));
    await settle();
    env.harness.detectChanges();
  }
  await env.harness.navigateByUrl('/detail');
}

/** Press Back and render once, before any request could have answered. */
async function back(env: Env) {
  env.location.back();
  await settle();
  env.harness.detectChanges();
}

describe('createPaginatedIndex history restore (AECI-1900)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('on Back, renders every page the reader had loaded in the first render, with no request', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);

    await back(env);
    expect(env.location.path()).toBe('/list');
    expect(env.rows()).toEqual(['p1', 'p2']);
    // No refetch: the rows on screen are exactly the ones the reader left.
    env.httpMock.expectNone((r) => r.url === '/api/test');
    expect(env.host().idx.reloading()).toBe(false);
    expect(env.host().idx.pending()).toBe(false);
    expect(env.host().idx.hasMore()).toBe(true);
    env.httpMock.verify();
  });

  it('after a restore, "Load more" fetches the page after the last restored one', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    await back(env);

    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '3').flush(page(3));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['p1', 'p2', 'p3']);
    env.httpMock.verify();
  });

  it('on Forward, restores the listing too', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    // Back to the listing (restored), on to the detail page, Back, then Forward.
    await back(env);
    await env.harness.navigateByUrl('/detail');
    await back(env);
    env.location.forward();
    await settle();
    env.harness.detectChanges();
    expect(env.location.path()).toBe('/detail');
    await back(env);
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');

    // A real Forward onto a listing: /list → /other-list, Back, Forward.
    await env.harness.navigateByUrl('/other-list');
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'o'));
    await settle();
    env.harness.detectChanges();
    await back(env);
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.location.forward();
    await settle();
    env.harness.detectChanges();
    expect(env.location.path()).toBe('/other-list');
    expect(env.rows()).toEqual(['o1']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  it('does not use the store on a fresh navigation to the same URL: it fetches', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);

    await env.harness.navigateByUrl('/list');
    // The first render has no rows yet, as on any fresh visit.
    expect(env.rows()).toEqual([]);
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'fresh'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['fresh1']);
    env.httpMock.verify();
  });

  it('never shares an entry between two lists: Back to each list gets its own rows', async () => {
    const env = await setup();
    // List A: unfiltered, two pages. Leave it.
    await browseThenLeave(env, '/list', 2, 'a');
    // List B: same route, a filter, one page. Leave it.
    await browseThenLeave(env, '/list?category_id=x', 1, 'b');
    // List C: same request on another route.
    await browseThenLeave(env, '/other-list', 1, 'c');

    await back(env); // to /other-list
    expect(env.location.path()).toBe('/other-list');
    expect(env.rows()).toEqual(['c1']);
    await back(env); // to /detail
    await back(env); // to /list?category_id=x
    expect(env.location.path()).toBe('/list?category_id=x');
    expect(env.rows()).toEqual(['b1']);
    await back(env); // to /detail
    await back(env); // to /list
    expect(env.location.path()).toBe('/list');
    expect(env.rows()).toEqual(['a1', 'a2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  it('a Back with nothing stored fetches as before (a reload empties the store)', async () => {
    // After a reload the in-memory store is a new, empty instance (see
    // listing-history-store.spec.ts). Model that by storing nothing.
    vi.spyOn(ListingHistoryStore.prototype, 'write').mockImplementation(() => undefined);
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    expect(TestBed.inject(ListingHistoryStore).size).toBe(0);

    await back(env);
    expect(env.rows()).toEqual([]);
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['p1']);
    env.httpMock.verify();
  });

  it('never writes to localStorage, sessionStorage or a cookie', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    await back(env);
    expect(env.rows()).toEqual(['p1', 'p2']);
    expect(setItem).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });

  it('a Back more than five minutes after leaving fetches fresh rows', async () => {
    // A restore makes no request, so an old entry could show a product since
    // hidden, or a logo an unclaimed listing no longer shows (ADR 0051).
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    now.mockReturnValue(1_000_000 + LISTING_HISTORY_MAX_AGE_MS + 1);

    await back(env);
    expect(env.rows()).toEqual([]);
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'fresh'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['fresh1']);
    env.httpMock.verify();
  });

  it('a Back within five minutes of leaving still restores', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    now.mockReturnValue(1_000_000 + LISTING_HISTORY_MAX_AGE_MS);

    await back(env);
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  it('never reads or writes the store when rendering on the server', async () => {
    const read = vi.spyOn(ListingHistoryStore.prototype, 'read');
    const write = vi.spyOn(ListingHistoryStore.prototype, 'write');
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }] });
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    await back(env);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    // The server path fetches the page it renders, as before.
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1));
  });

  it('a sort change after a restore resets to a fresh page 1', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    await back(env);

    env.host().idx.onSortChange('name');
    await settle();
    env.harness.detectChanges();
    env.httpMock
      .expectOne((r) => r.params.get('sort') === 'name' && r.params.get('page') === '1')
      .flush(page(1, 's'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['s1']);
    env.httpMock.verify();
  });

  // The router writes `navigationId` into `history.state` for each entry, and a
  // Back hands it back as `NavigationStart.restoredState.navigationId`. Keyed by
  // URL alone, leaving the second visit overwrote the first visit's pages.
  // After a Back or Forward the router gives the entry a new id. Saving it again
  // under that id retires the old one, so repeat trips do not fill the bound
  // with dead entries.
  it('repeat Back trips to one entry keep one stored entry, not one per trip', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 2);
    const store = TestBed.inject(ListingHistoryStore);
    expect(store.size).toBe(1);

    for (let trip = 0; trip < 3; trip++) {
      await back(env); // to /list, restored
      expect(env.rows()).toEqual(['p1', 'p2']);
      await env.harness.navigateByUrl('/detail'); // leave again: saved under the new id
      expect(store.size, `after trip ${trip + 1}`).toBe(1);
    }
    // And the one entry left is the live one: Back still restores.
    await back(env);
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
  });

  it('two visits to one URL keep their own pages: Back to each restores its own count', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list', 1, 'a'); // first visit: 1 page
    await browseThenLeave(env, '/list', 3, 'b'); // second visit: 3 pages

    await back(env); // to the second visit
    expect(env.location.path()).toBe('/list');
    expect(env.rows()).toEqual(['b1', 'b2', 'b3']);
    await back(env); // /detail
    await back(env); // to the first visit
    expect(env.location.path()).toBe('/list');
    expect(env.rows()).toEqual(['a1']);

    // Forward again: each entry still gets its own pages.
    env.location.forward();
    await settle();
    env.location.forward();
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['b1', 'b2', 'b3']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  // A filter or sort change on the page pushes a history entry and keeps the
  // component. Back between two such states used to refetch page 1 and lose the
  // "Load more" pages.
  it('Back and Forward between two filter states on one page restore each without a request', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list');
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'a'));
    await settle();
    env.harness.detectChanges();
    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '2').flush(page(2, 'a'));
    await settle();
    env.harness.detectChanges();
    const host = env.host();

    // A filter click: same component, new history entry, fresh fetch.
    await env.harness.navigateByUrl('/list?category_id=x');
    env.harness.detectChanges();
    env.httpMock
      .expectOne((r) => r.params.get('category_id') === 'x' && r.params.get('page') === '1')
      .flush(page(1, 'f'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['f1']);
    expect(env.host()).toBe(host);

    await back(env); // to the unfiltered state, same component
    expect(env.location.path()).toBe('/list');
    expect(env.host()).toBe(host);
    expect(env.rows()).toEqual(['a1', 'a2']);
    expect(env.host().idx.reloading()).toBe(false);
    env.httpMock.expectNone((r) => r.url === '/api/test');

    env.location.forward(); // to the filtered state
    await settle();
    env.harness.detectChanges();
    expect(env.location.path()).toBe('/list?category_id=x');
    expect(env.rows()).toEqual(['f1']);
    env.httpMock.expectNone((r) => r.url === '/api/test');

    // "Load more" after an in-page restore fetches the next page.
    await back(env);
    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '3').flush(page(3, 'a'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['a1', 'a2', 'a3']);
    env.httpMock.verify();
  });

  it('never stores the previous rows under a filter state whose rows had not arrived', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list');
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'a'));
    await settle();
    env.harness.detectChanges();

    // A filter click, then the reader leaves before its rows arrive. The grid
    // still shows "a1" while it waits, but those are not the rows for `x`.
    await env.harness.navigateByUrl('/list?category_id=x');
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['a1']);
    env.httpMock.expectOne((r) => r.params.get('category_id') === 'x');
    await env.harness.navigateByUrl('/detail');

    await back(env);
    expect(env.location.path()).toBe('/list?category_id=x');
    env.httpMock.expectOne((r) => r.params.get('category_id') === 'x').flush(page(1, 'f'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['f1']);
    env.httpMock.verify();
  });

  // AECI-1909. The same rule when the reader leaves by a second filter click on
  // the same page. The component stays, so leaving is a `NavigationStart`, not a
  // teardown. Logged in the e2e run: the second click came 190 to 270ms after
  // the first, before its rows arrived. Nothing was stored for the first state,
  // so Back to it fetched, and the second state's rows stood in meanwhile. That
  // is correct, and the e2e now waits for each state's rows before leaving it.
  it('a filter state left by another filter click before its rows arrived is not stored: Back fetches its own rows', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list');
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1, 'a'));
    await settle();
    env.harness.detectChanges();
    const host = env.host();

    // First click: its rows are still in flight when the second click lands.
    await env.harness.navigateByUrl('/list?category_id=x');
    env.harness.detectChanges();
    const first = env.httpMock.expectOne((r) => r.params.get('category_id') === 'x');
    await env.harness.navigateByUrl('/list?category_id=x,y');
    env.harness.detectChanges();
    expect(first.cancelled).toBe(true);
    env.httpMock.expectOne((r) => r.params.get('category_id') === 'x,y').flush(page(1, 'b'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['b1']);

    await back(env); // to the first filter state, same component
    expect(env.location.path()).toBe('/list?category_id=x');
    expect(env.host()).toBe(host);
    // Not "a1" (on screen when the reader left) nor "b1" (on screen now): the
    // listing fetches the rows for `x`.
    expect(env.host().idx.reloading()).toBe(true);
    env.httpMock.expectOne((r) => r.params.get('category_id') === 'x').flush(page(1, 'f'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['f1']);
    env.httpMock.verify();
  });

  // AECI-1902. The listing read `?page=` once, when it was built. A Back to
  // `?page=K` across an in-page filter change kept the component, restarted at
  // page 1, missed the store and fetched the wrong page.
  it('Back to a listing opened at ?page=2, across a filter click, restores page 2 without a request', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list?page=2');
    env.httpMock.expectOne((r) => r.params.get('page') === '2').flush(page(2));
    await settle();
    env.harness.detectChanges();
    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '3').flush(page(3));
    await settle();
    env.harness.detectChanges();
    const host = env.host();

    // The filter panel drops `?page=` on a click, so the filter starts at 1.
    await env.harness.navigateByUrl('/list?category_id=x');
    env.harness.detectChanges();
    env.httpMock
      .expectOne((r) => r.params.get('category_id') === 'x' && r.params.get('page') === '1')
      .flush(page(1, 'f'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['f1']);

    await back(env);
    expect(env.location.path()).toBe('/list?page=2');
    expect(env.host()).toBe(host);
    expect(env.rows()).toEqual(['p2', 'p3']);
    expect(env.host().idx.firstPage()).toBe(2);
    env.httpMock.expectNone((r) => r.url === '/api/test');

    env.location.forward();
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['f1']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  it('Back and Forward between ?page=2 and the bare listing on one component restore each', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list?page=2');
    env.httpMock.expectOne((r) => r.params.get('page') === '2').flush(page(2));
    await settle();
    env.harness.detectChanges();

    // The header link: same component, `?page=` dropped, a fresh page 1.
    await env.harness.navigateByUrl('/list');
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '1').flush(page(1));
    await settle();
    env.harness.detectChanges();
    env.host().idx.loadMore();
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('page') === '2').flush(page(2));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['p1', 'p2']);

    await back(env);
    expect(env.location.path()).toBe('/list?page=2');
    expect(env.rows()).toEqual(['p2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');

    env.location.forward();
    await settle();
    env.harness.detectChanges();
    expect(env.location.path()).toBe('/list');
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.httpMock.expectNone((r) => r.url === '/api/test');
    env.httpMock.verify();
  });

  it('a filter click (not a Back) on the page still fetches', async () => {
    const env = await setup();
    await browseThenLeave(env, '/list?category_id=x', 1, 'f');
    await browseThenLeave(env, '/list', 1, 'a');
    await back(env); // restored /list
    // Clicking the same filter again is a fresh navigation: it must fetch,
    // although an entry for that request is stored.
    await env.harness.navigateByUrl('/list?category_id=x');
    env.harness.detectChanges();
    env.httpMock.expectOne((r) => r.params.get('category_id') === 'x').flush(page(1, 'fresh'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['fresh1']);
    env.httpMock.verify();
  });
});

/** Navigate as a link click would, then render. */
async function go(env: Env, url: string) {
  await env.harness.navigateByUrl(url);
  env.harness.detectChanges();
}

/** Answer the one request for `n` with that page, then render. */
async function answer(env: Env, n: number, prefix = 'p') {
  env.httpMock.expectOne((r) => r.params.get('page') === String(n)).flush(page(n, prefix));
  await settle();
  env.harness.detectChanges();
}

// AECI-1902. The listing read `?page=` once, when it was built. A navigation
// that kept the component and changed only `?page=` left the old pages on
// screen under the new URL: `/products?page=2`, then the header "Browse" link
// to `/products`, still showed page 2 and no "Load more".
describe('createPaginatedIndex first page follows ?page= on every navigation (AECI-1902)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('?page=2, then a link to the bare listing: page 1 alone, with "Load more"', async () => {
    const env = await setup();
    await go(env, '/list?page=2');
    await answer(env, 2);
    const host = env.host();
    expect(env.rows()).toEqual(['p2']);

    await go(env, '/list');
    expect(env.host()).toBe(host);
    await answer(env, 1);
    expect(env.rows()).toEqual(['p1']);
    expect(env.host().idx.firstPage()).toBe(1);
    expect(env.host().idx.hasMore()).toBe(true);
    env.httpMock.verify();
  });

  it('the bare listing, then a link to ?page=2: page 2 alone', async () => {
    const env = await setup();
    await go(env, '/list');
    await answer(env, 1);

    await go(env, '/list?page=2');
    await answer(env, 2);
    expect(env.rows()).toEqual(['p2']);
    expect(env.host().idx.firstPage()).toBe(2);
    env.httpMock.verify();
  });

  it('?page=2 and "Load more" to page 3, then the bare listing: page 1 only', async () => {
    const env = await setup();
    await go(env, '/list?page=2');
    await answer(env, 2);
    env.host().idx.loadMore();
    env.harness.detectChanges();
    await answer(env, 3);
    expect(env.rows()).toEqual(['p2', 'p3']);
    expect(env.host().idx.hasMore()).toBe(false);

    await go(env, '/list');
    // While page 1 loads, the old rows stay on screen and the grid dims.
    expect(env.host().idx.reloading()).toBe(true);
    await answer(env, 1);
    expect(env.rows()).toEqual(['p1']);
    expect(env.host().idx.hasMore()).toBe(true);
    // And "Load more" carries on from page 1.
    env.host().idx.loadMore();
    env.harness.detectChanges();
    await answer(env, 2);
    expect(env.rows()).toEqual(['p1', 'p2']);
    env.httpMock.verify();
  });

  it('a query change that leaves ?page= alone keeps every loaded page', async () => {
    // `?view=` is presentation only: not a passthrough, not the page. The
    // resource asks again for the page it is on (as before this fix), and the
    // buffer keeps both pages rather than starting over at `?page=`.
    const env = await setup();
    await go(env, '/list?page=2');
    await answer(env, 2);
    env.host().idx.loadMore();
    env.harness.detectChanges();
    await answer(env, 3);

    await go(env, '/list?page=2&view=table');
    expect(env.rows()).toEqual(['p2', 'p3']);
    env.httpMock.expectNone((r) => r.params.get('page') !== '3');
    for (const req of env.httpMock.match(() => true)) req.flush(page(3));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['p2', 'p3']);
    expect(env.host().idx.firstPage()).toBe(2);
    env.httpMock.verify();
  });

  it('a sort change on ?page=2 drops ?page= and starts the new order at page 1', async () => {
    const env = await setup();
    await go(env, '/list?page=2');
    await answer(env, 2);

    env.host().idx.onSortChange('name');
    await settle();
    env.harness.detectChanges();
    expect(env.location.path()).toBe('/list?sort=name');
    env.httpMock
      .expectOne((r) => r.params.get('sort') === 'name' && r.params.get('page') === '1')
      .flush(page(1, 's'));
    await settle();
    env.harness.detectChanges();
    expect(env.rows()).toEqual(['s1']);
    env.httpMock.verify();
  });
});
