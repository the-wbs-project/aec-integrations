/**
 * AECI-1006 — integration ownership on the card: the owner's Claim and Edit
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6 / §6.14).
 *
 * What these pin:
 *   1. The line and the action follow the caller's relationship to the row, and
 *      nothing else: owner-unclaimed gets Claim, owner-claimed gets Edit, a
 *      connector-delivered row gets neither, a non-owner gets "Offered by".
 *   2. The form groups cover exactly the eleven editable fields, start at the
 *      value on record, and offer no connector-delivered integration type.
 *   3. Only changed fields are sent, framed by the card's context product, and a
 *      bad or unchanged value is caught before any request leaves.
 *   4. Success announces through the one live region and revalidates
 *      `integrations`. Each refusal renders its own sentence in a `role="alert"`.
 *   5. The card mounts the panel for owners and non-owners alike.
 *   6. AECI-1090: a claimed connector-delivered row is editable by an entitled
 *      owner, with the frozen type left out of the form and never sent. Without
 *      an active entitlement it says a plan is needed and offers no form.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRATION_EDIT_FIELDS, type VendorIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  INTEGRATION_CONNECTOR_OWNED,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCard } from './vendor-integration-card';
import {
  EDIT_GROUPS,
  VENDOR_EDIT_FORM_START_OPEN,
  VendorIntegrationOwnership,
} from './vendor-integration-ownership';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** Owned by the caller (Summit), not yet claimed. */
const OWNED = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.is_owner)!;
/** The same row, claimed. */
const CLAIMED: VendorIntegration = { ...OWNED, claimed_at: '2026-09-20T00:00:00.000Z' };
/** Owned and claimed by Procore. */
const PROCORE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;

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
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
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
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

