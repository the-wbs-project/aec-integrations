/**
 * AECI-521 — `AdminClaimsApi` wire contract. Named `.component.spec.ts` so it runs
 * under `ng test` (needs Angular's `TestBed` for `HttpClient` DI). Asserts the two
 * calls hit the right URL/verb/params/body so the reviewer surface talks to the
 * claims LIST (AECI-521) + grant/reject PATCH (AECI-519) exactly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminClaimsApi } from './admin-claims-api';

describe('AdminClaimsApi', () => {
  let api: AdminClaimsApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminClaimsApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/claims with the query params', async () => {
    const promise = api.listClaims({ status: 'open', page: 1, perPage: 100 });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/claims');
    expect(req.request.params.get('status')).toBe('open');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined query params', async () => {
    const promise = api.listClaims();
    const req = httpMock.expectOne('/api/admin/claims');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/claims/:id to approve with the entitlement note', async () => {
    const promise = api.moderate('claim-1', {
      action: 'approve',
      entitlement: { notes: 'PO #4471' },
    });
    const req = httpMock.expectOne('/api/admin/claims/claim-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'approve', entitlement: { notes: 'PO #4471' } });
    req.flush({ request: { id: 'claim-1' }, grant: null });
    await promise;
  });

  it('PATCHes to reject with a reason and URL-encodes the id', async () => {
    const promise = api.moderate('a/b', { action: 'reject', reason: 'Not a real claim.' });
    const req = httpMock.expectOne('/api/admin/claims/a%2Fb');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'reject', reason: 'Not a real claim.' });
    req.flush({ request: { id: 'a/b' }, grant: null });
    await promise;
  });
});
