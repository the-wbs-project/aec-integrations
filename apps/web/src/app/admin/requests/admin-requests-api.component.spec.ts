/**
 * AECI-217 / Phase 6.10 — `AdminRequestsApi` wire contract. Named
 * `.component.spec.ts` so it runs under `ng test` (needs Angular's `TestBed` for
 * `HttpClient` DI). Asserts the two calls hit the right URL/verb/params/body so the
 * dashboard talks to the 6.9 endpoints exactly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminRequestsApi } from './admin-requests-api';

describe('AdminRequestsApi', () => {
  let api: AdminRequestsApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminRequestsApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/requests with the query params', async () => {
    const promise = api.listRequests({ status: 'open', kind: 'claim', page: 1, perPage: 100 });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/requests');
    expect(req.request.params.get('status')).toBe('open');
    expect(req.request.params.get('kind')).toBe('claim');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined query params', async () => {
    const promise = api.listRequests();
    const req = httpMock.expectOne('/api/admin/requests');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/requests/:id to resolve (no reason)', async () => {
    const promise = api.moderate('req-1', { action: 'resolve' });
    const req = httpMock.expectOne('/api/admin/requests/req-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'resolve' });
    req.flush({ id: 'req-1', status: 'resolved' });
    await promise;
  });

  it('PATCHes with the reject reason and URL-encodes the id', async () => {
    const promise = api.moderate('a/b', { action: 'reject', reason: 'Spam' });
    const req = httpMock.expectOne('/api/admin/requests/a%2Fb');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'reject', reason: 'Spam' });
    req.flush({ id: 'a/b', status: 'rejected' });
    await promise;
  });
});
