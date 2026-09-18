/**
 * AECI-1008 — "Contest a field" on the integration card
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * What these pin, in the order it matters:
 *   1. Visibility is the owner rule and NOTHING else: shown when the caller is
 *      not the owner, hidden when it is, and never gated on `canWrite`
 *      (entitlement) or on the edge being attestable. A seat is the whole gate.
 *   2. The value control follows the field, and every control starts at the
 *      value on record.
 *   3. The shared rule refuses a bad value and an unchanged value before any
 *      request leaves.
 *   4. Success announces through the one live region and revalidates contests.
 *   5. Each API refusal renders its own plain sentence in a `role="alert"`.
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
  VENDOR_CONTESTS_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { NO_OWNER, VendorContestForm } from './vendor-contest-form';
import { VendorIntegrationCard } from './vendor-integration-card';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The fixture with real contestable values and Procore on record as owner. */
const PROCORE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;
/** The fixture the caller owns (`is_owner: true`). */
const OWNED = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.is_owner)!;
/** A connector-powered edge: not attestable, but still contestable. */
const POWERED = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => !i.attestable)!;

let api: {
  getContests: ReturnType<typeof vi.fn>;
  submitContest: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
    submitContest: vi.fn(),
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

async function createForm(
  integration: VendorIntegration = PROCORE,
): Promise<ComponentFixture<VendorContestForm>> {
  const fixture = TestBed.createComponent(VendorContestForm);
  fixture.componentRef.setInput('integration', integration);
  fixture.componentRef.setInput('vendorId', VENDOR_ME_FIXTURE.vendor.id);
  fixture.componentRef.setInput('vendorName', VENDOR_ME_FIXTURE.vendor.company_name);
  await settle(fixture);
  return fixture;
}

async function createCard(
  integration: VendorIntegration,
  canWrite: boolean,
): Promise<ComponentFixture<VendorIntegrationCard>> {
  const fixture = TestBed.createComponent(VendorIntegrationCard);
  fixture.componentRef.setInput('integration', integration);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  fixture.componentRef.setInput('canWrite', canWrite);
  fixture.componentRef.setInput('dataObjects', []);
  fixture.componentRef.setInput('versions', []);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;

function trigger(fixture: ComponentFixture<unknown>): HTMLButtonElement {
  return [...el(fixture).querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Contest a field'),
  )!;
}

async function open(fixture: ComponentFixture<unknown>): Promise<void> {
  trigger(fixture).click();
  await settle(fixture);
}

async function chooseField(fixture: ComponentFixture<unknown>, field: string): Promise<void> {
  const select = el(fixture).querySelector('select[id$="-field"]') as unknown as HTMLSelectElement;
  select.value = field;
  select.dispatchEvent(new Event('change'));
  await settle(fixture);
}

function valueControl(fixture: ComponentFixture<unknown>): HTMLInputElement | HTMLSelectElement {
  return el(fixture).querySelector<HTMLInputElement>('[id$="-value"]')!;
}

async function typeInto(
  fixture: ComponentFixture<unknown>,
  node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  node.value = value;
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input'));
  await settle(fixture);
}

async function reason(fixture: ComponentFixture<unknown>, text: string): Promise<void> {
  await typeInto(fixture, el(fixture).querySelector('textarea[id$="-reason"]')!, text);
}

async function submit(fixture: ComponentFixture<unknown>): Promise<void> {
  el(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('VendorContestForm — who sees it', () => {
  it('shows on a card the caller does not own, even with no write access', async () => {
    // Seat-only (§11b.2): `canWrite` is the Verified gate, and a contest must
    // not be something a vendor buys.
    const fixture = await createCard(PROCORE, false);
    expect(el(fixture).querySelector('aec-vendor-contest-form')).not.toBeNull();
  });

  it('shows on a connector-powered edge that cannot be attested', async () => {
    const fixture = await createCard(POWERED, true);
    expect(el(fixture).querySelector('aec-vendor-contest-form')).not.toBeNull();
  });

  it('is absent on a card the caller owns', async () => {
    const fixture = await createCard(OWNED, true);
    expect(el(fixture).querySelector('aec-vendor-contest-form')).toBeNull();
  });
});

describe('VendorContestForm — the controls', () => {
  it('is a collapsed disclosure until opened', async () => {
    const fixture = await createForm();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('false');
    expect(el(fixture).querySelector('form')).toBeNull();

    await open(fixture);
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
    expect(el(fixture).querySelector('form')).not.toBeNull();
  });

  it('uses a URL input for a URL field, prefilled with the value on record', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'listing_url');

    const control = valueControl(fixture) as HTMLInputElement;
    expect(control.tagName).toBe('INPUT');
    expect(control.type).toBe('url');
    expect(control.value).toBe(PROCORE.contestable_fields.listing_url);
    expect(el(fixture).querySelector('[data-testid="contest-current"]')?.textContent).toContain(
      'marketplace.procore.com',
    );
  });

  it('offers caller-relative direction sentences in a native select', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'direction');

    const control = valueControl(fixture) as HTMLSelectElement;
    expect(control.tagName).toBe('SELECT');
    const labels = [...control.options].map((o) => o.textContent?.trim());
    expect(labels).toEqual(['Sends to Procore', 'Syncs both ways', 'Receives from Procore']);
    expect(control.value).toBe('both');
  });

  it('offers the endpoint vendors plus "Neither endpoint vendor" for the owner', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'owner');

    const control = valueControl(fixture) as HTMLSelectElement;
    const options = [...control.options].map((o) => [o.value, o.textContent?.trim()]);
    expect(options).toEqual([
      [PROCORE.endpoint_vendors[0]!.id, 'Procore Technologies'],
      [PROCORE.endpoint_vendors[1]!.id, 'Summit BIM'],
      [NO_OWNER, 'Neither endpoint vendor'],
    ]);
    expect(el(fixture).querySelector('[data-testid="contest-current"]')?.textContent).toContain(
      'Procore Technologies',
    );
  });

  it('uses a textarea for the description', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'description');
    expect(valueControl(fixture).tagName).toBe('TEXTAREA');
  });

  it('disables a field the caller already has an open contest on', async () => {
    api.getContests.mockResolvedValue(VENDOR_CONTESTS_FIXTURE);
    const fixture = await createForm();
    expect(el(fixture).querySelector('[data-testid="open-contests"]')?.textContent).toContain(
      'Pricing',
    );

    await open(fixture);
    const option = el(fixture).querySelector<HTMLOptionElement>('option[value="pricing_model"]')!;
    expect(option.disabled).toBe(true);
  });
});

