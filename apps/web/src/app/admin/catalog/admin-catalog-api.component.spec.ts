/**
 * AECI-579 / Phase 8.3 P1.5 — `AdminCatalogApi` wire contract. Named
 * `.component.spec.ts` so it runs under `ng test` (needs Angular's `TestBed` for
 * `HttpClient` DI). Asserts both calls hit the right URL/verb/params, so the
 * screen talks to the §6 endpoints exactly.
 *
 * The `timeseries` case matters beyond plumbing: the catalog screen deliberately
 * reads its counts-over-time from `/api/admin/metrics/timeseries` rather than
 * from `/catalog/coverage`, so there is one implementation of that series.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminCatalogApi } from './admin-catalog-api';

describe('AdminCatalogApi', () => {
  let api: AdminCatalogApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminCatalogApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/catalog/coverage with no params by default', async () => {
    const promise = api.coverage();
    const req = httpMock.expectOne(
      (r) => r.method === 'GET' && r.url === '/api/admin/catalog/coverage',
    );
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ ok: true });
    await promise;
  });

  it('passes the sample cap through, including 0', async () => {
    // `sample=0` is a real request (counts only), so it must not be dropped by a
    // falsy check.
    const promise = api.coverage(0);
    const req = httpMock.expectOne((r) => r.url === '/api/admin/catalog/coverage');
    expect(req.request.params.get('sample')).toBe('0');
    req.flush({ ok: true });
    await promise;
  });

  it('GETs /api/admin/metrics/timeseries with metric, basis, and the inclusive date range', async () => {
    const promise = api.timeseries('catalog.products_created', '2026-07-15', '2026-08-13', 'net');
    const req = httpMock.expectOne(
      (r) => r.method === 'GET' && r.url === '/api/admin/metrics/timeseries',
    );
    expect(req.request.params.get('metric')).toBe('catalog.products_created');
    expect(req.request.params.get('from')).toBe('2026-07-15');
    expect(req.request.params.get('to')).toBe('2026-08-13');
    expect(req.request.params.get('basis')).toBe('net');
    req.flush({ points: [] });
    await promise;
  });

  // The endpoint DEFAULTS to `basis=additions`, so an omitted param silently
  // restores the audit-log reading this screen moved off (AECI-686). The param is
  // therefore always sent explicitly, and this asserts it rather than trusting it.
  it('always sends basis explicitly, never relying on the endpoint default', async () => {
    const promise = api.timeseries('catalog.claims_created', '2026-07-15', '2026-08-13', 'net');
    const req = httpMock.expectOne(
      (r) => r.method === 'GET' && r.url === '/api/admin/metrics/timeseries',
    );
    expect(req.request.params.has('basis')).toBe(true);
    req.flush({ points: [] });
    await promise;
  });
});
