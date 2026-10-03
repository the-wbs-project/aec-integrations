/**
 * AECI-1177 — `AdminReviewResponsesApi` wire contract. Named `.component.spec.ts`
 * so it runs under `ng test` (needs `TestBed` for `HttpClient` DI). Asserts the two
 * calls hit the right URL, verb, params and body.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminReviewResponsesApi } from './admin-review-responses-api';

describe('AdminReviewResponsesApi', () => {
  let api: AdminReviewResponsesApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AdminReviewResponsesApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/review-responses with status and paging', async () => {
    const promise = api.listReplies({ status: 'published', page: 1, perPage: 100 });
    const req = httpMock.expectOne(
      (r) => r.method === 'GET' && r.url === '/api/admin/review-responses',
    );
    expect(req.request.params.get('status')).toBe('published');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined params so the server default (pending) applies', async () => {
    const promise = api.listReplies();
    const req = httpMock.expectOne('/api/admin/review-responses');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 25, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/review-responses/:id with the decision and reason', async () => {
    const promise = api.decide('r-1', {
      decision: 'reject',
      reason: 'It names the reviewer.',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    const req = httpMock.expectOne('/api/admin/review-responses/r-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      decision: 'reject',
      reason: 'It names the reviewer.',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    req.flush({ id: 'r-1' });
    await promise;
  });

  it('URL-encodes the id', async () => {
    const promise = api.decide('a/b', {
      decision: 'approve',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    const req = httpMock.expectOne('/api/admin/review-responses/a%2Fb');
    expect(req.request.body).toEqual({
      decision: 'approve',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    req.flush({ id: 'a/b' });
    await promise;
  });
});