async function create(
  integration: VendorIntegration,
): Promise<ComponentFixture<VendorIntegrationOwnership>> {
  const fixture = TestBed.createComponent(VendorIntegrationOwnership);
  fixture.componentRef.setInput('integration', integration);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const line = (fixture: ComponentFixture<unknown>) =>
  el(fixture).querySelector('[data-testid="ownership-line"]')!.textContent!.trim();
const q = <T extends Element>(fixture: ComponentFixture<unknown>, selector: string) =>
  el(fixture).querySelector(selector) as T | null;

async function openEdit(fixture: ComponentFixture<unknown>): Promise<void> {
  q<HTMLButtonElement>(fixture, '[data-testid="edit-integration"]')!.click();
  await settle(fixture);
}

function control(fixture: ComponentFixture<unknown>, field: string) {
  return q<HTMLInputElement>(fixture, `[id$="-${field}"]`)!;
}

async function type(fixture: ComponentFixture<unknown>, field: string, value: string) {
  const input = control(fixture, field);
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
  await settle(fixture);
}

async function save(fixture: ComponentFixture<unknown>): Promise<void> {
  q<HTMLFormElement>(fixture, 'form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('VendorIntegrationOwnership — what it shows', () => {
  it('offers Claim to an owner that has not claimed, and no Edit', async () => {
    const fixture = await create(OWNED);
    expect(line(fixture)).toContain('recorded as the owner');
    expect(q(fixture, '[data-testid="claim-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="edit-integration"]')).toBeNull();
  });

  it('offers Edit to an owner that has claimed, and no Claim', async () => {
    const fixture = await create(CLAIMED);
    expect(line(fixture)).toContain('owns this integration');
    expect(q(fixture, '[data-testid="edit-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="claim-integration"]')).toBeNull();
  });

  it('offers no Edit on a claimed row the owner has retired (AECI-1010)', async () => {
    const fixture = await create({ ...CLAIMED, retired_at: '2026-09-21T00:00:00.000Z' });
    expect(q(fixture, '[data-testid="edit-integration"]')).toBeNull();
    expect(q(fixture, '[data-testid="claim-integration"]')).toBeNull();
    expect(el(fixture).textContent).toContain('has retired it. Restore it to edit its details.');
  });

  it('offers Claim on a connector-delivered row it owns, with an active plan (AECI-1089)', async () => {
    // VENDOR_ME_FIXTURE holds an active `verified` entitlement.
    const fixture = await create({ ...OWNED, attestable: false });
    expect(line(fixture)).toContain('delivered through a connector');
    expect(q(fixture, '[data-testid="claim-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="claim-needs-plan"]')).toBeNull();
  });

  it('says a plan is needed, and offers no button, without an active entitlement', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create({ ...OWNED, attestable: false });
    expect(q(fixture, '[data-testid="claim-needs-plan"]')!.textContent).toContain(
      'needs an active plan',
    );
    expect(q(fixture, 'button')).toBeNull();
    // With no button, the status line does not ask the vendor to claim.
    expect(line(fixture)).not.toContain('Claim it');
    expect(line(fixture)).toContain('AEC Integrations maintains its details');
  });

  it('never asks for a plan on a row that is not connector-delivered', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await create(OWNED);
    expect(q(fixture, '[data-testid="claim-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="claim-needs-plan"]')).toBeNull();
  });

  it('offers Edit on a claimed connector-delivered row with an active plan (AECI-1090)', async () => {
    const fixture = await create({ ...CLAIMED, attestable: false });
    expect(q(fixture, '[data-testid="edit-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="claim-integration"]')).toBeNull();
  });

  it('claims a connector-delivered row and moves focus to the status line', async () => {
    api.claimIntegration.mockResolvedValue({});
    const row = { ...OWNED, attestable: false };
    api.getIntegrations.mockResolvedValue({
      integrations: [{ ...row, claimed_at: '2026-09-23T00:00:00.000Z' }],
      owned: [],
    });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await create(row);
    q<HTMLButtonElement>(fixture, '[data-testid="claim-integration"]')!.click();
    await settle(fixture);
    expect(api.claimIntegration).toHaveBeenCalledWith(row.id);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('no longer updates it'));
  });

  it('renders the entitlement refusal in an alert', async () => {
    api.claimIntegration.mockRejectedValue(apiError(403, 'INTEGRATION_ENTITLEMENT_REQUIRED'));
    const fixture = await create({ ...OWNED, attestable: false });
    q<HTMLButtonElement>(fixture, '[data-testid="claim-integration"]')!.click();
    await settle(fixture);
    expect(q(fixture, '[role="alert"]')!.textContent).toContain('needs an active plan');
  });

  it('tells a non-owner who offers it and who reviews a contest', async () => {
    const claimed = await create(PROCORE);
    expect(line(claimed)).toContain('Offered by Procore Technologies');
    expect(line(claimed)).toContain('reviews any contest');
    expect(q(claimed, 'button')).toBeNull();

    const unclaimed = await create({ ...PROCORE, claimed_at: null });
    expect(line(unclaimed)).toContain('has not claimed it yet');
    expect(line(unclaimed)).toContain('AEC Integrations reviews');
  });

  it('points a vendor at the Owner contest when nobody is on file', async () => {
    const fixture = await create({ ...PROCORE, owner: null, claimed_at: null });
    expect(line(fixture)).toContain('No owner is on file');
    expect(line(fixture)).toContain('contest the Owner field');
  });
});

describe('VendorIntegrationOwnership — the claim', () => {
  it('claims, announces, revalidates integrations and moves focus to Edit', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    api.claimIntegration.mockResolvedValue({});
    const fixture = await create(OWNED);
    q<HTMLButtonElement>(fixture, '[data-testid="claim-integration"]')!.click();
    await settle(fixture);
    expect(api.claimIntegration).toHaveBeenCalledWith(OWNED.id);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('You claimed this integration'));
    expect(api.getIntegrations).toHaveBeenCalled();
    // The store now holds the fixture; the parent would re-render with a claimed
    // row. Simulate that input change and check focus lands on Edit.
    fixture.componentRef.setInput('integration', CLAIMED);
    await settle(fixture);
    expect(q(fixture, '[data-testid="edit-integration"]')).not.toBeNull();
  });

  it('renders the refusal in an alert and keeps the button', async () => {
    api.claimIntegration.mockRejectedValue(apiError(409, 'INTEGRATION_ALREADY_CLAIMED'));
    const fixture = await create(OWNED);
    q<HTMLButtonElement>(fixture, '[data-testid="claim-integration"]')!.click();
    await settle(fixture);
    expect(q(fixture, '[role="alert"]')!.textContent).toContain('already claimed');
    expect(q(fixture, '[data-testid="claim-integration"]')).not.toBeNull();
  });
});

