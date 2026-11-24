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
  return { categories: [], audiences: [], phases: [], trades: [], connector_kinds: [], ...parts };
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
          trades: [term('t1', 'Trade One', 4)],
          phases: [term('p1', 'Phase One', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    // Order is `DIMENSIONS` order (AECI-544): trades sit between audiences and
    // phases on every surface, including the `/search` refinement rail.
    expect(legends(root)).toEqual(['Categories', 'Audiences', 'Trades', 'Phases']);
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

    // Read the term rows, not the whole panel: the order caption under the
    // panel says "Other terms A to Z" (AECI-1793).
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('fieldset label'),
    ).map((label) => label.textContent ?? '');
    expect(labels.some((t) => t.includes('Active'))).toBe(true);
    expect(labels.some((t) => t.includes('Has'))).toBe(true);
    expect(labels.some((t) => t.includes('Other'))).toBe(false);
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
        trades: [term('t1', 'Trade', 5)],
        phases: [term('p1', 'Phase', 1)],
      }),
    );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(legends(root)).toEqual(['Audiences', 'Trades', 'Phases']);
    expect(root.textContent ?? '').not.toContain('Locked');
    httpMock.verify();
  });

  it('locks (and hides) the trades dimension on a /trades/:slug browse page', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.componentInstance.kind.set('trade');
    fixture.componentInstance.lockedId.set('trade-locked');
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === FACETS_URL);
    expect(req.request.params.get('trade_id')).toBe('trade-locked');
    req.flush(
      facets({
        categories: [term('c1', 'Cat', 3)],
        audiences: [term('a1', 'Aud', 2)],
        trades: [term('trade-locked', 'Locked Trade', 9)],
        phases: [term('p1', 'Phase', 1)],
      }),
    );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(legends(root)).toEqual(['Categories', 'Audiences', 'Phases']);
    expect(root.textContent ?? '').not.toContain('Locked Trade');
    httpMock.verify();
  });

  it('toggles a trade into a sorted trade_id CSV', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?trade_id=t-zzz');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          trades: [term('t-aaa', 'Electrical', 3), term('t-zzz', 'Roofing', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    boxes[0]!.dispatchEvent(new Event('change'));
    await settle();

    // Sorted CSV regardless of click order — keeps the edge cache key stable.
    expect(router.url).toContain('trade_id=t-aaa,t-zzz');

    fixture.detectChanges();
    drain(httpMock);
    httpMock.verify();
  });

  it('does NOT apply the trades publication floor — its counts are scoped', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          // The sidebar's rule is scoped `count > 0`, never the global floor: a
          // disjunctive count can't express one (TRADES_VOCABULARY.md §6).
          //
          // NOTE — this assertion is currently weak, and no fixture can fix it.
          // It discriminated when TRADE_PUBLISH_MIN_PRODUCTS was 3 (a count of 1
          // was sub-floor, so a floor-applying sidebar would have hidden it). At
          // the present floor of 1 the only sub-floor count is 0, which the
          // sidebar hides for its own `count > 0` reason — so no count tells the
          // two behaviours apart, and this passes either way. Kept as a
          // regression guard on trades rendering at all; if the floor is ever
          // raised again, drop this count below it to restore the teeth.
          trades: [term('t-thin', 'Thin Trade', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(legends(root)).toEqual(['Trades']);
    expect(root.textContent ?? '').toContain('Thin Trade');
    httpMock.verify();
  });
});

