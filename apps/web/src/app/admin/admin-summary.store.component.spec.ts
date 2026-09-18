/**
 * `AdminSummaryStore` (AECI-205, widened to three queues by AECI-922 and to four
 * by AECI-946).
 *
 * The render-level behaviour is pinned by `admin-shell.component.spec.ts` and the
 * three queue specs. What is covered here is the part no rendered surface makes
 * visible, and that a rolling deploy is the only thing which exercises in
 * production: `seed()` treats an ABSENT key, an explicit `null` and a number as
 * three different instructions.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminSummaryStore } from './admin-summary.store';

function makeStore(): AdminSummaryStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  return TestBed.inject(AdminSummaryStore);
}

describe('AdminSummaryStore', () => {
  let store: AdminSummaryStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('starts unseeded — null, not zero', () => {
    // Null is "we do not know" and 0 is "the queue is empty". A fresh store has
    // asked nobody anything, and the badge must not claim an empty backlog.
    expect(store.pendingReviews()).toBeNull();
    expect(store.pendingRequests()).toBeNull();
    expect(store.pendingClaims()).toBeNull();
    expect(store.pendingReindex()).toBeNull();
    expect(store.operationsTotal()).toBe(0);
  });

  it('sums every queue into the Operations total', () => {
    store.seed({ reviews: 5, requests: 2, claims: 3, reindex: 4 });
    expect(store.operationsTotal()).toBe(14);
  });

  it('LEAVES an absent key alone rather than zeroing it', () => {
    // The rolling-deploy case: the API Worker is still on the pre-AECI-922 shape
    // and sends `pending_reviews` alone. Zeroing the other two here would empty
    // a badge that has real numbers in it.
    store.seed({ reviews: 5, requests: 2, claims: 3, reindex: 4 });
    store.seed({ reviews: 4 });
    expect(store.pendingReviews()).toBe(4);
    expect(store.pendingRequests()).toBe(2);
    expect(store.pendingClaims()).toBe(3);
    expect(store.pendingReindex()).toBe(4);
  });

  it('treats an explicit undefined the same as absent', () => {
    store.seed({ reviews: 5, requests: 2, claims: 3 });
    store.seed({ requests: undefined });
    expect(store.pendingRequests()).toBe(2);
  });

  it('CLEARS on an explicit null — that is the server saying "not an operator"', () => {
    store.seed({ reviews: 5, requests: 2, claims: 3, reindex: 4 });
    store.seed({ reviews: null, requests: null, claims: null, reindex: null });
    expect(store.pendingReviews()).toBeNull();
    expect(store.pendingReindex()).toBeNull();
    expect(store.operationsTotal()).toBe(0);
  });

  it('decrements one queue without touching the others', () => {
    store.seed({ reviews: 5, requests: 2, claims: 3, reindex: 4 });
    store.decrement('claims');
    expect(store.pendingClaims()).toBe(2);
    expect(store.pendingReviews()).toBe(5);
    expect(store.pendingRequests()).toBe(2);
    expect(store.pendingReindex()).toBe(4);
    expect(store.operationsTotal()).toBe(13);
  });

  // AECI-946. The re-index worklist is the fourth key, and the only one whose
  // rows live outside `vendor_requests` / `reviews` — so it can never overlap the
  // other three, which is what keeps the Operations sum from double-counting.
  it('decrements the re-index queue the same way', () => {
    store.seed({ reindex: 2 });
    store.decrement('reindex');
    expect(store.pendingReindex()).toBe(1);
    expect(store.count('reindex')()).toBe(1);
  });

  // AECI-1008. Field contests are the fifth key, on `integration_field_challenges`,
  // a table no other queue reads, so the Operations sum cannot double-count them.
  it('carries field contests as a fifth queue in the sum and decrements it', () => {
    expect(store.pendingContests()).toBeNull();
    store.seed({ reviews: 5, requests: 2, claims: 3, contests: 6, reindex: 4 });
    expect(store.pendingContests()).toBe(6);
    expect(store.operationsTotal()).toBe(20);
    store.decrement('contests');
    expect(store.count('contests')()).toBe(5);
    expect(store.pendingClaims()).toBe(3);
    expect(store.operationsTotal()).toBe(19);
  });

  it('leaves the contest count alone when an older API shape omits it', () => {
    store.seed({ contests: 2 });
    store.seed({ reviews: 1, contests: undefined });
    expect(store.pendingContests()).toBe(2);
  });

  it('never decrements below zero, and never invents a count for an unseeded queue', () => {
    store.seed({ reviews: 0 });
    store.decrement('reviews');
    expect(store.pendingReviews()).toBe(0);
    // `requests` was never seeded — decrementing must not turn null into -1 or 0.
    store.decrement('requests');
    expect(store.pendingRequests()).toBeNull();
  });

  it('clamps a negative seed to zero', () => {
    store.seed({ reviews: -3 });
    expect(store.pendingReviews()).toBe(0);
  });

  it('exposes one queue by key, which is how a nav entry reads its own count', () => {
    store.seed({ requests: 7 });
    expect(store.count('requests')()).toBe(7);
    expect(store.count('claims')()).toBeNull();
  });
});
