/**
 * AECI-1091 — retire and restore on a row of "Integrations your company offers"
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6 and §4.6.3).
 *
 * What these pin:
 *   1. The section offers exactly what the server will take: Retire on a claimed live
 *      row when the vendor may (entitled, on a connector-delivered row), Restore on
 *      the owner's own retire, nothing but a sentence on an AECi retire or without a
 *      plan, and nothing at all on an unclaimed row.
 *   2. Retire is a second step inside the page. Opening it sends nothing, and it
 *      names the connector and both products on a pair.
 *   3. A retire announces, revalidates and switches to Restore. A refusal renders its
 *      own sentence in a `role="alert"`.
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

import { VendorOwnedRetire } from './vendor-owned-retire';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The fixture's claimed pair (Kroo Connector). */
const CLAIMED: OwnedIntegration = VENDOR_OWNED_INTEGRATIONS_FIXTURE[1]!;
const RETIRED_AT = '2026-09-23T00:00:00.000Z';

let api: {
  retireIntegration: ReturnType<typeof vi.fn>;
  restoreIntegration: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  getContests: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    retireIntegration: vi.fn(),
    restoreIntegration: vi.fn(),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [], owned: [] }),
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
}

async function create(row: OwnedIntegration): Promise<ComponentFixture<VendorOwnedRetire>> {
  const fixture = TestBed.createComponent(VendorOwnedRetire);
  fixture.componentRef.setInput('row', row);
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const byTestId = (fixture: ComponentFixture<unknown>, id: string) =>
  el(fixture).querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('what the section offers', () => {
  it('offers an entitled owner Retire on a claimed pair', async () => {
    const fixture = await create(CLAIMED);
    expect(byTestId(fixture, 'owned-retire-trigger')).toBeTruthy();
  });

  it('offers nothing on an unclaimed row', async () => {
    const fixture = await create({ ...CLAIMED, claimed_at: null });
    expect(el(fixture).textContent?.trim()).toBe('');
  });

  it('offers nothing on a claimed pair when the vendor has no active plan', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create(CLAIMED);
    expect(byTestId(fixture, 'owned-retire-trigger')).toBeNull();
  });

  it('offers Restore on the owner’s own retire', async () => {
    const fixture = await create({ ...CLAIMED, retired_at: RETIRED_AT, retired_by: 'owner' });
    expect(byTestId(fixture, 'owned-restore')).toBeTruthy();
  });

  it('offers no Restore on an AECi retire, and says who can', async () => {
    const fixture = await create({ ...CLAIMED, retired_at: RETIRED_AT, retired_by: 'aeci' });
    expect(byTestId(fixture, 'owned-restore')).toBeNull();
    expect(byTestId(fixture, 'owned-retired-by-aeci')?.textContent).toContain(
      'Only AEC Integrations can restore it.',
    );
  });

  it('says restoring needs a plan when the vendor has none', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create({ ...CLAIMED, retired_at: RETIRED_AT, retired_by: 'owner' });
    expect(byTestId(fixture, 'owned-restore')).toBeNull();
    expect(byTestId(fixture, 'owned-restore-needs-plan')).toBeTruthy();
  });

  it('offers Retire on a claimed row that is not connector-delivered, plan or not', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create({ ...CLAIMED, anchor: 'integration', connector_powered: false });
    expect(byTestId(fixture, 'owned-retire-trigger')).toBeTruthy();
  });
});

describe('retire', () => {
  it('opens an in-page confirmation that names both products and the connector', async () => {
    const fixture = await create(CLAIMED);
    byTestId(fixture, 'owned-retire-trigger')!.click();
    await settle(fixture);
    const confirm = byTestId(fixture, 'owned-retire-confirm')!;
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.textContent).toContain('Kroo Connector');
    expect(confirm.textContent).toContain(CLAIMED.product_a.name);
    expect(confirm.textContent).toContain(CLAIMED.product_b.name);
    expect(document.activeElement).toBe(byTestId(fixture, 'owned-retire-submit'));
    expect(api.retireIntegration).not.toHaveBeenCalled();
  });

  it('retires, announces, revalidates and switches to Restore', async () => {
    api.retireIntegration.mockResolvedValue({
      integration: {
        id: CLAIMED.id,
        retired_at: RETIRED_AT,
        retired_by: 'owner',
        updated_at: RETIRED_AT,
      },
      withdrawn_contest_ids: [],
    });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const revalidate = vi
      .spyOn(TestBed.inject(VendorPortalStore), 'revalidate')
      .mockResolvedValue();
    const fixture = await create(CLAIMED);
    byTestId(fixture, 'owned-retire-trigger')!.click();
    await settle(fixture);
    byTestId(fixture, 'owned-retire-submit')!.click();
    await settle(fixture);
    expect(api.retireIntegration).toHaveBeenCalledWith(CLAIMED.id);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Integration retired.'));
    expect(revalidate).toHaveBeenCalledWith(['integrations', 'contests']);
    expect(byTestId(fixture, 'owned-restore')).toBeTruthy();
  });

  it('renders a refusal in an alert and stays open', async () => {
    api.retireIntegration.mockRejectedValue(apiError(403, 'INTEGRATION_ENTITLEMENT_REQUIRED'));
    const fixture = await create(CLAIMED);
    byTestId(fixture, 'owned-retire-trigger')!.click();
    await settle(fixture);
    byTestId(fixture, 'owned-retire-submit')!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'needs an active plan',
    );
    expect(byTestId(fixture, 'owned-retire-confirm')).toBeTruthy();
  });

  it('Keep it live closes the confirmation and returns focus to Retire', async () => {
    const fixture = await create(CLAIMED);
    byTestId(fixture, 'owned-retire-trigger')!.click();
    await settle(fixture);
    [...el(fixture).querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Keep it live')!
      .click();
    await settle(fixture);
    expect(byTestId(fixture, 'owned-retire-confirm')).toBeNull();
    expect(document.activeElement).toBe(byTestId(fixture, 'owned-retire-trigger'));
  });
});

describe('restore', () => {
  it('restores and returns to Retire', async () => {
    api.restoreIntegration.mockResolvedValue({
      integration: { id: CLAIMED.id, retired_at: null, retired_by: null, updated_at: RETIRED_AT },
      withdrawn_contest_ids: [],
    });
    vi.spyOn(TestBed.inject(VendorPortalStore), 'revalidate').mockResolvedValue();
    const fixture = await create({ ...CLAIMED, retired_at: RETIRED_AT, retired_by: 'owner' });
    byTestId(fixture, 'owned-restore')!.click();
    await settle(fixture);
    expect(api.restoreIntegration).toHaveBeenCalledWith(CLAIMED.id);
    expect(byTestId(fixture, 'owned-retire-trigger')).toBeTruthy();
    expect(document.activeElement).toBe(byTestId(fixture, 'owned-retire-trigger'));
  });
});
