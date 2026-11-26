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
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VENDOR_NAV_ITEMS, productNavItemsFor, type VendorNavItem } from './vendor-nav';
import { VendorPortalNav } from './vendor-portal-nav';

const NAV_LABELS = [
  'Vendor Overview',
  'Profile',
  'Products',
  'Messages',
  // AECI-1551: every private row thread the company is on.
  'Conversations',
  'Changes',
  'Seats',
  'Billing',
  // AECI-1417: owner seats only, like Billing.
  'Proposed products',
];

/** Set before each mount; the host is created by the router, so there is no
 *  fixture instance to write to. */
let hostItems: readonly VendorNavItem[] = VENDOR_NAV_ITEMS;
let hostLabel = 'Portal sections';

/** Stands in for the portal's layout route: the nav's links are relative, so
 *  they only resolve under a route that owns the section children. */
@Component({
  selector: 'aec-test-nav-host',
  imports: [VendorPortalNav],
  template: `<aec-vendor-portal-nav [items]="items()" [ariaLabel]="label" />`,
})
class TestNavHost {
  /** A signal, so a spec can swap the row in place, as the shell does. */
  readonly items = signal<readonly VendorNavItem[]>(hostItems);
  protected readonly label = hostLabel;
}

/** A tab's visible label. The link also holds an aria-hidden weight-600 copy. */
const tabLabel = (el: Element) => el.querySelector('[data-tab-label]')?.textContent?.trim();

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
                { path: 'categories', children: [] },
                { path: 'trades', children: [] },
                { path: 'audiences', children: [] },
                { path: 'phases', children: [] },
                { path: 'integrations', children: [] },
              ],
            },
            { path: 'messages', children: [] },
            { path: 'threads', children: [] },
            { path: 'history', children: [] },
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
    expect(items(harness).map((el) => tabLabel(el))).toEqual(NAV_LABELS);
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
        '/portal/threads',
        '/portal/history',
        '/portal/seats',
        '/portal/billing',
        '/portal/proposals',
      ],
    );
  });

  it('marks the current tab Forest at 600 with an underline keyed off aria-current', async () => {
    // AECI-1809 (mock-up 13): the underline is the link's own ::after bar, shown by the
    // `aria-[current=page]` variant, so nothing here relies on a border colour. The type
    // comes from routerLinkActive.
    const harness = await mount('/portal/profile');
    const profile = items(harness).find((el) => tabLabel(el) === 'Profile')!;

    expect(profile.className).toContain('aria-[current=page]:after:opacity-100');
    expect(profile.className).toContain('after:bg-(--accent-primary)');
    expect(profile.className).toContain('text-(--accent-primary)');
    expect(profile.className).toContain('font-semibold');
    expect(profile.className).toContain('text-t-16');
    expect(profile.getAttribute('aria-current')).toBe('page');

    const seats = items(harness).find((el) => tabLabel(el) === 'Seats')!;
    expect(seats.className).not.toContain('font-semibold');
    expect(seats.getAttribute('aria-current')).toBeNull();
  });

  it('reserves each label’s weight-600 width, hidden from assistive tech', async () => {
    // The hidden bold copy is what keeps the row from shifting when a tab turns current.
    const harness = await mount('/portal/profile');
    const seats = items(harness).find((el) => tabLabel(el) === 'Seats')!;
    const copy = seats.querySelector('[aria-hidden="true"]');

    expect(copy?.textContent?.trim()).toBe('Seats');
    expect(copy?.className).toContain('font-semibold');
    expect(copy?.className).toContain('invisible');
  });

  it('makes Products a plain link to the product list', async () => {
    // It was a filterable dropdown; §6.11 gave the catalog its own page, which
    // is also where the Products breadcrumb points.
    const harness = await mount('/portal/products');
    const products = items(harness).find((el) => tabLabel(el) === 'Products')!;

    expect(products.tagName).toBe('A');
    expect(products.getAttribute('aria-current')).toBe('page');
  });

  it('draws a product row from the same component, under the name it is given', async () => {
    // The row the shell draws for an application product: no Catalogue tab (AECI-1083).
    const productItems = productNavItemsFor('application').map((i) => ({
      ...i,
      path: `products/revit/${i.path}`,
    }));
    const harness = await mount('/portal/products/revit/audiences', productItems, 'Revit sections');

    expect(root(harness).querySelector('nav')?.getAttribute('aria-label')).toBe('Revit sections');
    expect(items(harness).map((el) => el.getAttribute('href'))).toEqual([
      '/portal/products/revit/overview',
      '/portal/products/revit/profile',
      '/portal/products/revit/categories',
      '/portal/products/revit/trades',
      '/portal/products/revit/audiences',
      '/portal/products/revit/phases',
      '/portal/products/revit/integrations',
      '/portal/products/revit/reviews',
    ]);
    const current = items(harness).filter((el) => el.getAttribute('aria-current') === 'page');
    expect(current.map((el) => tabLabel(el))).toEqual(['Audiences']);
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
    // which painted a permanent vertical scrollbar under "Show scroll bars:
    // Always". The two utilities are one pairing; this is what stops a later
    // edit separating them. The scrollbar itself is hidden (AECI-1809).
    expect(list.className).toContain('overflow-y-hidden');
    expect(root(harness).querySelectorAll('nav')).toHaveLength(1);
    expect(items(harness)).toHaveLength(NAV_LABELS.length);
  });

  it('fades an edge only while more tabs lie past it (AECI-1809)', async () => {
    // jsdom has no layout, so the row's scroll geometry is stood in for.
    const harness = await mount();
    const list = root(harness).querySelector('nav ul') as HTMLElement;
    const geometry = (scrollWidth: number, clientWidth: number, scrollLeft: number) => {
      Object.defineProperty(list, 'scrollWidth', { configurable: true, value: scrollWidth });
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: clientWidth });
      list.scrollLeft = scrollLeft;
      list.dispatchEvent(new Event('scroll'));
      harness.detectChanges();
    };

    geometry(300, 300, 0);
    expect(list.classList.contains('aec-fade-start')).toBe(false);
    expect(list.classList.contains('aec-fade-end')).toBe(false);

    geometry(900, 300, 0);
    expect(list.classList.contains('aec-fade-start')).toBe(false);
    expect(list.classList.contains('aec-fade-end')).toBe(true);

    geometry(900, 300, 200);
    expect(list.classList.contains('aec-fade-start')).toBe(true);
    expect(list.classList.contains('aec-fade-end')).toBe(true);

    geometry(900, 300, 600);
    expect(list.classList.contains('aec-fade-start')).toBe(true);
    expect(list.classList.contains('aec-fade-end')).toBe(false);
  });

  it('re-measures the fades when the row swaps its tabs at the same width (AECI-1809)', async () => {
    // The shell swaps the vendor row for a product row in the same component. The row
    // keeps its width, so neither scroll nor a resize fires: the fades must follow the
    // items. jsdom has no layout, so the row's scroll width follows its tab count.
    const harness = await mount();
    const list = root(harness).querySelector('nav ul') as HTMLElement;
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(list, 'scrollWidth', {
      configurable: true,
      get: () => list.querySelectorAll('li').length * 100,
    });
    list.dispatchEvent(new Event('scroll'));
    harness.detectChanges();
    expect(list.classList.contains('aec-fade-end')).toBe(true);

    // Swap to a three-tab row: it fits, so the end fade must go.
    const host = harness.fixture.debugElement.query(By.directive(TestNavHost))
      .componentInstance as TestNavHost;
    host.items.set(VENDOR_NAV_ITEMS.slice(0, 3));
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.classList.contains('aec-fade-end')).toBe(false);
  });

  it('hides the scrollbar and keeps the focus ring inside each tab (AECI-1809)', async () => {
    const harness = await mount();
    const list = root(harness).querySelector('nav ul')!;

    expect(list.classList.contains('aec-portal-tabs')).toBe(true);
    expect(items(harness)[0]!.className).toContain('focus-visible:-outline-offset-2');
  });
});
