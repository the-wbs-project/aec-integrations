/**
 * AECI-218 / Phase 6.11 — `ReviewerBansApi` wire contract. Named
 * `.component.spec.ts` so it runs under `ng test` (needs Angular's `TestBed` for
 * `HttpClient` DI). Asserts each call hits the right URL/verb/body so the prompt
 * + bans page talk to the 6.11 endpoints exactly.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReviewerBansApi } from './reviewer-bans-api';

describe('ReviewerBansApi', () => {
  let api: ReviewerBansApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ReviewerBansApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/admin/reviewers with the query params', async () => {
    const promise = api.listBanned({ page: 1, perPage: 100 });
    const req = httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/admin/reviewers');
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('perPage')).toBe('100');
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await expect(promise).resolves.toEqual({ data: [], page: 1, perPage: 100, total: 0 });
  });

  it('omits undefined query params', async () => {
    const promise = api.listBanned();
    const req = httpMock.expectOne('/api/admin/reviewers');
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ data: [], page: 1, perPage: 100, total: 0 });
    await promise;
  });

  it('PATCHes /api/admin/reviewers/:id to ban with a reason', async () => {
    const promise = api.ban('rev-1', { action: 'ban', reason: 'Coordinated spam.' });
    const req = httpMock.expectOne('/api/admin/reviewers/rev-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'ban', reason: 'Coordinated spam.' });
    req.flush({
      reviewer_id: 'rev-1',
      banned_at: '2026-06-13T00:00:00.000Z',
      ban_reason: 'Coordinated spam.',
    });
    await promise;
  });

  it('PATCHes to unban and URL-encodes the id', async () => {
    const promise = api.ban('a/b', { action: 'unban' });
    const req = httpMock.expectOne('/api/admin/reviewers/a%2Fb');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ action: 'unban' });
    req.flush({ reviewer_id: 'a/b', banned_at: null, ban_reason: null });
    await promise;
  });
});
