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
 *  - the landmark name and the items come from the caller, so the same row draws
 *    the vendor sections and a product's sections (§6.11).
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VENDOR_NAV_ITEMS, VENDOR_PRODUCT_NAV_ITEMS, type VendorNavItem } from './vendor-nav';
import { VendorPortalNav } from './vendor-portal-nav';

const NAV_LABELS = ['Vendor Overview', 'Profile', 'Products', 'Messages', 'Seats'];

/** Set before each mount; the host is created by the router, so there is no
 *  fixture instance to write to. */
let hostItems: readonly VendorNavItem[] = VENDOR_NAV_ITEMS;
let hostLabel = 'Portal sections';

/** Stands in for the portal's layout route: the nav's links are relative, so
 *  they only resolve under a route that owns the section children. */
@Component({
  selector: 'aec-test-nav-host',
  imports: [VendorPortalNav],
  template: `<aec-vendor-portal-nav [items]="items" [ariaLabel]="label" />`,
})
class TestNavHost {
  protected readonly items = hostItems;
  protected readonly label = hostLabel;
}

async function mount(
  url = '/portal/overview',
  items: readonly VendorNavItem[] = VENDOR_NAV_ITEMS,
  label = 'Portal sections',
) {
  hostItems = items;
  hostLabel = label;
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
            {
              path: 'products/:productSlug',
              children: [
                { path: 'profile', children: [] },
                { path: 'taxonomy', children: [] },
                { path: 'integrations', children: [] },
              ],
            },
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
  [...root(harness).querySelectorAll('nav a')] as HTMLElement[];

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
      [
        '/portal/overview',
        '/portal/profile',
        '/portal/products',
        '/portal/messages',
        '/portal/seats',
      ],
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
    const harness = await mount('/portal/profile');
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

  it('makes Products a plain link to the product list', async () => {
    // It was a filterable dropdown; §6.11 gave the catalog its own page, which
    // is also where the Products breadcrumb points.
    const harness = await mount('/portal/products');
    const products = items(harness).find((el) => el.textContent?.trim() === 'Products')!;

    expect(products.tagName).toBe('A');
    expect(products.getAttribute('aria-current')).toBe('page');
  });

  it('draws a product row from the same component, under the name it is given', async () => {
    const productItems = VENDOR_PRODUCT_NAV_ITEMS.map((i) => ({
      ...i,
      path: `products/revit/${i.path}`,
    }));
    const harness = await mount('/portal/products/revit/taxonomy', productItems, 'Revit sections');

    expect(root(harness).querySelector('nav')?.getAttribute('aria-label')).toBe('Revit sections');
    expect(items(harness).map((el) => el.getAttribute('href'))).toEqual([
      '/portal/products/revit/profile',
      '/portal/products/revit/taxonomy',
      '/portal/products/revit/integrations',
    ]);
    const current = items(harness).filter((el) => el.getAttribute('aria-current') === 'page');
    expect(current.map((el) => el.textContent?.trim())).toEqual(['Taxonomy']);
  });

  it('scrolls the row rather than wrapping it, and renders it exactly once', async () => {
    // A wrapped tab row breaks its own underline across two lines; a second
    // `md:hidden` copy would put every item in the DOM (and in a screen
    // reader's link list) twice.
    const harness = await mount();
    const list = root(harness).querySelector('nav ul')!;

    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('overflow-y-hidden');
    expect(list.className).toContain('whitespace-nowrap');
    // AECI-958: `overflow-x-auto` computes `overflow-y` to `auto` on its own,
    // and the items' `-mb-px` overflows the row by exactly 1px — enough to
    // paint a permanent vertical scrollbar under "Show scroll bars: Always".
    // The two utilities are one pairing; this is what stops a later edit
    // separating them.
    expect(list.className).toContain('overflow-y-hidden');
    expect(root(harness).querySelectorAll('nav')).toHaveLength(1);
    expect(items(harness)).toHaveLength(5);
  });
});
