/**
 * AECI-260 — `AccountApi.findMyReviewForProduct` wire contract + request
 * coalescing. Named `.component.spec.ts` so it runs under `ng test` (needs
 * Angular's `TestBed` for `HttpClient` DI). The two `aec-review-cta` instances
 * on a product page (hero + Reviews section) both probe this after hydration,
 * so concurrent calls for the same product must share one request.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountApi } from './account-api';

const PRODUCT_ID = '00000000-0000-4000-8000-000000020001';

describe('AccountApi.findMyReviewForProduct', () => {
  let api: AccountApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AccountApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  // `expectOne(string)` matches the full URL-with-params; match the bare path
  // so the per-call query string (`?perPage=1&product_id=…`) doesn't matter.
  const expectReviewsReq = () => httpMock.expectOne((r) => r.url === '/api/account/reviews');

  it('GETs /api/account/reviews scoped to the product and returns the first review', async () => {
    const promise = api.findMyReviewForProduct(PRODUCT_ID);
    const req = expectReviewsReq();
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('product_id')).toBe(PRODUCT_ID);
    expect(req.request.params.get('perPage')).toBe('1');
    req.flush({ data: [{ id: 'rev-1' }], page: 1, perPage: 1, total: 1 });
    await expect(promise).resolves.toEqual({ id: 'rev-1' });
  });

  it('resolves to null when the caller has no review for the product', async () => {
    const promise = api.findMyReviewForProduct(PRODUCT_ID);
    expectReviewsReq().flush({ data: [], page: 1, perPage: 1, total: 0 });
    await expect(promise).resolves.toBeNull();
  });

  it('coalesces concurrent probes for the same product into one request', async () => {
    const a = api.findMyReviewForProduct(PRODUCT_ID);
    const b = api.findMyReviewForProduct(PRODUCT_ID);

    // `expectOne` asserts exactly one matching request despite the two callers.
    expectReviewsReq().flush({ data: [{ id: 'rev-1' }], page: 1, perPage: 1, total: 1 });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ id: 'rev-1' });
    // Both callers got the same shared result.
    expect(rb).toBe(ra);
  });

  it('re-fetches after the in-flight probe settles (no stale caching across visits)', async () => {
    const first = api.findMyReviewForProduct(PRODUCT_ID);
    expectReviewsReq().flush({ data: [], page: 1, perPage: 1, total: 0 });
    expect(await first).toBeNull();

    // A later probe is a fresh request — the coalescing entry was cleared on settle.
    const second = api.findMyReviewForProduct(PRODUCT_ID);
    expectReviewsReq().flush({ data: [{ id: 'rev-9' }], page: 1, perPage: 1, total: 1 });
    expect(await second).toEqual({ id: 'rev-9' });
  });
});