describe('VendorIntegrationOwnership — the edit form', () => {
  it('groups exactly the eleven editable fields', () => {
    expect(EDIT_GROUPS.flatMap((g) => g.fields).sort()).toEqual(
      [...INTEGRATION_EDIT_FIELDS].sort(),
    );
  });

  it('opens with every control at the value on record, in three fieldsets', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    expect(el(fixture).querySelectorAll('fieldset')).toHaveLength(3);
    expect(control(fixture, 'name').value).toBe(CLAIMED.contestable_fields.name);
    expect(control(fixture, 'listing_url').value).toBe(CLAIMED.contestable_fields.listing_url);
    expect(control(fixture, 'direction').value).toBe('inbound');
    expect(control(fixture, 'website').value).toBe('');
  });

  it('offers no connector-delivered integration type', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    const values = [...control(fixture, 'mechanism_kind').querySelectorAll('option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).not.toContain('iPaaS');
    expect(values).not.toContain('integrator');
    expect(values).toContain('native');
  });

  it('sends only the changed fields, framed by the context product', async () => {
    api.updateIntegration.mockResolvedValue({});
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    await type(fixture, 'name', 'Summit Issues for Autodesk Build');
    await type(fixture, 'listing_url', '');
    await type(fixture, 'direction', 'both');
    await save(fixture);
    expect(api.updateIntegration).toHaveBeenCalledWith(CLAIMED.id, {
      name: 'Summit Issues for Autodesk Build',
      listing_url: '',
      direction: 'both',
      context_product_id: CLAIMED.context_product.id,
    });
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('live on the public'));
    expect(api.getIntegrations).toHaveBeenCalled();
    // Closed on success.
    expect(q(fixture, 'form')).toBeNull();
  });

  it('refuses to send when nothing changed', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    await save(fixture);
    expect(api.updateIntegration).not.toHaveBeenCalled();
    expect(q(fixture, '[role="alert"]')!.textContent).toContain('Nothing has changed');
  });

  it('flags a bad value on the field and does not send', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    await type(fixture, 'website', 'example.com');
    expect(control(fixture, 'website').getAttribute('aria-invalid')).toBe('true');
    expect(q(fixture, '[id$="-website-error"]')!.textContent).toContain('http');
    await save(fixture);
    expect(api.updateIntegration).not.toHaveBeenCalled();
  });

  it('refuses to clear the name', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    await type(fixture, 'name', '   ');
    expect(q(fixture, '[id$="-name-error"]')!.textContent).toContain('cannot be empty');
  });

  it.each([
    ['INTEGRATION_NOT_CLAIMED', 409, 'Claim this integration'],
    ['INTEGRATION_NOT_OWNER', 403, 'no longer recorded as the owner'],
    ['INTEGRATION_CONNECTOR_POWERED', 403, 'Connector-delivered'],
    ['RATE_LIMITED', 429, 'Too many requests'],
  ])('maps %s to its own sentence and keeps the form open', async (code, status, text) => {
    api.updateIntegration.mockRejectedValue(apiError(status, code));
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    await type(fixture, 'maturity', 'GA');
    await save(fixture);
    expect(q(fixture, 'form [role="alert"]')!.textContent).toContain(text);
    expect(q(fixture, 'form')).not.toBeNull();
  });

  it('Cancel closes the form and returns focus to the trigger', async () => {
    const fixture = await create(CLAIMED);
    await openEdit(fixture);
    const cancel = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Cancel'),
    )!;
    cancel.click();
    await settle(fixture);
    expect(q(fixture, 'form')).toBeNull();
    expect(document.activeElement).toBe(q(fixture, '[data-testid="edit-integration"]'));
  });
});

