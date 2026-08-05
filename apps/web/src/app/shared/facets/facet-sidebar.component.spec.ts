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
  return { categories: [], audiences: [], phases: [], trades: [], ...parts };
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

  it('adds the first term to a dimension: navigates ?category_id and resets page', async () => {
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

  it('multi-selects: a second term in the same dimension appends a sorted CSV (AECI-223)', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    // `c-m` already active; clicking sibling `c-a` must produce a SORTED list —
    // proving click order never forks the cache key.
    await router.navigateByUrl('/products?category_id=c-m');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c-m', 'Cat M', 3), term('c-a', 'Cat A', 4)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const boxes = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>(
        'fieldset input[type="checkbox"]',
      ),
    ];
    expect(boxes[0]!.checked).toBe(true); // c-m active
    expect(boxes[1]!.checked).toBe(false); // c-a not yet
    boxes[1]!.dispatchEvent(new Event('change')); // add c-a
    await settle();

    // Sorted ('c-a,c-m'), not insertion order ('c-m,c-a'). Query-param ORDER in
    // the URL is incidental (the cache key sorts params); the CSV value is what
    // must be sorted.
    expect(router.url).toBe('/products?category_id=c-a,c-m&page=1');
    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('removes one term from a multi-selection, keeping the rest (AECI-223)', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?category_id=c-a,c-m');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c-m', 'Cat M', 3), term('c-a', 'Cat A', 4)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const boxes = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>(
        'fieldset input[type="checkbox"]',
      ),
    ];
    // Both active (set membership, order-independent).
    expect(boxes.every((b) => b.checked)).toBe(true);
    boxes[0]!.dispatchEvent(new Event('change')); // remove c-m
    await settle();

    expect(router.url).toBe('/products?category_id=c-a&page=1');
    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('toggles the last active term off, dropping the param entirely', async () => {
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

  it('mobile: the facet panel starts collapsed and the trigger toggles it', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(facets({ categories: [term('c1', 'Cat One', 3)] }));
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const panel = root.querySelector('#aec-facet-panel') as HTMLElement;
    const trigger = root.querySelector(
      'button[aria-controls="aec-facet-panel"]',
    ) as HTMLButtonElement;

    // Collapsed by default: aria-expanded=false and the panel carries `hidden`.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList.contains('hidden')).toBe(true);

    trigger.click();
    await settle();
    fixture.detectChanges();

    // Expanded: aria-expanded=true and `hidden` is dropped (flex on mobile).
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.classList.contains('hidden')).toBe(false);
    httpMock.verify();
  });

  it('mobile trigger shows a badge with the active cross-filter count', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?category_id=c1,c2&audience_id=a1');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c1', 'Cat One', 3), term('c2', 'Cat Two', 2)],
          audiences: [term('a1', 'Aud One', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-controls="aec-facet-panel"]',
    ) as HTMLButtonElement;
    // Three selected terms: c1, c2, a1.
    expect(trigger.textContent).toContain('3');

    fixture.detectChanges();
    drain(httpMock);
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
