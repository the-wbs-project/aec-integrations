/**
 * AECI-1089 — the owner's rows outside the attestable list, with a Claim action
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5 and §6.15).
 *
 * What these pin:
 *   1. Only the rows that touch this product, plus rows that touch none of the
 *      vendor's products, are listed. Nothing renders when there are none.
 *   2. Each row offers exactly what its state allows: Claim, the plan sentence, or a
 *      status line with no action.
 *   3. A claim announces, revalidates `integrations` and moves focus to the row's
 *      status line. A refusal renders its own sentence in a `role="alert"`.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnedIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
  VENDOR_OWNED_INTEGRATIONS_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorOwnedIntegrations, ownedRowsForProduct } from './vendor-owned-integrations';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const PRIMARY = VENDOR_ME_FIXTURE.products[0]!.id;
const UNCLAIMED = VENDOR_OWNED_INTEGRATIONS_FIXTURE[0]!;
const CLAIMED = VENDOR_OWNED_INTEGRATIONS_FIXTURE[1]!;

/** A pair on products the vendor does not list at all: a third party's row. */
const ELSEWHERE: OwnedIntegration = {
  ...UNCLAIMED,
  id: '00000000-0000-4000-8000-0000000059f1',
  name: 'Elsewhere',
  product_a: { id: 'p-x', slug: 'x', name: 'X', logo_url: null },
  product_b: { id: 'p-y', slug: 'y', name: 'Y', logo_url: null },
  connector: { id: 'p-z', slug: 'z', name: 'Z', logo_url: null },
};

let api: {
  claimIntegration: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  getContests: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    claimIntegration: vi.fn(),
    getIntegrations: vi.fn().mockResolvedValue({
      integrations: [],
      owned: [...VENDOR_OWNED_INTEGRATIONS_FIXTURE],
    }),
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(
  owned: readonly OwnedIntegration[] = VENDOR_OWNED_INTEGRATIONS_FIXTURE,
  productId = PRIMARY,
): Promise<ComponentFixture<VendorOwnedIntegrations>> {
  api.getIntegrations.mockResolvedValue({ integrations: [], owned: [...owned] });
  await TestBed.inject(VendorPortalStore).revalidate(['integrations']);
  const fixture = TestBed.createComponent(VendorOwnedIntegrations);
  fixture.componentRef.setInput('contextProductId', productId);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const rowEl = (fixture: ComponentFixture<unknown>, id: string) =>
  el(fixture).querySelector(`[data-owned-row="${id}"]`) as HTMLElement | null;

describe('ownedRowsForProduct', () => {
  const vendorProducts = new Set([PRIMARY]);

  it('keeps rows touching the product as an endpoint or the connector', () => {
    const asConnector = { ...ELSEWHERE, connector: { ...ELSEWHERE.connector!, id: PRIMARY } };
    expect(ownedRowsForProduct([UNCLAIMED, asConnector], PRIMARY, vendorProducts)).toEqual([
      UNCLAIMED,
      asConnector,
    ]);
  });

  it('keeps a row touching none of the vendor’s products on every tab', () => {
    expect(ownedRowsForProduct([ELSEWHERE], 'another-tab', vendorProducts)).toEqual([ELSEWHERE]);
  });

  it('drops a row that belongs on another of the vendor’s tabs', () => {
    expect(ownedRowsForProduct([UNCLAIMED], 'another-tab', vendorProducts)).toEqual([]);
  });
});

describe('VendorOwnedIntegrations — what it shows', () => {
  it('renders nothing when the vendor owns no rows here', async () => {
    const fixture = await create([]);
    expect(el(fixture).querySelector('section')).toBeNull();
  });

  it('lists the rows under one labelled section', async () => {
    const fixture = await create();
    const section = el(fixture).querySelector('section')!;
    expect(section.getAttribute('aria-labelledby')).toBe('vendor-owned-heading');
    expect(el(fixture).querySelector('#vendor-owned-heading')!.textContent).toContain(
      'Integrations your company offers',
    );
    expect(rowEl(fixture, UNCLAIMED.id)).not.toBeNull();
    expect(rowEl(fixture, CLAIMED.id)).not.toBeNull();
  });

  it('names the route, and falls back to the two product names for an untitled row', async () => {
    const fixture = await create();
    expect(rowEl(fixture, UNCLAIMED.id)!.textContent).toContain('through Agave ERP Sync');
    expect(rowEl(fixture, CLAIMED.id)!.querySelector('h3')!.textContent).toContain(
      'Summit Model Coordination and Autodesk Build',
    );
  });

  it('offers Claim on an unclaimed row with an active plan, and nothing on a claimed one', async () => {
    const fixture = await create();
    expect(
      rowEl(fixture, UNCLAIMED.id)!.querySelector('[data-testid="claim-owned-integration"]'),
    ).not.toBeNull();
    const claimed = rowEl(fixture, CLAIMED.id)!;
    expect(claimed.querySelector('button')).toBeNull();
    expect(claimed.textContent).toContain('Your company owns this integration');
  });

  it('says a plan is needed, and offers no button, without an active entitlement', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create();
    const row = rowEl(fixture, UNCLAIMED.id)!;
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('[data-testid="claim-needs-plan"]')!.textContent).toContain(
      'needs an active plan',
    );
  });

  it('offers Claim without a plan on an owned row that is not connector-delivered', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const plain = { ...UNCLAIMED, anchor: 'integration' as const, connector_powered: false };
    const fixture = await create([plain]);
    expect(
      rowEl(fixture, plain.id)!.querySelector('[data-testid="claim-owned-integration"]'),
    ).not.toBeNull();
  });

  it('says who retired a retired row, and offers nothing', async () => {
    const retired = {
      ...CLAIMED,
      retired_at: '2026-09-22T00:00:00.000Z',
      retired_by: 'aeci' as const,
    };
    const fixture = await create([retired]);
    const row = rowEl(fixture, retired.id)!;
    expect(row.textContent).toContain('AEC Integrations retired this integration');
    expect(row.querySelector('button')).toBeNull();
  });
});

