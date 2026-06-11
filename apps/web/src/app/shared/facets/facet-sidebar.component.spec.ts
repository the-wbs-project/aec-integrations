import { Component, signal } from '@angular/core';
import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductFacetsResponse, TaxonomyTermWithCount } from '@aeci/shared';

import { createIndexSetup, settle } from '../../core/testing/index-page.harness';
import type { TaxonomyKind } from '../taxonomy-badge/taxonomy-badge';

import { FacetSidebar } from './facet-sidebar';

/**
 * AECI-143 — drives `FacetSidebar` through a host so the optional `lockedKind` /
 * `lockedId` inputs are bindable. Reuses the `createIndexSetup` TestBed wiring
 * (HttpClient testing + router) so `route.queryParamMap` reflects the URL and
 * `router.navigate(..., merge)` round-trips, exactly as on `/products` and the
 * browse pages.
 */
@Component({
  imports: [FacetSidebar],
  template: `<aec-facet-sidebar [lockedKind]="kind()" [lockedId]="lockedId()" />`,
})
class FacetSidebarHost {
  readonly kind = signal<TaxonomyKind | undefined>(undefined);
  readonly lockedId = signal<string | undefined>(undefined);
}

const FACETS_URL = '/api/products/facets';

function term(id: string, name: string, count: number): TaxonomyTermWithCount {
  return { id, name, slug: id, description: null, display_order: 0, product_count: count };
}

function facets(parts: Partial<ProductFacetsResponse>): ProductFacetsResponse {
  return { categories: [], audiences: [], phases: [], ...parts };
}

/** Flush any still-pending facets requests (a toggle re-fetches scoped counts). */
function drain(httpMock: HttpTestingController): void {
  for (const req of httpMock.match((r) => r.url === FACETS_URL)) {
    req.flush(facets({}));
  }
}

function legends(root: HTMLElement): string[] {
  return [...root.querySelectorAll('legend')].map((l) => l.textContent?.trim() ?? '');
}

describe('FacetSidebar (AECI-143)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('fetches scoped counts and renders one group per dimension with counts', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c1', 'Cat One', 3)],
          audiences: [term('a1', 'Aud One', 2)],
          phases: [term('p1', 'Phase One', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(legends(root)).toEqual(['Categories', 'Audiences', 'Phases']);
    const text = root.textContent ?? '';
    expect(text).toContain('Cat One');
    expect(text).toContain('3');
    httpMock.verify();
  });

  it('hides count-0 terms but keeps the active one', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?category_id=c-active');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [
            term('c-active', 'Active', 0), // count 0 but refined → shown
            term('c-other', 'Other', 0), // count 0, not refined → hidden
            term('c-has', 'Has', 4),
          ],
        }),
      );
    await settle();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Active');
    expect(text).toContain('Has');
    expect(text).not.toContain('Other');
    httpMock.verify();
  });

  it('single-selects a term: navigates ?category_id and resets page', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?page=3');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(facets({ categories: [term('c1', 'Cat One', 3)] }));
    await settle();
    fixture.detectChanges();

    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      'fieldset input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.dispatchEvent(new Event('change'));
    await settle();

    expect(router.url).toBe('/products?page=1&category_id=c1');
    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('toggles the active term off when clicked again', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?category_id=c1');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(facets({ categories: [term('c1', 'Cat One', 3)] }));
    await settle();
    fixture.detectChanges();

    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      'fieldset input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.dispatchEvent(new Event('change'));
    await settle();

    expect(router.url).toBe('/products?page=1');
    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('clear filters removes every active cross-filter', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?category_id=c1&audience_id=a1');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c1', 'Cat One', 3)],
          audiences: [term('a1', 'Aud One', 2)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const clearBtn = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (b) => b.textContent?.includes('Clear filters'),
    );
    expect(clearBtn).toBeTruthy();
    clearBtn!.click();
    await settle();

    expect(router.url).toBe('/products?page=1');
    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('keeps the prior terms on screen while a toggle refetches scoped counts (no blank flash)', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(facets({ categories: [term('c1', 'Cat One', 3)] }));
    await settle();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('Cat One');

    // Toggle the term: the counts refetch (request now in flight, not flushed).
    // The sidebar must keep rendering the prior terms instead of emptying to [].
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      'fieldset input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.dispatchEvent(new Event('change'));
    await settle();
    fixture.detectChanges();

    // The refetch is in flight; assert the prior term is still rendered, then
    // resolve the in-flight request(s).
    const inFlight = httpMock.match((r) => r.url === FACETS_URL);
    expect(inFlight.length).toBeGreaterThan(0);
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('Cat One');

    for (const req of inFlight) req.flush(facets({}));
    httpMock.verify();
  });

  it('locks (and hides) its own dimension and sends the locked id', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.componentInstance.kind.set('category');
    fixture.componentInstance.lockedId.set('cat-locked');
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === FACETS_URL);
    expect(req.request.params.get('category_id')).toBe('cat-locked');
    req.flush(
      facets({
        categories: [term('cat-locked', 'Locked', 9)],
        audiences: [term('a1', 'Aud', 2)],
        phases: [term('p1', 'Phase', 1)],
      }),
    );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(legends(root)).toEqual(['Audiences', 'Phases']);
    expect(root.textContent ?? '').not.toContain('Locked');
    httpMock.verify();
  });
});
