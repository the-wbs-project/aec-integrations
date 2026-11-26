import { Location } from '@angular/common';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductFacetsResponse, TaxonomyTermWithCount } from '@aeci/shared';

import { settle } from '../../core/testing/index-page.harness';
import {
  FacetHistoryStore,
  LISTING_HISTORY_MAX_AGE_MS,
} from '../paginated-index/listing-history-store';

import { FacetSidebar } from './facet-sidebar';

const FACETS_URL = '/api/products/facets';

function term(id: string, name: string, count: number): TaxonomyTermWithCount {
  return { id, name, slug: id, description: null, display_order: 0, product_count: count };
}

/** Counts whose one category term is named after `label`, so each response is recognisable. */
function counts(label: string): ProductFacetsResponse {
  return {
    categories: [term('c1', `Cat ${label}`, 3)],
    audiences: [term('a1', 'Aud', 2)],
    trades: [],
    phases: [],
    connector_kinds: [],
  };
}

/** A routed page that hosts the panel, as `/products` does. */
@Component({ imports: [FacetSidebar], template: `<aec-facet-sidebar />` })
class ListPage {}

/** A routed term page that locks its own dimension, as the browse pages do. */
@Component({
  imports: [FacetSidebar],
  template: `<aec-facet-sidebar lockedKind="phase" lockedId="p-locked" />`,
})
class TermPage {}

@Component({ template: `<p>detail</p>` })
class DetailPage {}

async function setup(platform: 'browser' | 'server' = 'browser') {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withXhr()),
      provideHttpClientTesting(),
      provideLocationMocks(),
      provideRouter([
        { path: 'list', component: ListPage },
        { path: 'term', component: TermPage },
        { path: 'detail', component: DetailPage },
      ]),
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
  const harness = await RouterTestingHarness.create();
  // What the app's initial navigation does: listen for Back/Forward.
  TestBed.inject(Router).setUpLocationChangeListener();
  const httpMock = TestBed.inject(HttpTestingController);
  const location = TestBed.inject(Location);
  const text = (): string => harness.routeNativeElement?.textContent ?? '';
  return { harness, httpMock, location, text };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Open `url` fresh, answer its counts request with `label`, then leave. */
async function visitThenLeave(env: Env, url: string, label: string) {
  await env.harness.navigateByUrl(url);
  env.harness.detectChanges();
  await settle();
  env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts(label));
  await settle();
  env.harness.detectChanges();
  expect(env.text()).toContain(`Cat ${label}`);
  await env.harness.navigateByUrl('/detail');
}

/** Press Back and render once. */
async function back(env: Env) {
  env.location.back();
  await settle();
  env.harness.detectChanges();
  await settle();
  env.harness.detectChanges();
}

