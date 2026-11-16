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
});