describe('VendorOwnedIntegrations — the claim', () => {
  it('claims, announces, revalidates and moves focus to the status line', async () => {
    const fixture = await create();
    api.claimIntegration.mockResolvedValue({});
    api.getIntegrations.mockResolvedValue({
      integrations: [],
      owned: [{ ...UNCLAIMED, claimed_at: '2026-09-23T00:00:00.000Z' }, CLAIMED],
    });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');

    rowEl(fixture, UNCLAIMED.id)!
      .querySelector<HTMLButtonElement>('[data-testid="claim-owned-integration"]')!
      .click();
    await settle(fixture);

    expect(api.claimIntegration).toHaveBeenCalledWith(UNCLAIMED.id);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('You claimed this integration'));
    const row = rowEl(fixture, UNCLAIMED.id)!;
    expect(row.querySelector('button')).toBeNull();
    expect(document.activeElement).toBe(row.querySelector('[data-testid="owned-status"]'));
  });

  it.each([
    ['INTEGRATION_ENTITLEMENT_REQUIRED', 403, 'needs an active plan'],
    ['INTEGRATION_ALREADY_CLAIMED', 409, 'already claimed'],
    ['INTEGRATION_NOT_OWNER', 403, 'Another company'],
    ['RATE_LIMITED', 429, 'Too many requests'],
  ])('renders %s in an alert on that row', async (code, status, text) => {
    const fixture = await create();
    api.claimIntegration.mockRejectedValue(apiError(status, code));
    rowEl(fixture, UNCLAIMED.id)!
      .querySelector<HTMLButtonElement>('[data-testid="claim-owned-integration"]')!
      .click();
    await settle(fixture);
    const alert = rowEl(fixture, UNCLAIMED.id)!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(text);
  });
});
