/**
 * AECI-1223 — `AdminEmailApi` wire contract. Named `.component.spec.ts` so it runs under
 * `ng test` (needs `TestBed` for `HttpClient` DI).
 *
 * The load-bearing assertion: an address travels in a POST body and never in a URL. Both
 * Workers log request URLs, so an address in a query string would be written to the logs
 * on every search (`ADMIN_PANEL_SPEC.md` §5.14, §13 D23).
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminEmailApi } from './admin-email-api';

describe('AdminEmailApi', () => {
  let api: AdminEmailApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminEmailApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs the summary', async () => {
    const promise = api.summary();
    const req = httpMock.expectOne('/api/admin/email/summary');
    expect(req.request.method).toBe('GET');
    req.flush({});
    await promise;
  });

  it('GETs the list with only the filters that are set', async () => {
    const promise = api.listSends({ page: 2, perPage: 25, outcome: 'failed', from: '2026-10-01' });
    const req = httpMock.expectOne((r) => r.url === '/api/admin/email/sends');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys().sort()).toEqual(['from', 'outcome', 'page', 'perPage']);
    req.flush({ data: [], page: 2, perPage: 25, total: 0 });
    await promise;
  });

  it('POSTs an address search with the address in the body, never the URL', async () => {
    const promise = api.searchSends('dana@acme.com', {
      page: 1,
      perPage: 25,
      template: 'claim-approved',
    });
    const req = httpMock.expectOne((r) => r.url === '/api/admin/email/sends/search');
    expect(req.request.method).toBe('POST');
    expect(req.request.urlWithParams).not.toContain('dana');
    expect(req.request.params.keys()).toEqual([]);
    expect(req.request.body).toEqual({
      address: 'dana@acme.com',
      page: 1,
      perPage: 25,
      template: 'claim-approved',
    });
    req.flush({ data: [], page: 1, perPage: 25, total: 0, unmatched_events: [] });
    await promise;
  });
});
