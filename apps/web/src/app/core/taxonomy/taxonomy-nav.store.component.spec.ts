import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, PLATFORM_ID, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TaxonomyResponse, TaxonomyTermWithCount } from '@aeci/shared';

import { settle } from '../testing/index-page.harness';

import { TaxonomyNavStore } from './taxonomy-nav.store';

function term(slug: string, productCount: number, displayOrder = 0): TaxonomyTermWithCount {
  return {
    id: slug,
    slug,
    name: slug.toUpperCase(),
    description: null,
    display_order: displayOrder,
    product_count: productCount,
  };
}

// 12 categories with shuffled counts so the top-10 cap and the descending sort
// are both exercised; phases stay small so `phasesAll` returns every term. The
// phase fixture intentionally inverts count vs. display_order — `closeout` has
// the higher count but the later lifecycle slot — so the assertion proves
// `phasesAll` orders by `display_order`, not popularity.
const RESPONSE: TaxonomyResponse = {
  categories: Array.from({ length: 12 }, (_, i) => term(`cat-${i}`, i)),
  audiences: [term('aud-a', 2), term('aud-b', 9), term('aud-c', 5)],
  phases: [term('closeout', 8, 50), term('design', 3, 20)],
  // AECI-541 — the fourth facet travels on the aggregate response. Nav surfacing
  // of trades lands with the browse pages (AECI-544); this store ignores it today.
  trades: [term('electrical', 4, 10)],
};

/**
 * Host that activates the root `TaxonomyNavStore` and renders a value off it so
 * the `httpResource` dispatch effect runs under change detection — mirroring the
 * `createPaginatedIndex` spec's host pattern.
 */
@Component({
  template: `<span class="count">{{ store.categoriesTop10().length }}</span>`,
})
class StoreHost {
  readonly store = inject(TaxonomyNavStore);
}

describe('TaxonomyNavStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches /api/taxonomy once; ranks categories/audiences by count, phases by display_order', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(StoreHost);
    fixture.detectChanges();

    const req = httpMock.expectOne('/api/taxonomy');
    expect(req.request.method).toBe('GET');
    req.flush(RESPONSE);
    await settle();
    fixture.detectChanges();

    const store = fixture.componentInstance.store;
    // Categories cap at 10 and sort descending (counts 11 → 2).
    expect(store.categoriesTop10()).toHaveLength(10);
    expect(store.categoriesTop10()[0]?.product_count).toBe(11);
    expect(store.categoriesTop10()[9]?.product_count).toBe(2);
    // Audiences sort descending.
    expect(store.audiencesTop10().map((t) => t.slug)).toEqual(['aud-b', 'aud-c', 'aud-a']);
    // Phases return all terms in lifecycle (display_order) order — `design` (20)
    // before `closeout` (50), despite `closeout` having the higher count.
    expect(store.phasesAll().map((t) => t.slug)).toEqual(['design', 'closeout']);

    httpMock.verify();
  });

  it('issues no request during SSR (server platform) and exposes empty facets', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(StoreHost);
    fixture.detectChanges();
    await settle();

    httpMock.expectNone('/api/taxonomy');
    expect(fixture.componentInstance.store.categoriesTop10()).toEqual([]);
    expect(fixture.componentInstance.store.phasesAll()).toEqual([]);
    httpMock.verify();
  });
});
