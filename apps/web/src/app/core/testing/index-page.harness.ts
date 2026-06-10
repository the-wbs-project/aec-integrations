/**
 * Shared harness for index-component specs (AECI-113). The `/vendors` and
 * `/integrations` index pages were removed (AECI-165), so `/products` is now the
 * sole consumer of the full suite — but the structure is kept generic.
 *
 * AECI-190 redesigned the products index: it defaults to a card grid (not a
 * table), sort moved from clickable column headers to a toolbar `<select>`, and
 * the error / empty / loading states are paragraphs, not table rows. The cases
 * below assert against that structure (DOM-agnostic text checks + the sort
 * dropdown) rather than `tbody`/`th[aria-sort]`.
 *
 *   - `registerIndexPageSuite`  → 4 common + 3 sort/nav cases
 *   - `registerIndexCommonCases`→ 4 common cases (filter cases stay in the spec)
 *
 * Test helper, not a spec — `*.harness.ts` so no runner collects it directly
 * and the app build excludes it (`tsconfig.app.json`). Entity-specific cases use
 * the exported `createIndexSetup`.
 *
 * Async note (AECI-126): the index controller now fetches via `httpResource()`,
 * which dispatches its request from a reactive effect and applies the response
 * on a microtask. `settle()` drains that microtask work between steps. We use a
 * macrotask boundary rather than `fixture.whenStable()` on purpose: a loading
 * resource registers a pending task, so `whenStable()` would block until the
 * mock request is flushed — `settle()` lets navigation, request dispatch, and
 * value application drain without waiting on resource stability.
 */
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

export interface IndexPageScenario {
  /** Describe-block name, e.g. `ProductsIndex`. */
  describeName: string;
  component: Type<unknown>;
  /** Route segment, e.g. `products`. */
  routePath: string;
  /** API endpoint, e.g. `/api/products`. */
  apiUrl: string;
  /** Default sort key applied on init / unknown-key fallback. */
  defaultSort: string;
  /** Expected `<h1>` text fragment. */
  h1Text: string;
  /** Expected first-row detail link href, e.g. `/products/procore`. */
  detailHref: string;
  /** Empty-state copy fragment. */
  emptyText: string;
  /** Error-row copy fragment. */
  errorText: string;
  /** A one-item list response to flush on the happy path (a `*ListResponse`). */
  fixtureResponse: object;
  /**
   * AECI-143 — set when the page renders an `aec-facet-sidebar` that fetches
   * scoped facet counts (`/api/products/facets`). The sidebar fires this once on
   * init and not again on `page`/`sort` navigation, so the harness drains it
   * before each `verify()`. Omit for index pages without a filter sidebar.
   */
  facetsUrl?: string;
}

/** Flush the facet-sidebar's scoped-count request(s), if the page has one, so a
 *  `verify()` doesn't trip on the outstanding `/api/products/facets` request. */
function drainFacets(httpMock: HttpTestingController, s: IndexPageScenario): void {
  if (!s.facetsUrl) return;
  for (const req of httpMock.match((r) => r.url === s.facetsUrl)) {
    req.flush({ categories: [], audiences: [], phases: [] });
  }
}

/**
 * Drain pending microtask work (navigation, `httpResource` request dispatch,
 * resource value application) via a macrotask boundary. See the async note
 * above for why this is not `fixture.whenStable()`.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** Configures TestBed for an index component on its route; returns the mocks. */
export function createIndexSetup(
  component: Type<unknown>,
  routePath: string,
): { httpMock: HttpTestingController; router: Router } {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withXhr()),
      provideHttpClientTesting(),
      provideRouter([{ path: routePath, component }]),
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  return { httpMock, router };
}

/** The four cases shared by all three index components. */
function registerCommonCases(s: IndexPageScenario): void {
  it(`fetches ${s.apiUrl} with default page=1 / perPage=24 / sort=${s.defaultSort} on init`, async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (request) =>
        request.url === s.apiUrl &&
        request.params.get('page') === '1' &&
        request.params.get('perPage') === '24' &&
        request.params.get('sort') === s.defaultSort,
    );
    expect(req.request.method).toBe('GET');
    req.flush(s.fixtureResponse);

    await settle();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain(s.h1Text);
    expect(root.querySelector(`a[href="${s.detailHref}"]`)).not.toBeNull();
    drainFacets(httpMock, s);
    httpMock.verify();
  });

  it(`falls back to sort=${s.defaultSort} when the URL carries an unknown sort key`, async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?sort=banana`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === s.defaultSort).flush(s.fixtureResponse);
    await settle();
    drainFacets(httpMock, s);
    httpMock.verify();
  });

  it('renders the error row when the request fails', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === s.apiUrl)
      .flush(
        { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    await settle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(s.errorText);
    drainFacets(httpMock, s);
    httpMock.verify();
  });

  it('shows the empty state when the API returns zero results', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url === s.apiUrl)
      .flush({ data: [], page: 1, perPage: 24, total: 0 });
    await settle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(s.emptyText);
    drainFacets(httpMock, s);
    httpMock.verify();
  });
}

/** The three sort/nav cases shared by the `created`-default lists. */
function registerSortNavCases(s: IndexPageScenario): void {
  it('reads ?sort=name from the URL and reflects it in the sort dropdown', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?sort=name`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.params.get('sort') === 'name');
    req.flush(s.fixtureResponse);
    await settle();
    fixture.detectChanges();

    // AECI-190: sort state is reflected by the toolbar <select>, not a th[aria-sort].
    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('name');
    drainFacets(httpMock, s);
    httpMock.verify();
  });

  it('navigates with ?sort=name&page=1 when the sort dropdown changes', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?page=3`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '3').flush(s.fixtureResponse);
    await settle();
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select',
    ) as HTMLSelectElement;
    select.value = 'name';
    select.dispatchEvent(new Event('change'));
    await settle();

    // Sort change resets to page 1.
    expect(router.url).toBe(`/${s.routePath}?page=1&sort=name`);
    // The param change re-dispatches the resource on the next change detection;
    // drain the resulting request so the controller verifies clean.
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === s.apiUrl).flush(s.fixtureResponse);
    await settle();
    drainFacets(httpMock, s);
    httpMock.verify();
  });

  it('shows the error row when a subsequent request fails after an initial success', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    // First request succeeds — data is now non-null.
    httpMock.expectOne((r) => r.url === s.apiUrl).flush(s.fixtureResponse);
    await settle();
    fixture.detectChanges();

    // Navigate to page 2.
    await router.navigateByUrl(`/${s.routePath}?page=2`);
    await settle();
    fixture.detectChanges();

    // Second request fails.
    httpMock
      .expectOne((r) => r.url === s.apiUrl)
      .flush(
        { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    await settle();
    fixture.detectChanges();

    // The error must be visible; stale page-1 data must not be shown.
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(s.errorText);
    drainFacets(httpMock, s);
    httpMock.verify();
  });
}

/** Full suite for the `created`-default lists (products, vendors): 7 cases. */
export function registerIndexPageSuite(scenario: IndexPageScenario): void {
  describe(scenario.describeName, () => {
    beforeEach(() => TestBed.resetTestingModule());
    registerCommonCases(scenario);
    registerSortNavCases(scenario);
  });
}

/** Common cases only (integrations): 4 cases. Filter cases stay in the spec. */
export function registerIndexCommonCases(scenario: IndexPageScenario): void {
  describe(scenario.describeName, () => {
    beforeEach(() => TestBed.resetTestingModule());
    registerCommonCases(scenario);
  });
}
