/**
 * The portal's horizontal section nav.
 *
 * The shell spec (`vendor-dashboard-tabbed.component.spec.ts`) already drives the
 * nav through the whole portal, store and all. This file pins the nav's own
 * rules with no store, no `me`, and no sections mounted, so a failure here names
 * the nav rather than the surface it happens to sit in:
 *
 *  - the five items, in order, with relative links (the property that lets one
 *    template serve `/vendor/:vendorSlug` and `/preview/vendor-dashboard`);
 *  - the active treatment lands on the item element itself, which is what makes
 *    the 2px underline overlap the row's hairline rather than float above it;
 *  - Products is a menu only when there is something to choose BETWEEN.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { VendorProduct } from '@aeci/shared';

import { VENDOR_ME_FIXTURE } from './vendor-fixtures';
import { VendorPortalNav } from './vendor-portal-nav';

const PRODUCTS = VENDOR_ME_FIXTURE.products;
const NAV_LABELS = ['Vendor Overview', 'Profile', 'Products', 'Messages', 'Seats'];

/** Set before each mount; the host is created by the router, so there is no
 *  fixture instance to write to. */
let hostProducts: readonly VendorProduct[] = PRODUCTS;

/** Stands in for the portal's layout route: the nav's links are relative, so
 *  they only resolve under a route that owns the section children. */
@Component({
  selector: 'aec-test-nav-host',
  imports: [VendorPortalNav],
  template: `<aec-vendor-portal-nav [products]="products" />`,
})
class TestNavHost {
  protected readonly products = hostProducts;
}

async function mount(products: readonly VendorProduct[] = PRODUCTS, url = '/portal/overview') {
  hostProducts = products;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'portal',
          component: TestNavHost,
          children: [
            { path: 'overview', children: [] },
            { path: 'profile', children: [] },
            { path: 'products', children: [] },
            { path: 'products/:productSlug', children: [] },
            { path: 'messages', children: [] },
            { path: 'seats', children: [] },
          ],
        },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
  return harness;
}

const root = (harness: RouterTestingHarness) => harness.fixture.nativeElement as HTMLElement;
const items = (harness: RouterTestingHarness) =>
  [...root(harness).querySelectorAll('nav a, nav button')] as HTMLElement[];

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});
beforeEach(() => TestBed.resetTestingModule());

describe('VendorPortalNav', () => {
  it('names the landmark and lists the five sections in order', async () => {
    const harness = await mount();

    expect(root(harness).querySelector('nav')?.getAttribute('aria-label')).toBe('Portal sections');
    expect(items(harness).map((el) => el.textContent?.trim())).toEqual(NAV_LABELS);
  });

  it('resolves its links relative to whichever route mounted it', async () => {
    // The whole reason the paths in `vendor-nav.ts` are relative: an absolute
    // path here would send the dev preview into the live portal.
    const harness = await mount();

    expect([...root(harness).querySelectorAll('nav a')].map((a) => a.getAttribute('href'))).toEqual(
      ['/portal/overview', '/portal/profile', '/portal/messages', '/portal/seats'],
    );
  });

  it('carries the underline on the item itself, so it overlaps the row rule', async () => {
    // Geometry, not decoration: `-mb-px` + `border-b-2` on the item is what
    // turns a differently-coloured link into a tab. On the <li> it would sit a
    // pixel off; anywhere else it would not touch the row's border at all.
    //
    // The COLOUR is `.aec-nav-tab[aria-current]` in `styles.css`, not a Tailwind
    // utility, because the global unlayered `*` border-color rule outranks every
    // border-color utility in the app. So what this asserts is the pair the CSS
    // keys off: the hook class and `aria-current`.
    const harness = await mount(PRODUCTS, '/portal/profile');
    const profile = items(harness).find((el) => el.textContent?.trim() === 'Profile')!;

    expect(profile.className).toContain('-mb-px');
    expect(profile.className).toContain('border-b-2');
    expect(profile.className).toContain('aec-nav-tab');
    expect(profile.className).toContain('text-(--accent-primary)');
    expect(profile.getAttribute('aria-current')).toBe('page');

    const seats = items(harness).find((el) => el.textContent?.trim() === 'Seats')!;
    expect(seats.className).toContain('aec-nav-tab');
    expect(seats.getAttribute('aria-current')).toBeNull();
  });

  it('makes Products a menu when there is something to choose between', async () => {
    const harness = await mount();

    expect(root(harness).querySelector('aec-vendor-products-menu')).not.toBeNull();
    const products = items(harness).find((el) => el.textContent?.trim() === 'Products')!;
    expect(products.tagName).toBe('BUTTON');
    expect(products.getAttribute('aria-expanded')).toBe('false');
  });

  it('gives a single-product vendor a plain link instead', async () => {
    // A dropdown over one option is noise, and the link keeps the section
    // reachable in the degenerate case. Same rule the in-page picker carried.
    const harness = await mount([PRODUCTS[0]]);

    expect(root(harness).querySelector('aec-vendor-products-menu')).toBeNull();
    const products = items(harness).find((el) => el.textContent?.trim() === 'Products')!;
    expect(products.tagName).toBe('A');
    expect(products.getAttribute('href')).toBe('/portal/products');
  });

  it('gives a vendor with no products a plain link too', async () => {
    const harness = await mount([]);

    expect(root(harness).querySelector('aec-vendor-products-menu')).toBeNull();
    expect(items(harness).find((el) => el.textContent?.trim() === 'Products')?.tagName).toBe('A');
  });

  it('scrolls the row rather than wrapping it, and renders it exactly once', async () => {
    // A wrapped tab row breaks its own underline across two lines; a second
    // `md:hidden` copy would put every item in the DOM (and in a screen
    // reader's link list) twice.
    const harness = await mount();
    const list = root(harness).querySelector('nav ul')!;

    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('whitespace-nowrap');
    expect(root(harness).querySelectorAll('nav')).toHaveLength(1);
    expect(items(harness)).toHaveLength(5);
  });
});
