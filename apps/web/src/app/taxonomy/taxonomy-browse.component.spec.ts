import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductsListResponse } from '@aeci/shared';

import { settle } from '../core/testing/index-page.harness';

import { TaxonomyBrowsePage } from './taxonomy-browse';

/**
 * AECI-657 — the taxonomy browse page had NO component spec, which is part of
 * how it went four issues without noticing it was missing the toolbar
 * `STAGE_1_SPEC.md` §4.5 asks for. These cases pin the toolbar contract: both
 * views render, `?sort=` and `?view=` are URL-owned, and the featured lead stays
 * gated to the truthful case.
 *
 * The page reads its `kind` and `term` from resolved route `data`, so it must be
 * instantiated BY THE ROUTER through a `<router-outlet>` — a directly-created
 * component gets the root `ActivatedRoute`, whose `data` is empty, and the page
 * silently renders its 404 branch. The route carries static `data` rather than
 * running the real resolver, which `taxonomy-browse.resolver.component.spec.ts`
 * covers separately.
 */
@Component({ imports: [RouterOutlet], template: `<router-outlet />` })
class OutletHost {}
const TERM = {
  id: '00000000-0000-4000-8000-000000030001',
  slug: 'project-management',
  name: 'Project Management',
  description: 'Tools that run the job.',
  product_count: 2,
  products: [],
};

const fixtureResponse: ProductsListResponse = {
  data: [
    {
      id: '00000000-0000-4000-8000-000000020001',
      slug: 'procore',
      name: 'Procore',
      logo_url: null,
      product_role: 'application',
      vendor: {
        id: '00000000-0000-4000-8000-000000010001',
        name: 'Procore Technologies',
        slug: 'procore',
        logo_url: null,
        verified: false,
      },
      primary_category: {
        id: '00000000-0000-4000-8000-000000030001',
        name: 'Project Management',
        slug: 'project-management',
      },
      integration_count: 12,
      review_count: 3,
      rating_overall_avg: 4.5,
      rating_onboarding_avg: 4.2,
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-06-15T00:00:00.000Z',
    },
  ],
  page: 1,
  perPage: 24,
  total: 1,
};

const el = (fixture: ComponentFixture<OutletHost>) => fixture.nativeElement as HTMLElement;

/** The toolbar's own view buttons. Scoped, because the facet sidebar renders
 *  buttons of its own ("Filters" disclosure, "Clear filters") into the page. */
const viewButtons = (fixture: ComponentFixture<OutletHost>) =>
  [...el(fixture).querySelectorAll('aec-listing-toolbar button')] as HTMLButtonElement[];

/** Drain the facet sidebar's scoped-count request so `verify()` stays clean. */
function drainFacets(httpMock: HttpTestingController): void {
  for (const req of httpMock.match((r) => r.url === '/api/products/facets')) {
    req.flush({ categories: [], audiences: [], phases: [], trades: [] });
  }
}

describe('TaxonomyBrowsePage — listing toolbar (AECI-657)', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideRouter([
          {
            path: 'categories/:slug',
            component: TaxonomyBrowsePage,
            data: { kind: 'category', term: TERM },
          },
        ]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  /** Navigate, render through the outlet, and flush the products request. */
  async function render(url: string): Promise<ComponentFixture<OutletHost>> {
    const fixture = TestBed.createComponent(OutletHost);
    await router.navigateByUrl(url);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    for (const req of httpMock.match((r) => r.url === '/api/products')) {
      req.flush(fixtureResponse);
    }
    await settle();
    fixture.detectChanges();
    return fixture;
  }

  it('renders the sort control the page previously lacked entirely', async () => {
    const fixture = await render('/categories/project-management');
    const select = el(fixture).querySelector('select');
    expect(select).not.toBeNull();
    expect(select!.value).toBe('created');
    drainFacets(httpMock);
  });

  it('defaults to the card grid, matching /products', async () => {
    const fixture = await render('/categories/project-management');
    expect(el(fixture).querySelector('aec-product-card-grid')).not.toBeNull();
    expect(el(fixture).querySelector('table')).toBeNull();
    drainFacets(httpMock);
  });

  it('renders the table — unchanged — under ?view=table', async () => {
    const fixture = await render('/categories/project-management?view=table');
    expect(el(fixture).querySelector('table')).not.toBeNull();
    expect(el(fixture).querySelector('aec-product-card-grid')).toBeNull();
    // The row component is still ProductCard, so the table view is byte-for-byte
    // the pre-AECI-657 rendering.
    expect(el(fixture).querySelector('tr[aec-product-card]')).not.toBeNull();
    drainFacets(httpMock);
  });

  it('sends ?sort= from the URL to the API, including the keys it used to reject', async () => {
    const fixture = TestBed.createComponent(OutletHost);
    await router.navigateByUrl('/categories/project-management?sort=integrations');
    fixture.detectChanges();
    await settle();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/products' && r.params.get('sort') === 'integrations',
    );
    // The page's own dimension rides baseParams, never the URL.
    expect(req.request.params.get('category_id')).toBe(TERM.id);
    req.flush(fixtureResponse);
    await settle();

    fixture.detectChanges();
    expect(el(fixture).querySelector('select')!.value).toBe('integrations');
    drainFacets(httpMock);
  });

  it('falls back to the default sort on an unknown key', async () => {
    const fixture = TestBed.createComponent(OutletHost);
    await router.navigateByUrl('/categories/project-management?sort=banana');
    fixture.detectChanges();
    await settle();

    httpMock
      .expectOne((r) => r.url === '/api/products' && r.params.get('sort') === 'created')
      .flush(fixtureResponse);
    await settle();
    drainFacets(httpMock);
  });

  it('writes the chosen view to ?view= so it survives a reload and a share', async () => {
    const fixture = await render('/categories/project-management');
    viewButtons(fixture)[1]!.click();
    await settle();
    expect(router.url).toContain('view=table');
    drainFacets(httpMock);
  });

  it('keeps ?view= and the facet filters on the URL together', async () => {
    const fixture = await render(`/categories/project-management?audience_id=${TERM.id}`);
    viewButtons(fixture)[1]!.click();
    await settle();
    expect(router.url).toContain('view=table');
    expect(router.url).toContain('audience_id=');
    drainFacets(httpMock);
  });

  it('suppresses the featured "Recently added" lead when the sort is not newest', async () => {
    const fixture = await render('/categories/project-management?sort=name');
    const grid = el(fixture).querySelector('aec-product-card-grid');
    expect(grid).not.toBeNull();
    // `featuredLead` false ⇒ no warm featured band, so the eyebrow never claims
    // "Recently added" over an alphabetical list.
    expect(el(fixture).textContent).not.toContain('Recently added');
    drainFacets(httpMock);
  });
});
