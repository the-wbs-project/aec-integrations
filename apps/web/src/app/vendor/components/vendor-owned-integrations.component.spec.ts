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
 *   4. AECI-1090: a claimed row offers Edit details. The form starts at the values on
 *      record, leaves out the frozen type on a connector-delivered row, sends only
 *      what changed framed against product_a, and returns focus to its trigger.
 *      Without an active plan a claimed connector-delivered row says one is needed.
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
  updateIntegration: ReturnType<typeof vi.fn>;
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
    updateIntegration: vi.fn(),
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

  it('says only the other side is told when the vendor makes one of the products', async () => {
    const fixture = await create();
    // UNCLAIMED joins the vendor's primary product, so only the other vendor is told.
    expect(
      rowEl(fixture, UNCLAIMED.id)!.querySelector('[data-testid="claim-hint"]')!.textContent,
    ).toContain("The other product's vendor is told");
  });

  it('says both sides are told when the vendor makes neither product', async () => {
    const fixture = await create([ELSEWHERE]);
    expect(
      rowEl(fixture, ELSEWHERE.id)!.querySelector('[data-testid="claim-hint"]')!.textContent,
    ).toContain('The vendors of both products are told');
  });

  it('does not claim every row is connector-delivered', async () => {
    const fixture = await create();
    const intro = el(fixture).querySelector('section p')!.textContent!;
    expect(intro).not.toContain('Each one is delivered through a connector');
    expect(intro).toContain('connect products your company does not make');
  });

  it('offers Claim on an unclaimed row with an active plan, and Edit on a claimed one', async () => {
    const fixture = await create();
    expect(
      rowEl(fixture, UNCLAIMED.id)!.querySelector('[data-testid="claim-owned-integration"]'),
    ).not.toBeNull();
    const claimed = rowEl(fixture, CLAIMED.id)!;
    expect(claimed.querySelector('[data-testid="claim-owned-integration"]')).toBeNull();
    expect(claimed.querySelector('[data-testid="edit-owned-integration"]')).not.toBeNull();
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
  it('claims, announces, revalidates and moves focus to the Edit trigger that replaced it', async () => {
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
    expect(row.querySelector('[data-testid="claim-owned-integration"]')).toBeNull();
    // AECI-1090: a claimed row offers Edit, so focus lands on it.
    expect(document.activeElement).toBe(
      row.querySelector('[data-testid="edit-owned-integration"]'),
    );
  });

  it('moves focus to the status line when the claimed row offers no Edit', async () => {
    const fixture = await create();
    api.claimIntegration.mockResolvedValue({});
    // The plan lapsed between the claim and the refetch: no Edit on the row.
    api.getIntegrations.mockImplementation(async () => {
      TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
      return {
        integrations: [],
        owned: [{ ...UNCLAIMED, claimed_at: '2026-09-23T00:00:00.000Z' }, CLAIMED],
      };
    });
    rowEl(fixture, UNCLAIMED.id)!
      .querySelector<HTMLButtonElement>('[data-testid="claim-owned-integration"]')!
      .click();
    await settle(fixture);
    const row = rowEl(fixture, UNCLAIMED.id)!;
    expect(row.querySelector('button')).toBeNull();
    expect(document.activeElement).toBe(row.querySelector('[data-testid="owned-status"]'));
  });

  it.each([
    ['INTEGRATION_ENTITLEMENT_REQUIRED', 403, 'needs an active plan'],
    ['INTEGRATION_ALREADY_CLAIMED', 409, 'already claimed'],
    ['INTEGRATION_CHANGED_WHILE_SAVING', 409, 'changed while you were claiming'],
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

describe('VendorOwnedIntegrations — the edit (AECI-1090)', () => {
  const trigger = (fixture: ComponentFixture<unknown>) =>
    rowEl(fixture, CLAIMED.id)!.querySelector<HTMLButtonElement>(
      '[data-testid="edit-owned-integration"]',
    )!;
  const field = (fixture: ComponentFixture<unknown>, name: string) =>
    rowEl(fixture, CLAIMED.id)!.querySelector<HTMLInputElement>(`[id$="-${name}"]`);

  async function open(): Promise<ComponentFixture<VendorOwnedIntegrations>> {
    const fixture = await create();
    trigger(fixture).click();
    await settle(fixture);
    return fixture;
  }

  it('opens the form at the values on record, without the frozen type', async () => {
    const fixture = await open();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
    expect(field(fixture, 'name')!.value).toBe(CLAIMED.contestable_fields['name']);
    expect(field(fixture, 'maturity')!.value).toBe('GA');
    expect(field(fixture, 'mechanism_kind')).toBeNull();
    expect(
      rowEl(fixture, CLAIMED.id)!.querySelector('[data-testid="edit-frozen-type"]'),
    ).not.toBeNull();
  });

  it('sends only what changed, framed against product_a, then closes and restores focus', async () => {
    api.updateIntegration.mockResolvedValue({});
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await open();
    const input = field(fixture, 'maturity')!;
    input.value = 'Beta';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    rowEl(fixture, CLAIMED.id)!.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.updateIntegration).toHaveBeenCalledWith(CLAIMED.id, {
      maturity: 'Beta',
      context_product_id: CLAIMED.product_a.id,
    });
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('live on the public'));
    expect(rowEl(fixture, CLAIMED.id)!.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(trigger(fixture));
  });

  it('keeps the form open with the refusal in an alert', async () => {
    api.updateIntegration.mockRejectedValue(apiError(403, 'INTEGRATION_ENTITLEMENT_REQUIRED'));
    const fixture = await open();
    const input = field(fixture, 'maturity')!;
    input.value = 'Beta';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    rowEl(fixture, CLAIMED.id)!.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    const alert = rowEl(fixture, CLAIMED.id)!.querySelector('form [role="alert"]');
    expect(alert!.textContent).toContain('needs an active plan');
  });

  it('says a plan is needed, and offers no Edit, without an active entitlement', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create();
    const row = rowEl(fixture, CLAIMED.id)!;
    expect(row.querySelector('[data-testid="edit-owned-integration"]')).toBeNull();
    expect(row.querySelector('[data-testid="edit-needs-plan"]')!.textContent).toContain(
      'needs an active plan',
    );
  });

  it('offers Edit with the type on a claimed owned row that is not connector-delivered', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const ordinary: OwnedIntegration = {
      ...CLAIMED,
      anchor: 'integration',
      mechanism_kind: 'api',
      connector_powered: false,
      contestable_fields: { ...CLAIMED.contestable_fields, mechanism_kind: 'api' },
    };
    const fixture = await create([ordinary]);
    trigger(fixture).click();
    await settle(fixture);
    expect(field(fixture, 'mechanism_kind')).not.toBeNull();
  });
});
