/**
 * AECI-1008 — `AdminContestsApi` wire contract. Named `.component.spec.ts` so it
 * runs under `ng test` (needs `TestBed` for `HttpClient` DI). Asserts the two calls
 * hit the right URL, verb, params and body.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminContestsApi } from './admin-contests-api';

describe('AdminContestsApi', () => {
  let api: AdminContestsApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminContestsApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/contests with status, route and paging', async () => {
    const promise = api.listContests({ status: 'open', routed_to: 'owner', page: 1, perPage: 100 });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/contests');
    expect(req.request.params.get('status')).toBe('open');
    expect(req.request.params.get('routed_to')).toBe('owner');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined params so the server defaults apply', async () => {
    const promise = api.listContests();
    const req = httpMock.expectOne('/api/admin/contests');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 25, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/contests/:id with the decision and note', async () => {
    const promise = api.decide('k-1', { decision: 'decline', note: 'The docs say otherwise.' });
    const req = httpMock.expectOne('/api/admin/contests/k-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ decision: 'decline', note: 'The docs say otherwise.' });
    req.flush({ id: 'k-1' });
    await promise;
  });

  it('URL-encodes the id', async () => {
    const promise = api.decide('a/b', { decision: 'accept' });
    const req = httpMock.expectOne('/api/admin/contests/a%2Fb');
    expect(req.request.body).toEqual({ decision: 'accept' });
    req.flush({ id: 'a/b' });
    await promise;
  });
});
