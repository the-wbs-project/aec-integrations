/**
 * The PRODUCT-level section nav (AECI-666), under one product's heading.
 *
 * The shell spec (`vendor-dashboard-tabbed.component.spec.ts`) drives this row
 * through the whole portal. This file pins the row's own rules with no store and
 * no sections mounted, so a failure here names the nav rather than the surface it
 * sits in:
 *
 *  - the three items, in order, with links relative to the PRODUCT route (the
 *    property that lets one template serve `/vendor/:vendorSlug/products/:slug`
 *    and the preview's mount of the same routes);
 *  - the landmark is named for its product, because there are now two `<nav>`s on
 *    the page and "Portal sections / Portal sections" is a useless landmark list;
 *  - it delegates presentation to the shared segmented route control, keeping
 *    this wrapper responsible only for product-specific items and naming.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { VendorProductNav } from './vendor-product-nav';

const PRODUCT_NAME = 'Summit Field Issues';
const NAV_LABELS = ['Profile', 'Taxonomy', 'Integrations'];

/** Stands in for the product layout route: the row's links are relative, so they
 *  only resolve under a route that owns the product's section children. */
@Component({
  selector: 'aec-test-product-nav-host',
  imports: [VendorProductNav],
  template: `<aec-vendor-product-nav [productName]="name" />`,
})
class TestProductNavHost {
  protected readonly name = PRODUCT_NAME;
}

async function mount(url = '/portal/products/summit-field-issues/profile') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'portal/products/:productSlug',
          component: TestProductNavHost,
          children: [
            { path: 'profile', children: [] },
            { path: 'taxonomy', children: [] },
            { path: 'integrations', children: [] },
          ],
        },
      ]),
    ],
  });
  return RouterTestingHarness.create(url);
}

afterEach(() => TestBed.resetTestingModule());

const root = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;
const links = (harness: RouterTestingHarness) => [...root(harness).querySelectorAll('nav a')];

describe('VendorProductNav', () => {
  it('lists the three product sections in order', async () => {
    const harness = await mount();
    expect(links(harness).map((a) => a.textContent?.trim())).toEqual(NAV_LABELS);
  });

  it('names its landmark for the product, not "Portal sections"', async () => {
    // Two nav landmarks on one page; an unnamed (or identically named) second one
    // makes the landmark list useless. It is built with `$localize` at the call
    // site rather than as an `i18n-aria-label` attribute, because an INTERPOLATED
    // `i18n-*` attribute emits no attribute at all in this toolchain.
    const label = root(await mount())
      .querySelector('nav')
      ?.getAttribute('aria-label');
    expect(label).toContain(PRODUCT_NAME);
    expect(label).not.toBe('Portal sections');
  });

  it('resolves its links relative to the PRODUCT route', async () => {
    // Relative is what lets one template serve the real portal and the preview.
    // An absolute path here would send the preview to the live portal.
    expect(links(await mount()).map((a) => a.getAttribute('href'))).toEqual(
      ['profile', 'taxonomy', 'integrations'].map(
        (p) => `/portal/products/summit-field-issues/${p}`,
      ),
    );
  });

  it('moves aria-current onto the active section', async () => {
    const harness = await mount('/portal/products/summit-field-issues/integrations');
    const byLabel = (text: string) =>
      links(harness).find((a) => a.textContent?.trim() === text) as HTMLElement;

    expect(byLabel('Integrations').getAttribute('aria-current')).toBe('page');
    expect(byLabel('Profile').getAttribute('aria-current')).toBeNull();
  });

  it('delegates to the segmented route nav without the primary tab treatment', async () => {
    const harness = await mount();
    const list = root(harness).querySelector('nav ul')!;

    expect(root(harness).querySelectorAll('aec-segmented-route-nav')).toHaveLength(1);
    expect(root(harness).querySelector('.aec-nav-tab')).toBeNull();
    expect(links(harness).every((link) => !link.classList.contains('border-b-2'))).toBe(true);
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('overflow-y-hidden');
    expect(list.className).toContain('whitespace-nowrap');
  });
});
