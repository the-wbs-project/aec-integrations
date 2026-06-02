/**
 * Shared table-driven harness for the product / vendor / integration
 * index-component specs (AECI-113). Products and vendors are case-for-case
 * identical; integration shares the four "common" cases (default-sort fetch,
 * unknown-sort fallback, error row, empty state) but defaults to `sort=name`
 * and adds its own source/target filter cases, so it opts out of the three
 * sort/nav cases that only make sense for the `created`-default lists.
 *
 *   - `registerIndexPageSuite`  → 4 common + 3 sort/nav cases (products, vendors)
 *   - `registerIndexCommonCases`→ 4 common cases (integrations; filter cases stay
 *                                  in the integration spec)
 *
 * Test helper, not a spec — `*.harness.ts` so no runner collects it directly
 * and the app build excludes it (`tsconfig.app.json`). Entity-specific cases use
 * the exported `createIndexSetup`.
 */
import { provideHttpClient } from '@angular/common/http';
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
}

/** Configures TestBed for an index component on its route; returns the mocks. */
export function createIndexSetup(
  component: Type<unknown>,
  routePath: string,
): { httpMock: HttpTestingController; router: Router } {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
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

    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain(s.h1Text);
    expect(root.querySelector(`a[href="${s.detailHref}"]`)).not.toBeNull();
    httpMock.verify();
  });

  it(`falls back to sort=${s.defaultSort} when the URL carries an unknown sort key`, async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?sort=banana`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('sort') === s.defaultSort).flush(s.fixtureResponse);
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
    fixture.detectChanges();

    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain(s.errorText);
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
    fixture.detectChanges();

    const emptyRow = (fixture.nativeElement as HTMLElement).querySelector('tbody td');
    expect(emptyRow?.textContent).toContain(s.emptyText);
    httpMock.verify();
  });
}

/** The three sort/header-navigation cases shared by the `created`-default lists. */
function registerSortNavCases(s: IndexPageScenario): void {
  it('reads ?sort=name from the URL and reflects it in the column header active state', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?sort=name`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.params.get('sort') === 'name');
    req.flush(s.fixtureResponse);
    fixture.detectChanges();

    // name sorts ascending (A→Z), so aria-sort must be "ascending".
    const th = (fixture.nativeElement as HTMLElement).querySelector('th[aria-sort]');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
    httpMock.verify();
  });

  it('navigates with ?sort=name&page=1 when a sortable header is activated', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}?page=3`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('page') === '3').flush(s.fixtureResponse);
    fixture.detectChanges();

    const nameHeaderButton = (fixture.nativeElement as HTMLElement).querySelector(
      'aec-sortable-column-header button',
    ) as HTMLButtonElement;
    nameHeaderButton.click();
    await fixture.whenStable();

    // Sort change resets to page 1.
    expect(router.url).toBe(`/${s.routePath}?page=1&sort=name`);
    // Allow the resulting second request to drain so the controller verifies clean.
    httpMock.expectOne((r) => r.url === s.apiUrl).flush(s.fixtureResponse);
    httpMock.verify();
  });

  it('shows the error row when a subsequent request fails after an initial success', async () => {
    const { httpMock, router } = createIndexSetup(s.component, s.routePath);
    await router.navigateByUrl(`/${s.routePath}`);
    const fixture = TestBed.createComponent(s.component);
    fixture.detectChanges();

    // First request succeeds — data is now non-null.
    httpMock.expectOne((r) => r.url === s.apiUrl).flush(s.fixtureResponse);
    fixture.detectChanges();

    // Navigate to page 2.
    await router.navigateByUrl(`/${s.routePath}?page=2`);
    fixture.detectChanges();

    // Second request fails.
    httpMock
      .expectOne((r) => r.url === s.apiUrl)
      .flush(
        { error: { code: 'BOOM', message: 'fail' }, trace_id: 'x' },
        { status: 500, statusText: 'Server Error' },
      );
    fixture.detectChanges();

    // The error row must be visible; stale page-1 data must not be shown.
    const errorRow = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    expect(errorRow?.textContent).toContain(s.errorText);
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