describe('FacetSidebar, mock-up 10 shell (AECI-1793)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(url: string) {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl(url);
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c1', 'Cat One', 3), term('c2', 'Cat Two', 2)],
          phases: [term('p1', 'Phase One', 1)],
        }),
      );
    await settle();
    fixture.detectChanges();
    return { httpMock, root: fixture.nativeElement as HTMLElement };
  }

  it('states the directory order under the panel, inside the disclosure (rulings 5 and 6)', async () => {
    const { httpMock, root } = await render('/products');
    const panel = root.querySelector('#aec-facet-panel')!;
    const note = panel.lastElementChild!;
    expect(note.tagName).toBe('P');
    expect(note.textContent?.trim()).toBe('Phases in project order. Other terms A to Z.');
    httpMock.verify();
  });

  /** The caption under the panel: its last child. */
  const caption = (root: HTMLElement) =>
    root.querySelector('#aec-facet-panel')!.lastElementChild!.textContent?.trim();

  it('names only the groups shown: a phase term page hides Phases, so the caption drops them (AECI-1794)', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'phases');
    await router.navigateByUrl('/phases');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.componentInstance.kind.set('phase');
    fixture.componentInstance.lockedId.set('p1');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    // Before the counts load the caption follows the lock alone.
    expect(caption(root)).toBe('Terms A to Z.');

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({
          categories: [term('c1', 'Cat One', 3)],
          audiences: [term('a1', 'Aud One', 2)],
          // The API still returns phases; the locked group is hidden.
          phases: [term('p1', 'Phase One', 3)],
        }),
      );
    await settle();
    fixture.detectChanges();

    expect(legends(root)).not.toContain('Phases');
    expect(caption(root)).toBe('Terms A to Z.');
    httpMock.verify();
  });

  it('keeps the directory caption on a category term page, which still shows Phases', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'categories');
    await router.navigateByUrl('/categories');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.componentInstance.kind.set('category');
    fixture.componentInstance.lockedId.set('c1');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(caption(root)).toBe('Phases in project order. Other terms A to Z.');

    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({ audiences: [term('a1', 'Aud One', 2)], phases: [term('p1', 'Phase One', 1)] }),
      );
    await settle();
    fixture.detectChanges();

    expect(legends(root)).toContain('Phases');
    expect(caption(root)).toBe('Phases in project order. Other terms A to Z.');
    httpMock.verify();
  });

  it('drops Phases from the caption when no phase term is left to show', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === FACETS_URL)
      .flush(
        facets({ categories: [term('c1', 'Cat One', 3)], phases: [term('p1', 'Phase One', 0)] }),
      );
    await settle();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(legends(root)).not.toContain('Phases');
    expect(caption(root)).toBe('Terms A to Z.');
    httpMock.verify();
  });

  it('draws every term row as a 36px label holding a 20px checkbox', async () => {
    const { httpMock, root } = await render('/products');
    const rows = [...root.querySelectorAll('fieldset label')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.classList.contains('min-h-9')).toBe(true);
      const box = row.querySelector('input[type="checkbox"]')!;
      expect(box.classList.contains('size-5')).toBe(true);
    }
    httpMock.verify();
  });

  it('names the active count in the trigger, not only in the badge', async () => {
    const { httpMock, root } = await render('/products?category_id=c1,c2');
    const trigger = root.querySelector('button[aria-controls="aec-facet-panel"]')!;
    expect(trigger.querySelector('.sr-only')?.textContent?.trim()).toBe(', 2 active');
    expect(trigger.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('2');
    drain(httpMock);
    httpMock.verify();
  });

  it('shows "Clear filters" as a standalone link with a 44px target only when a filter is on', async () => {
    const first = await render('/products');
    expect(first.root.textContent).not.toContain('Clear filters');
    first.httpMock.verify();

    TestBed.resetTestingModule();
    const { httpMock, root } = await render('/products?category_id=c1');
    const clear = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Clear filters'),
    )!;
    expect(clear.classList.contains('min-h-11')).toBe(true);
    expect(clear.classList.contains('underline')).toBe(true);
    drain(httpMock);
    httpMock.verify();
  });
});

