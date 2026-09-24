/**
 * AECI-1010 — retire and restore on the integration card
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 * What these pin:
 *   1. Who sees what: the owner of a claimed, attestable row sees Retire; the owner
 *      of a retired row sees Restore; the other endpoint vendor sees a retired row
 *      read-only; everyone else sees nothing.
 *   2. Retire takes a second, explicit step inside the page. Opening the step sends
 *      nothing, and "Keep it live" returns focus to the trigger.
 *   3. Success switches state, announces through the one live region, moves focus to
 *      the new state and revalidates the right scopes.
 *   4. A refusal renders its own sentence in a `role="alert"`.
 *   5. On the card, a retired row is read-only: no add-a-data-flow form, no contest.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  INTEGRATION_RETIRED_BY_AECI,
  INTEGRATION_RETIRED_BY_OTHER,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCard } from './vendor-integration-card';
import { VendorIntegrationRetire, retireErrorMessage } from './vendor-integration-retire';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** Owned and claimed: the Retire case. The fixture row is unclaimed (AECI-1006's
 *  preview starts at Claim), so the claim is set here. */
const OWNED: VendorIntegration = {
  ...VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.is_owner)!,
  claimed_at: '2026-09-01T00:00:00.000Z',
};
/** Retired by the other endpoint's owner: the read-only case. */
const RETIRED_BY_OTHER = INTEGRATION_RETIRED_BY_OTHER;
const RETIRED_AT = '2026-09-20T00:00:00.000Z';

let api: {
  retireIntegration: ReturnType<typeof vi.fn>;
  restoreIntegration: ReturnType<typeof vi.fn>;
  getContests: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    retireIntegration: vi.fn(),
    restoreIntegration: vi.fn(),
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
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
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

async function create(
  integration: VendorIntegration,
): Promise<ComponentFixture<VendorIntegrationRetire>> {
  const fixture = TestBed.createComponent(VendorIntegrationRetire);
  fixture.componentRef.setInput('integration', integration);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const button = (fixture: ComponentFixture<unknown>, text: string) =>
  [...el(fixture).querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('who sees the retire section', () => {
  it('offers the owner of a claimed row Retire', async () => {
    const fixture = await create(OWNED);
    expect(button(fixture, 'Retire integration')).toBeTruthy();
  });

  it('shows nothing on an unclaimed owned row', async () => {
    const fixture = await create({ ...OWNED, claimed_at: null });
    expect(el(fixture).querySelector('[data-testid="retire-section"]')).toBeNull();
  });

  it('offers an ENTITLED owner Retire on a claimed connector-powered row (AECI-1091)', async () => {
    // VENDOR_ME_FIXTURE holds an active `verified` entitlement.
    const fixture = await create({ ...OWNED, attestable: false });
    expect(button(fixture, 'Retire integration')).toBeTruthy();
  });

  it('shows nothing on a connector-powered row to an owner with no active plan', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create({ ...OWNED, attestable: false });
    expect(el(fixture).querySelector('[data-testid="retire-section"]')).toBeNull();
  });

  it('shows an unentitled owner its retired connector-powered row with no Restore', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create({
      ...OWNED,
      attestable: false,
      retired_at: '2026-09-20T00:00:00.000Z',
      retired_by: 'owner',
    });
    expect(el(fixture).querySelector('[data-testid="retire-restore-needs-plan"]')).toBeTruthy();
    expect(button(fixture, 'Restore integration')).toBeUndefined();
  });

  it('shows nothing to a non-owner on a live row', async () => {
    const fixture = await create({ ...OWNED, is_owner: false });
    expect(el(fixture).querySelector('[data-testid="retire-section"]')).toBeNull();
  });

  it('shows the other endpoint vendor a retired row read-only, naming the owner', async () => {
    const fixture = await create(RETIRED_BY_OTHER);
    const text = el(fixture).textContent ?? '';
    expect(text).toContain('Procore Technologies retired this integration on September 18, 2026');
    expect(text).toContain('You can read it here, but not change it.');
    expect(el(fixture).querySelectorAll('button')).toHaveLength(0);
  });
});

describe('retire', () => {
  it('asks first, inside the page, and opening the step sends nothing', async () => {
    const fixture = await create(OWNED);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    expect(el(fixture).textContent).toContain('Retire this integration?');
    expect(el(fixture).textContent).toContain(
      'Open contests on it close as withdrawn, and restoring it does not reopen them.',
    );
    expect(api.retireIntegration).not.toHaveBeenCalled();
    // Focus lands on the confirm button, so Enter confirms and Tab reaches Cancel.
    expect(document.activeElement?.textContent?.trim()).toBe('Retire integration');
  });

  it('"Keep it live" closes the step and returns focus to the trigger', async () => {
    const fixture = await create(OWNED);
    document.body.appendChild(el(fixture));
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    button(fixture, 'Keep it live')!.click();
    await settle(fixture);
    expect(el(fixture).textContent).not.toContain('Retire this integration?');
    expect(document.activeElement).toBe(button(fixture, 'Retire integration'));
    expect(api.retireIntegration).not.toHaveBeenCalled();
  });

  it('retires, switches to Restore, announces and revalidates integrations and contests', async () => {
    api.retireIntegration.mockResolvedValue({
      integration: { id: OWNED.id, retired_at: RETIRED_AT, updated_at: RETIRED_AT },
      withdrawn_contest_ids: [],
    });
    const store = TestBed.inject(VendorPortalStore);
    const revalidate = vi.spyOn(store, 'revalidate').mockResolvedValue();
    const fixture = await create(OWNED);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);

    expect(api.retireIntegration).toHaveBeenCalledWith(OWNED.id);
    expect(el(fixture).textContent).toContain('You retired this integration on September 20, 2026');
    expect(button(fixture, 'Restore integration')).toBeTruthy();
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Integration retired.');
    expect(revalidate).toHaveBeenCalledWith(['integrations', 'contests']);
  });

  it('says so when a retire closed open contests', async () => {
    api.retireIntegration.mockResolvedValue({
      integration: { id: OWNED.id, retired_at: RETIRED_AT, updated_at: RETIRED_AT },
      withdrawn_contest_ids: ['00000000-0000-4000-8000-000000009999'],
    });
    vi.spyOn(TestBed.inject(VendorPortalStore), 'revalidate').mockResolvedValue();
    const fixture = await create(OWNED);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain(
      'Its open contests were closed as withdrawn.',
    );
  });

  it('renders a refusal as an alert and stays in the confirm step', async () => {
    api.retireIntegration.mockRejectedValue(apiError(409, 'INTEGRATION_RETIRED'));
    const fixture = await create(OWNED);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    button(fixture, 'Retire integration')!.click();
    await settle(fixture);
    const alert = el(fixture).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This integration is already retired.');
    expect(el(fixture).textContent).toContain('Retire this integration?');
  });

  it('tells a lost race to reload, never that the row is already retired', () => {
    const message = retireErrorMessage(apiError(409, 'INTEGRATION_CHANGED_WHILE_SAVING'));
    expect(message).toContain('changed while you were saving');
    expect(message).not.toContain('already retired');
  });
});