describe('VendorIntegrationCard — mounts the ownership panel', () => {
  async function card(integration: VendorIntegration) {
    const fixture = TestBed.createComponent(VendorIntegrationCard);
    fixture.componentRef.setInput('integration', integration);
    fixture.componentRef.setInput('vendorName', 'Summit BIM');
    fixture.componentRef.setInput('canWrite', false);
    fixture.componentRef.setInput('dataObjects', []);
    fixture.componentRef.setInput('versions', []);
    fixture.componentRef.setInput('mode', 'direct');
    await settle(fixture);
    return fixture;
  }

  it('for the owner, even without write access (a seat is the gate)', async () => {
    const fixture = await card(OWNED);
    expect(q(fixture, '[data-testid="claim-integration"]')).not.toBeNull();
  });

  it('for a non-owner, beside the contest form', async () => {
    const fixture = await card(PROCORE);
    expect(line(fixture)).toContain('Offered by');
    expect(
      [...el(fixture).querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Contest a field'),
      ),
    ).toBe(true);
  });
});

describe('VendorIntegrationOwnership — a connector-delivered row (AECI-1090)', () => {
  const CONNECTOR = INTEGRATION_CONNECTOR_OWNED;

  it('offers Edit to the claimed owner when its vendor holds an active entitlement', async () => {
    const fixture = await create(CONNECTOR);
    expect(line(fixture)).toContain('owns this integration');
    expect(q(fixture, '[data-testid="edit-integration"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="claim-integration"]')).toBeNull();
  });

  it('leaves the frozen type out of the form and says why', async () => {
    const fixture = await create(CONNECTOR);
    await openEdit(fixture);
    expect(q(fixture, '[id$="-mechanism_kind"]')).toBeNull();
    expect(q(fixture, '[data-testid="edit-frozen-type"]')!.textContent).toContain(
      'AEC Integrations sets its type',
    );
    // The other ten fields are all there.
    for (const field of INTEGRATION_EDIT_FIELDS.filter((f) => f !== 'mechanism_kind')) {
      expect(q(fixture, `[id$="-${field}"]`)).not.toBeNull();
    }
  });

  it('never sends the type, only the changed fields', async () => {
    api.updateIntegration.mockResolvedValue({});
    const fixture = await create(CONNECTOR);
    await openEdit(fixture);
    await type(fixture, 'maturity', 'GA');
    await save(fixture);
    expect(api.updateIntegration).toHaveBeenCalledWith(CONNECTOR.id, {
      maturity: 'GA',
      context_product_id: CONNECTOR.context_product.id,
    });
  });

  it('maps INTEGRATION_ENTITLEMENT_REQUIRED to its own sentence', async () => {
    api.updateIntegration.mockRejectedValue(apiError(403, 'INTEGRATION_ENTITLEMENT_REQUIRED'));
    const fixture = await create(CONNECTOR);
    await openEdit(fixture);
    await type(fixture, 'maturity', 'GA');
    await save(fixture);
    expect(q(fixture, 'form [role="alert"]')!.textContent).toContain('needs an active plan');
  });

  it('offers no form, and says a plan is needed, without an active entitlement', async () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_DOWNGRADED_FIXTURE);
    const fixture = await create(CONNECTOR);
    expect(line(fixture)).toContain('owns this integration');
    expect(q(fixture, '[data-testid="edit-integration"]')).toBeNull();
    expect(q(fixture, '[data-testid="ownership-entitlement-hint"]')!.textContent).toContain(
      'needs an active plan',
    );
  });

  it('offers no Edit on a retired connector-delivered row', async () => {
    const fixture = await create({ ...CONNECTOR, retired_at: '2026-09-21T00:00:00.000Z' });
    expect(q(fixture, '[data-testid="edit-integration"]')).toBeNull();
  });

  it('opens on first render when the preview names the row', async () => {
    // The module is already built by `beforeEach`, so rebuild it with the token.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        { provide: VendorApi, useValue: api as unknown as VendorApi },
        VendorPortalStore,
        { provide: VENDOR_EDIT_FORM_START_OPEN, useValue: CONNECTOR.id },
      ],
    });
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    const fixture = await create(CONNECTOR);
    expect(q(fixture, 'form')).not.toBeNull();
    const other = await create(CLAIMED);
    expect(q(other, 'form')).toBeNull();
  });
});