// AECI-1662 — the "Connector type" group. It behaves as a taxonomy group does, and
// `search-page.component.spec.ts` asserts the same behaviour on `/search`.
describe('FacetSidebar — Connector type (AECI-1662)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  const KINDS = facets({
    categories: [term('c1', 'Cat One', 3)],
    connector_kinds: [
      { kind: 'integration_platform', product_count: 4 },
      { kind: 'sync_service', product_count: 2 },
    ],
  });

  async function render(url: string, body: ProductFacetsResponse = KINDS) {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl(url);
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === FACETS_URL);
    req.flush(body);
    await settle();
    fixture.detectChanges();
    return { httpMock, router, req, fixture, root: fixture.nativeElement as HTMLElement };
  }

  function kindRows(root: HTMLElement): string[] {
    const group = [...root.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')?.textContent?.trim() === 'Connector type',
    );
    return [...(group?.querySelectorAll('label') ?? [])].map((l) =>
      (l.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  it('renders the group last, with both kinds in vocabulary order and their counts', async () => {
    const { httpMock, root } = await render('/products');
    expect(legends(root)).toEqual(['Categories', 'Connector type']);
    expect(kindRows(root)).toEqual(['Integration platform(4)', 'Sync Service(2)']);
    httpMock.verify();
  });

  it('hides a kind with no matches unless it is checked', async () => {
    const body = facets({
      connector_kinds: [
        { kind: 'integration_platform', product_count: 0 },
        { kind: 'sync_service', product_count: 0 },
      ],
    });
    const empty = await render('/products', body);
    expect(legends(empty.root)).not.toContain('Connector type');
    empty.httpMock.verify();

    TestBed.resetTestingModule();
    const checked = await render('/products?connector_kind=sync_service', body);
    expect(kindRows(checked.root)).toEqual(['Sync Service(0)']);
    drain(checked.httpMock);
    checked.httpMock.verify();
  });

  it('sends the kind list with the counts request', async () => {
    const { httpMock, req } = await render('/products?connector_kind=sync_service');
    expect(req.request.params.get('connector_kind')).toBe('sync_service');
    httpMock.verify();
  });

  it('toggles kinds into a sorted CSV in ?connector_kind and off again', async () => {
    const { httpMock, router, fixture, root } = await render('/products?page=2');
    const boxes = () => {
      const group = [...root.querySelectorAll('fieldset')].find(
        (f) => f.querySelector('legend')?.textContent?.trim() === 'Connector type',
      )!;
      return [...group.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    };
    boxes()[1]!.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/products?page=1&connector_kind=sync_service');
    fixture.detectChanges();
    for (const pending of httpMock.match((r) => r.url === FACETS_URL)) pending.flush(KINDS);
    await settle();
    fixture.detectChanges();

    boxes()[0]!.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/products?page=1&connector_kind=integration_platform,sync_service');
    fixture.detectChanges();
    for (const pending of httpMock.match((r) => r.url === FACETS_URL)) pending.flush(KINDS);
    await settle();
    fixture.detectChanges();

    boxes()[0]!.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/products?page=1&connector_kind=sync_service');
    fixture.detectChanges();
    for (const pending of httpMock.match((r) => r.url === FACETS_URL)) pending.flush(KINDS);
    await settle();
    fixture.detectChanges();

    boxes()[1]!.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/products?page=1');
    drain(httpMock);
    httpMock.verify();
  });

  it('counts the kind in the active badge, and Clear filters clears it', async () => {
    const { httpMock, router, root } = await render(
      '/products?category_id=c1&connector_kind=integration_platform,sync_service',
    );
    const trigger = root.querySelector('button[aria-controls="aec-facet-panel"]')!;
    expect(trigger.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('3');
    const clear = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Clear filters'),
    )!;
    clear.click();
    await settle();
    expect(router.url).toBe('/products?page=1');
    drain(httpMock);
    httpMock.verify();
  });

  it('shows Clear filters when only the kind is set', async () => {
    const { httpMock, root } = await render('/products?connector_kind=sync_service');
    expect(root.textContent).toContain('Clear filters');
    drain(httpMock);
    httpMock.verify();
  });

  it('shows the group on a browse page too, which never locks it', async () => {
    const { httpMock, router } = createIndexSetup(FacetSidebarHost, 'products');
    await router.navigateByUrl('/products?connector_kind=sync_service');
    const fixture = TestBed.createComponent(FacetSidebarHost);
    fixture.componentInstance.kind.set('category');
    fixture.componentInstance.lockedId.set('cat-locked');
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === FACETS_URL);
    expect(req.request.params.get('category_id')).toBe('cat-locked');
    expect(req.request.params.get('connector_kind')).toBe('sync_service');
    req.flush(KINDS);
    await settle();
    fixture.detectChanges();
    expect(legends(fixture.nativeElement as HTMLElement)).toEqual(['Connector type']);
    httpMock.verify();
  });
});
