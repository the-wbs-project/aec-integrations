/**
 * AECI-577 — `AdminPageViewsApi` wire contract.
 *
 * Mirrors `admin-requests-api.component.spec.ts`: asserts the URLs and the exact
 * query params, because a silently-dropped filter param is indistinguishable
 * from "no rows matched" on the screen.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminPageViewsApi } from './admin-page-views-api';

let api: AdminPageViewsApi;
let httpMock: HttpTestingController;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  api = TestBed.inject(AdminPageViewsApi);
  httpMock = TestBed.inject(HttpTestingController);
});
afterEach(() => httpMock.verify());

function expectGet(url: string) {
  return httpMock.expectOne((r) => r.method === 'GET' && r.url === url);
}

describe('AdminPageViewsApi', () => {
  it('GETs /api/admin/page-views with every filter param', async () => {
    const promise = api.listPageViews({
      from: '2026-08-04',
      to: '2026-08-10',
      traffic: 'bot',
      source: 'Google',
      country: 'ID',
      path_contains: '/products',
      exclude_internal: true,
      page: 2,
      perPage: 50,
    });

    const req = expectGet('/api/admin/page-views');
    const p = req.request.params;
    expect(p.get('from')).toBe('2026-08-04');
    expect(p.get('to')).toBe('2026-08-10');
    expect(p.get('traffic')).toBe('bot');
    expect(p.get('source')).toBe('Google');
    expect(p.get('country')).toBe('ID');
    expect(p.get('path_contains')).toBe('/products');
    // The endpoint takes '0' | '1', not 'true'.
    expect(p.get('exclude_internal')).toBe('1');
    expect(p.get('page')).toBe('2');
    expect(p.get('perPage')).toBe('50');

    req.flush({ data: [] });
    await expect(promise).resolves.toEqual({ data: [] });
  });

  it('omits unset filters rather than sending empty values', async () => {
    const promise = api.listPageViews({
      from: '2026-08-04',
      to: '2026-08-10',
      exclude_internal: false,
      path_contains: '',
    });

    const req = expectGet('/api/admin/page-views');
    const p = req.request.params;
    expect(p.has('source')).toBe(false);
    expect(p.has('country')).toBe(false);
    // An empty string would filter to "paths containing nothing", not "no filter".
    expect(p.has('path_contains')).toBe(false);
    // …but an explicit `false` still travels, so the server never has to guess.
    expect(p.get('exclude_internal')).toBe('0');

    req.flush({ data: [] });
    await promise;
  });

  it('reads filter options off the breakdown endpoint across the whole population', async () => {
    const promise = api.listFilterOptions('country', '2026-08-04', '2026-08-10');
    const req = expectGet('/api/admin/traffic/breakdown');
    const p = req.request.params;
    expect(p.get('dimension')).toBe('country');
    expect(p.get('from')).toBe('2026-08-04');
    expect(p.get('to')).toBe('2026-08-10');
    // 'all' on purpose: the list of AVAILABLE countries should not shrink just
    // because the feed is currently showing bots.
    expect(p.get('traffic')).toBe('all');
    expect(p.get('perPage')).toBe('100');

    req.flush({ data: [] });
    await promise;
  });
});
