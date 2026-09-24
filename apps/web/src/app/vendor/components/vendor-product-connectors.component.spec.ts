/**
 * `VendorProductConnectors` (AECI-1013). What is pinned:
 *
 *  - nothing renders while loading or when no connector reaches the product;
 *  - delivered and reachable render as separately labelled tiers, and the
 *    reachable one always carries an "as of" label and never the word
 *    "integration" as a claim;
 *  - no links anywhere (a `derived` pair has no vendor page to cite);
 *  - a product switch refetches and never shows the previous product's list;
 *  - a failed read offers a retry.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorProductConnectorsResponse } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_PRODUCT_CONNECTORS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorProductConnectors } from './vendor-product-connectors';

const PRIMARY = '00000000-0000-4000-8000-000000005201';
const SECONDARY = '00000000-0000-4000-8000-000000005202';

let listProductConnectors: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listProductConnectors = vi.fn(
    async (id: string): Promise<VendorProductConnectorsResponse> =>
      structuredClone(VENDOR_PRODUCT_CONNECTORS_FIXTURE[id] ?? { product_id: id, connectors: [] }),
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: VendorApi,
        useValue: {
          listProductConnectors,
          getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
          submitContest: vi.fn(),
        },
      },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});

async function create(productId: string): Promise<ComponentFixture<VendorProductConnectors>> {
  const fixture = TestBed.createComponent(VendorProductConnectors);
  fixture.componentRef.setInput('productId', productId);
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

const el = (f: ComponentFixture<VendorProductConnectors>) => f.nativeElement as HTMLElement;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim();

describe('VendorProductConnectors', () => {
  it('renders nothing when no connector reaches the product', async () => {
    const fixture = await create(SECONDARY);
    expect(listProductConnectors).toHaveBeenCalledWith(SECONDARY);
    expect(el(fixture).querySelector('section')).toBeNull();
    expect(text(el(fixture))).toBe('');
  });

  it('renders one card per connector with the two tiers labelled apart', async () => {
    const fixture = await create(PRIMARY);
    const cards = [...el(fixture).querySelectorAll('[data-connector]')];
    expect(cards.map((c) => text(c.querySelector('h3')))).toEqual(['Kroo Connector', 'Aquifer']);

    const [kroo, aquifer] = cards;
    const delivered = kroo!.querySelector('[data-tier="delivered"]');
    expect(text(delivered)).toContain('Delivered');
    expect(text(delivered)).toContain('Sage Intacct');
    // The owned product is never listed as its own partner.
    expect(text(delivered)).not.toContain('Summit Model Coordination');

    const reach = kroo!.querySelector('details[data-tier="reachable"]');
    expect(reach?.hasAttribute('open')).toBe(false);
    expect(text(reach?.querySelector('summary'))).toBe(
      'Reachable 3 products as of September 10, 2026',
    );
    expect(text(reach)).toContain('Nobody has confirmed a working integration');

    // Reach-only connector: no delivered block, and an undated catalogue says so.
    expect(aquifer!.querySelector('[data-tier="delivered"]')).toBeNull();
    expect(text(aquifer!.querySelector('summary'))).toBe(
      'Reachable 5 products catalogue date not recorded',
    );
  });

  it('offers "Contest a field" on a delivered pair the vendor does not own (AECI-1092)', async () => {
    const fixture = await create(PRIMARY);
    const target = el(fixture).querySelector('[data-contest-target]');
    expect(text(target)).toContain('Sage Intacct, through Kroo Connector. Offered by Kroo.');
    const trigger = target!.querySelector('button');
    expect(text(trigger)).toBe('Contest a field');
  });

  it('offers no contest on a pair the vendor owns, or on a retired one', async () => {
    const owned = structuredClone(VENDOR_PRODUCT_CONNECTORS_FIXTURE[PRIMARY]!);
    owned.connectors[0]!.delivered_contest_targets[0]!.is_owner = true;
    listProductConnectors.mockResolvedValueOnce(owned);
    const fixture = await create(PRIMARY);
    expect(el(fixture).querySelector('[data-contest-target]')).toBeNull();

    const retired = structuredClone(VENDOR_PRODUCT_CONNECTORS_FIXTURE[PRIMARY]!);
    retired.connectors[0]!.delivered_contest_targets[0]!.retired = true;
    listProductConnectors.mockResolvedValueOnce(retired);
    const again = await create(PRIMARY);
    expect(el(again).querySelector('[data-contest-target]')).toBeNull();
  });

  it('links nowhere', async () => {
    const fixture = await create(PRIMARY);
    expect(el(fixture).querySelector('a')).toBeNull();
  });

  it('refetches on a product switch and clears the previous list first', async () => {
    const fixture = await create(PRIMARY);
    expect(el(fixture).querySelectorAll('[data-connector]')).toHaveLength(2);

    fixture.componentRef.setInput('productId', SECONDARY);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(listProductConnectors).toHaveBeenLastCalledWith(SECONDARY);
    expect(el(fixture).querySelectorAll('[data-connector]')).toHaveLength(0);
  });

  it('offers a retry when the read fails', async () => {
    listProductConnectors.mockRejectedValueOnce(new Error('boom'));
    const fixture = await create(PRIMARY);
    const failed = el(fixture).querySelector('[data-connectors-failed]');
    expect(text(failed)).toContain('Could not load the connectors that reach this product.');

    failed!.querySelector('button')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el(fixture).querySelectorAll('[data-connector]')).toHaveLength(2);
  });
});
