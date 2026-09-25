/**
 * AECI-1129 — the product-not-found notice names what went wrong.
 *
 * A vendor who lands here from a stale bookmark needs to see WHICH link was bad
 * and WHOSE catalog it was checked against. Before this the notice read "That
 * product isn't linked to your vendor.", which echoed neither.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorProductsPage } from './vendor-products-page';

@Component({ selector: 'aec-test-product-child', template: `<p>product child</p>` })
class TestProductChild {}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const SLUG = VENDOR_ME_FIXTURE.vendor.slug;
const COMPANY = VENDOR_ME_FIXTURE.vendor.company_name;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        // Same nesting as `VENDOR_SECTION_ROUTES`, so the notice's relative
        // `../../products` link resolves exactly as it does on the portal.
        {
          path: 'vendor/:vendorSlug',
          children: [
            {
              path: 'products/:productSlug',
              component: VendorProductsPage,
              children: [{ path: '', component: TestProductChild }],
            },
          ],
        },
      ]),
      { provide: VendorApi, useValue: {} },
      VendorPortalStore,
    ],
  });
});

async function open(productSlug: string): Promise<HTMLElement> {
  const harness = await RouterTestingHarness.create();
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
  await harness.navigateByUrl(`/vendor/${SLUG}/products/${productSlug}`);
  harness.detectChanges();
  await flush();
  harness.detectChanges();
  return harness.fixture.nativeElement as HTMLElement;
}

describe('VendorProductsPage — product not found (AECI-1129)', () => {
  it('names the requested slug and the company, gives a cause, and links to the list', async () => {
    const el = await open('no-such-product');
    const text = el.querySelector('aec-vendor-products-page p')?.textContent?.replace(/\s+/g, ' ');

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Product not found');
    expect(text).toContain(
      `The link asks for “no-such-product”, which is not one of ${COMPANY}'s products.`,
    );
    expect(text).toContain('It may have been renamed, removed, or moved to another company.');
    expect(text).not.toContain('linked to your vendor');

    const link = el.querySelector('aec-vendor-products-page p a');
    expect(link?.textContent?.trim()).toBe('See your products');
    expect(link?.getAttribute('href')).toBe(`/vendor/${SLUG}/products`);
  });

  it('renders the product outlet, not the notice, for a product the vendor owns', async () => {
    const owned = VENDOR_ME_FIXTURE.products[0].slug;
    const el = await open(owned);

    expect(el.textContent).toContain('product child');
    expect(el.textContent).not.toContain('Product not found');
  });
});