describe('restore', () => {
  it('restores immediately, announces and revalidates integrations', async () => {
    api.restoreIntegration.mockResolvedValue({
      integration: { id: OWNED.id, retired_at: null, updated_at: RETIRED_AT },
      withdrawn_contest_ids: [],
    });
    const revalidate = vi
      .spyOn(TestBed.inject(VendorPortalStore), 'revalidate')
      .mockResolvedValue();
    const fixture = await create({ ...OWNED, retired_at: RETIRED_AT });
    button(fixture, 'Restore integration')!.click();
    await settle(fixture);
    expect(api.restoreIntegration).toHaveBeenCalledWith(OWNED.id);
    expect(button(fixture, 'Retire integration')).toBeTruthy();
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Integration restored.');
    expect(revalidate).toHaveBeenCalledWith(['integrations']);
  });
});

describe('retired by AEC Integrations (AECI-1046)', () => {
  it('shows the owner "Retired by AEC Integrations" and no Restore', async () => {
    const fixture = await create(INTEGRATION_RETIRED_BY_AECI);
    const text = el(fixture).textContent ?? '';
    expect(text).toContain('Retired by AEC Integrations on September 21, 2026');
    expect(text).toContain('Only AEC Integrations can restore it.');
    expect(button(fixture, 'Restore integration')).toBeUndefined();
    expect(el(fixture).querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the other endpoint vendor the same actor, read-only', async () => {
    const fixture = await create({ ...INTEGRATION_RETIRED_BY_AECI, is_owner: false });
    const text = el(fixture).textContent ?? '';
    expect(text).toContain('Retired by AEC Integrations on September 21, 2026');
    expect(text).toContain('You can read it here, but not change it.');
    expect(el(fixture).querySelectorAll('button')).toHaveLength(0);
  });

  it('explains the owner-restore refusal', () => {
    expect(retireErrorMessage(apiError(403, 'INTEGRATION_RETIRED_BY_AECI'))).toContain(
      'only AEC Integrations can restore it',
    );
  });
});

describe('on the card', () => {
  async function card(integration: VendorIntegration) {
    const fixture = TestBed.createComponent(VendorIntegrationCard);
    fixture.componentRef.setInput('integration', integration);
    fixture.componentRef.setInput('vendorName', 'Summit BIM');
    fixture.componentRef.setInput('canWrite', true);
    fixture.componentRef.setInput('dataObjects', []);
    fixture.componentRef.setInput('versions', []);
    fixture.componentRef.setInput('mode', 'direct');
    await settle(fixture);
    return fixture;
  }

  it('marks a retired row and drops every write but Restore', async () => {
    const fixture = await card(RETIRED_BY_OTHER);
    const text = el(fixture).textContent ?? '';
    expect(text).toContain('Retired');
    expect(el(fixture).querySelector('aec-vendor-add-claim-form')).toBeNull();
    expect(el(fixture).querySelector('aec-vendor-contest-form')).toBeNull();
  });

  it('badges an AECi retire "Retired by AEC Integrations" and offers no Restore', async () => {
    const fixture = await card(INTEGRATION_RETIRED_BY_AECI);
    const text = el(fixture).textContent ?? '';
    expect(text).toContain('Retired by AEC Integrations');
    expect(button(fixture, 'Restore integration')).toBeUndefined();
  });

  it('marks waiting flows "Needs your input" on a live row, never on a retired one', async () => {
    // A retired row is left out of the waiting count (AECI-1010), so its lanes
    // must not carry the chip that points at that count.
    const waiting: VendorIntegration = {
      ...OWNED,
      attestable: true,
      claims: OWNED.claims.map((c) => ({ ...c, mine: [] })),
    };
    expect(waiting.claims.length).toBeGreaterThan(0);
    const live = await card(waiting);
    expect(el(live).querySelector('.aec-pill-attention')).not.toBeNull();

    const retired = await card({ ...waiting, retired_at: RETIRED_AT });
    expect(el(retired).querySelector('.aec-pill-attention')).toBeNull();
  });

  it('keeps the contest action on a live row the caller does not own', async () => {
    const fixture = await card({ ...RETIRED_BY_OTHER, retired_at: null });
    expect(el(fixture).querySelector('aec-vendor-contest-form')).not.toBeNull();
  });
});
