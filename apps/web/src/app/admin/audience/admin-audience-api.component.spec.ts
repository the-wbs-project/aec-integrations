/**
 * AECI-586 / Phase 8.3 P5.1 — `AdminAudienceApi` wire contract. Named
 * `.component.spec.ts` so it runs under `ng test` (needs Angular's `TestBed` for
 * `HttpClient` DI). Asserts both calls hit the right URL/verb/params, so the
 * screen talks to the §6 endpoints exactly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminAudienceApi } from './admin-audience-api';

describe('AdminAudienceApi', () => {
  let api: AdminAudienceApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminAudienceApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/audience with the inclusive date range', async () => {
    const promise = api.audience({ from: '2026-05-16', to: '2026-08-13' });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/audience');

    expect(req.request.params.get('from')).toBe('2026-05-16');
    expect(req.request.params.get('to')).toBe('2026-08-13');
    // Omitted rather than sent as an empty value, so the API's own default applies.
    expect(req.request.params.has('breakdown_limit')).toBe(false);
    req.flush({ ok: true });
    await promise;
  });

  it('passes the breakdown cap through when given', async () => {
    const promise = api.audience({ from: '2026-05-16', to: '2026-08-13', breakdownLimit: 8 });
    const req = httpMock.expectOne((r) => r.url === '/api/admin/audience');

    expect(req.request.params.get('breakdown_limit')).toBe('8');
    req.flush({ ok: true });
    await promise;
  });

  it('GETs /api/admin/feedback with the page pair', async () => {
    const promise = api.feedback({ page: 2, perPage: 10 });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/feedback');

    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('perPage')).toBe('10');
    req.flush({ data: [] });
    await promise;
  });
});
