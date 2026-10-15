/**
 * AECI-1377 — "Products you asked us to add" (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.7.6): the vendor's product requests under "Add an integration".
 *
 * What these pin:
 *   1. Nothing renders when there are no requests.
 *   2. The four statuses read "Waiting for AECi", "Added", "Already listed as
 *      {name}" and "Declined: {reason}".
 *   3. Added and Already listed rows link to the context product's Integrations tab
 *      with `?create=open&counterpart={slug}`. Open and declined rows do not.
 *   4. The list re-reads when the store's notification feed moves, once loaded.
 */
import { provideHttpClient } from '@angular/common/http';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_PRODUCT_REQUESTS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorProductRequestsList } from './vendor-product-requests-list';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

let listProductRequests: ReturnType<typeof vi.fn>;
let getNotifications: ReturnType<typeof vi.fn>;

beforeEach(() => {
  TestBed.resetTestingModule();
  listProductRequests = vi.fn().mockResolvedValue({ requests: VENDOR_PRODUCT_REQUESTS_FIXTURE });
  getNotifications = vi.fn().mockResolvedValue({ notifications: [] });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      {
        provide: VendorApi,
        useValue: { listProductRequests, getNotifications } as Partial<VendorApi>,
      },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => vi.restoreAllMocks());

async function create(): Promise<ComponentFixture<VendorProductRequestsList>> {
  const fixture = TestBed.createComponent(VendorProductRequestsList);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const rows = (fixture: ComponentFixture<unknown>) => [
  ...el(fixture).querySelectorAll<HTMLElement>('[data-request-id]'),
];

describe('VendorProductRequestsList', () => {
  it('renders nothing when the vendor has asked for nothing', async () => {
    listProductRequests.mockResolvedValue({ requests: [] });
    const fixture = await create();
    expect(el(fixture).textContent?.trim()).toBe('');
  });

  it('lists every request with its maker and its status', async () => {
    const fixture = await create();
    expect(el(fixture).querySelector('h2')?.textContent?.trim()).toBe(
      'Products you asked us to add',
    );
    const statuses = rows(fixture).map((row) =>
      row.querySelector('[data-testid="request-status"]')?.textContent?.trim(),
    );
    expect(statuses).toEqual([
      'Waiting for AECi',
      'Added',
      'Already listed as Bluebeam Revu',
      'Declined: We list software built for architecture, engineering and construction.',
    ]);
    expect(rows(fixture)[0]!.textContent).toContain('Trimble');
  });

  it('links Added and Already listed rows to the create form with the product chosen', async () => {
    const fixture = await create();
    const links = rows(fixture).map((row) =>
      row.querySelector<HTMLAnchorElement>('[data-testid="request-add-integration"]'),
    );
    expect(links[0]).toBeNull();
    expect(links[3]).toBeNull();
    const added = links[1]!.getAttribute('href') ?? '';
    expect(added).toMatch(/\/products\/summit-model-coordination\/integrations\?/);
    expect(added).toContain('create=open');
    expect(added).toContain('counterpart=autodesk-build');
    expect(links[2]!.getAttribute('href')).toContain('counterpart=bluebeam-revu');
    expect(links[1]!.textContent?.trim()).toBe('Add the integration');
    expect(links[1]!.getAttribute('aria-label')).toBe('Add the integration with Autodesk Build');
  });

  it('re-reads when the notification feed moves, and not before it has loaded', async () => {
    const fixture = await create();
    expect(listProductRequests).toHaveBeenCalledTimes(1);
    await TestBed.inject(VendorPortalStore).revalidate(['notifications']);
    fixture.detectChanges();
    await flush();
    expect(listProductRequests).toHaveBeenCalledTimes(2);
  });

  it('offers a retry when the first read fails', async () => {
    listProductRequests.mockRejectedValue(new Error('down'));
    const fixture = await create();
    expect(el(fixture).querySelector('[data-testid="product-requests-failed"]')).not.toBeNull();
  });
});

@Component({
  selector: 'aec-test-integrations-tab',
  imports: [VendorProductRequestsList],
  template: `<aec-vendor-product-requests-list [routed]="true" />`,
})
class IntegrationsTabHost {}

describe('VendorProductRequestsList on the routed Integrations tab', () => {
  it('links to the portal’s own product tab, not one nested under the current product', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        // The portal's shape: `products/:productSlug` is ONE route of two segments.
        provideRouter([
          {
            path: 'vendor/:vendorSlug',
            children: [
              {
                path: 'products/:productSlug',
                children: [{ path: 'integrations', component: IntegrationsTabHost }],
              },
            ],
          },
        ]),
        {
          provide: VendorApi,
          useValue: { listProductRequests, getNotifications } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    const harness = await RouterTestingHarness.create('/vendor/summit/products/other/integrations');
    await flush();
    harness.detectChanges();
    const link = harness.routeNativeElement!.querySelector<HTMLAnchorElement>(
      '[data-testid="request-add-integration"]',
    );
    expect(link?.getAttribute('href')).toBe(
      '/vendor/summit/products/summit-model-coordination/integrations?create=open&counterpart=autodesk-build',
    );
  });
});