describe('VendorContestForm — validation', () => {
  it('refuses a value that is not an http(s) URL, and sends nothing', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'docs_url');
    await typeInto(fixture, valueControl(fixture), 'docs.example.com');
    await reason(fixture, 'The docs moved.');
    await submit(fixture);

    expect(api.submitContest).not.toHaveBeenCalled();
    const alert = el(fixture).querySelector('[id$="-value-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('http://');
    expect(valueControl(fixture).getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses an unchanged value before the server has to', async () => {
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'name');
    await reason(fixture, 'Because.');
    await submit(fixture);

    expect(api.submitContest).not.toHaveBeenCalled();
    expect(el(fixture).textContent).toContain('already the value on record');
  });

  it('requires a reason and a field', async () => {
    const fixture = await createForm();
    await open(fixture);
    await submit(fixture);
    expect(el(fixture).textContent).toContain('Choose the field you want to contest');

    await chooseField(fixture, 'maturity');
    await typeInto(fixture, valueControl(fixture), 'Beta');
    await submit(fixture);
    expect(api.submitContest).not.toHaveBeenCalled();
    expect(el(fixture).textContent).toContain('Say why the value on record is wrong');
  });
});

describe('VendorContestForm — submitting', () => {
  it('sends the wire body, announces, closes and revalidates contests', async () => {
    api.submitContest.mockResolvedValue({
      contest: { ...VENDOR_CONTESTS_FIXTURE.submitted[0]!, routed_to: 'aeci' },
    });
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'direction');
    await typeInto(fixture, valueControl(fixture), 'outbound');
    await reason(fixture, 'Only Summit pushes data.');
    api.getContests.mockClear();
    await submit(fixture);

    expect(api.submitContest).toHaveBeenCalledWith(PROCORE.id, {
      field: 'direction',
      proposed_value: 'outbound',
      reason: 'Only Summit pushes data.',
      context_product_id: PROCORE.context_product.id,
    });
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain(
      'was sent to AEC Integrations',
    );
    expect(el(fixture).querySelector('form')).toBeNull();
    expect(api.getContests).toHaveBeenCalledTimes(1);
  });

  it('sends `null` for "Neither endpoint vendor"', async () => {
    api.submitContest.mockResolvedValue({ contest: VENDOR_CONTESTS_FIXTURE.submitted[0]! });
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'owner');
    await typeInto(fixture, valueControl(fixture), NO_OWNER);
    await reason(fixture, 'A third party offers it.');
    await submit(fixture);

    expect(api.submitContest.mock.calls[0]![1].proposed_value).toBeNull();
  });

  it.each([
    ['CONTEST_DUPLICATE', 409, 'already have an open contest on this field'],
    ['CONTEST_NO_CHANGE', 422, 'nothing to contest'],
    ['CONTEST_INVALID_VALUE', 422, 'not valid for this field'],
    ['CONTEST_OWN_INTEGRATION', 403, 'recorded as the owner'],
    ['INTERNAL_ERROR', 500, 'Could not send your contest'],
  ])('maps %s to plain copy in an alert, and keeps the form open', async (code, status, copy) => {
    api.submitContest.mockRejectedValue(apiError(status, code));
    const fixture = await createForm();
    await open(fixture);
    await chooseField(fixture, 'maturity');
    await typeInto(fixture, valueControl(fixture), 'Beta');
    await reason(fixture, 'It is still in beta.');
    await submit(fixture);

    const alerts = [...el(fixture).querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts.join(' ')).toContain(copy);
    expect(el(fixture).querySelector('form')).not.toBeNull();
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toBe('');
  });
});
