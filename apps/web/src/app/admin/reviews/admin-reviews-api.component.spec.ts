/**
 * AECI-205 / Phase 5.14 — `AdminReviewsApi` wire contract. Named
 * `.component.spec.ts` so it runs under `ng test` (needs Angular's `TestBed` for
 * `HttpClient` DI). Asserts the two calls hit the right URL/verb/body so the
 * queue talks to the 5.13 endpoints exactly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminReviewsApi } from './admin-reviews-api';

describe('AdminReviewsApi', () => {
  let api: AdminReviewsApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminReviewsApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/reviews with the query params', async () => {
    const promise = api.listPending({
      status: 'pending',
      sort: 'queue_age',
      page: 1,
      perPage: 100,
    });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/reviews');
    expect(req.request.params.get('status')).toBe('pending');
    expect(req.request.params.get('sort')).toBe('queue_age');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined query params', async () => {
    const promise = api.listPending();
    const req = httpMock.expectOne('/api/admin/reviews');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/reviews/:id to approve', async () => {
    const promise = api.moderate('rev-1', { action: 'approve' });
    const req = httpMock.expectOne('/api/admin/reviews/rev-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'approve' });
    req.flush({ id: 'rev-1', status: 'approved' });
    await promise;
  });

  it('PATCHes with the rejection reason and URL-encodes the id', async () => {
    const promise = api.moderate('a/b', { action: 'reject', rejection_reason: 'Spam' });
    const req = httpMock.expectOne('/api/admin/reviews/a%2Fb');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'reject', rejection_reason: 'Spam' });
    req.flush({ id: 'a/b', status: 'rejected' });
    await promise;
  });
});