describe('FacetSidebar history restore (AECI-1900)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('on Back, renders the counts it had in the first render, with no request', async () => {
    const env = await setup();
    await visitThenLeave(env, '/list?category_id=c1', 'A');

    await back(env);
    expect(env.location.path()).toBe('/list?category_id=c1');
    expect(env.text()).toContain('Cat A');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);
    env.httpMock.verify();
  });

  it('on Forward, restores the counts too', async () => {
    const env = await setup();
    await visitThenLeave(env, '/list?category_id=c1', 'A');
    await back(env);
    env.location.forward();
    await settle();
    expect(env.location.path()).toBe('/detail');
    // Back to the list, then Forward to /detail and Back again: each landing on
    // the list restores without a request.
    await back(env);
    expect(env.text()).toContain('Cat A');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);
  });

  it('a filter change after a restore fetches the new counts', async () => {
    const env = await setup();
    await visitThenLeave(env, '/list?category_id=c1', 'A');
    await back(env);

    await env.harness.navigateByUrl('/list?category_id=c1&audience_id=a1');
    env.harness.detectChanges();
    await settle();
    env.httpMock
      .expectOne((r) => r.url === FACETS_URL && r.params.get('audience_id') === 'a1')
      .flush(counts('B'));
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat B');
    env.httpMock.verify();
  });

  it('does not use the store on a fresh navigation to the same URL: it fetches', async () => {
    const env = await setup();
    await visitThenLeave(env, '/list?category_id=c1', 'A');

    await env.harness.navigateByUrl('/list?category_id=c1');
    env.harness.detectChanges();
    await settle();
    env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts('Fresh'));
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat Fresh');
    env.httpMock.verify();
  });

  it('never shares an entry between two counts requests', async () => {
    const env = await setup();
    // Same route, two filter sets; and a term page whose lock is part of the request.
    await visitThenLeave(env, '/list?category_id=c1', 'One');
    await visitThenLeave(env, '/list?category_id=c1,c2', 'Two');
    await visitThenLeave(env, '/term?category_id=c1', 'Term');

    await back(env); // to /term?category_id=c1
    expect(env.text()).toContain('Cat Term');
    await back(env); // /detail
    await back(env); // to /list?category_id=c1,c2
    expect(env.location.path()).toBe('/list?category_id=c1,c2');
    expect(env.text()).toContain('Cat Two');
    await back(env); // /detail
    await back(env); // to /list?category_id=c1
    expect(env.text()).toContain('Cat One');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);
    env.httpMock.verify();
  });

  it('fetches on Back when the stored counts are older than five minutes', async () => {
    const env = await setup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await visitThenLeave(env, '/list?category_id=c1', 'A');
    now.mockReturnValue(1_000_000 + LISTING_HISTORY_MAX_AGE_MS + 1);

    await back(env);
    env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts('Fresh'));
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat Fresh');
    now.mockRestore();
    env.httpMock.verify();
  });

  it('Back and Forward between two filter states on one page restore the counts without a request', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list?category_id=c1');
    env.harness.detectChanges();
    await settle();
    env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts('One'));
    await settle();
    env.harness.detectChanges();

    // A filter click: same panel, new history entry, fresh counts.
    await env.harness.navigateByUrl('/list?category_id=c1,c2');
    env.harness.detectChanges();
    await settle();
    env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts('Two'));
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat Two');

    await back(env);
    expect(env.location.path()).toBe('/list?category_id=c1');
    expect(env.text()).toContain('Cat One');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);

    env.location.forward();
    await settle();
    env.harness.detectChanges();
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat Two');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);
    env.httpMock.verify();
  });

  it('never stores the previous counts under a filter state whose counts had not arrived', async () => {
    const env = await setup();
    await env.harness.navigateByUrl('/list?category_id=c1');
    env.harness.detectChanges();
    await settle();
    env.httpMock.expectOne((r) => r.url === FACETS_URL).flush(counts('One'));
    await settle();
    env.harness.detectChanges();

    // A filter click, then the reader leaves before its counts arrive. The panel
    // still shows "One" while it waits, but those are not the counts for c1,c2.
    await env.harness.navigateByUrl('/list?category_id=c1,c2');
    env.harness.detectChanges();
    await settle();
    expect(env.text()).toContain('Cat One');
    env.httpMock.expectOne((r) => r.url === FACETS_URL && r.params.get('category_id') === 'c1,c2');
    await env.harness.navigateByUrl('/detail');

    await back(env);
    expect(env.location.path()).toBe('/list?category_id=c1,c2');
    env.httpMock
      .expectOne((r) => r.url === FACETS_URL && r.params.get('category_id') === 'c1,c2')
      .flush(counts('Two'));
    await settle();
    env.harness.detectChanges();
    expect(env.text()).toContain('Cat Two');
    expect(env.text()).not.toContain('Cat One');
    env.httpMock.verify();
  });

  it('keeps restored counts while a later navigation runs, and asks for none on the way out', async () => {
    const env = await setup();
    await visitThenLeave(env, '/list?category_id=c1', 'A');
    await back(env);
    const requested: string[] = [];
    const router = TestBed.inject(Router);
    // Each render while the reader leaves; a counts request would show up here.
    const sub = router.events.subscribe(() => {
      env.harness.detectChanges();
      for (const req of env.httpMock.match((r) => r.url === FACETS_URL)) {
        requested.push(req.request.urlWithParams);
      }
    });
    await env.harness.navigateByUrl('/detail');
    sub.unsubscribe();
    expect(requested).toEqual([]);
    // And the entry left behind still restores.
    await back(env);
    expect(env.text()).toContain('Cat A');
    env.httpMock.expectNone((r) => r.url === FACETS_URL);
  });

  it('the server never reads or writes the store', async () => {
    const read = vi.spyOn(FacetHistoryStore.prototype, 'read');
    const write = vi.spyOn(FacetHistoryStore.prototype, 'write');
    const env = await setup('server');
    await env.harness.navigateByUrl('/list?category_id=c1');
    env.harness.detectChanges();
    await settle();
    for (const req of env.httpMock.match((r) => r.url === FACETS_URL)) req.flush(counts('S'));
    await env.harness.navigateByUrl('/detail');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    read.mockRestore();
    write.mockRestore();
  });
});
