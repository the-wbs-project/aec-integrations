/**
 * AECI-1011 — "Add an integration" on the Integrations tab
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7).
 *
 * What these pin:
 *   1. The trigger opens the form; nothing is sent until the vendor submits.
 *   2. The counterpart search calls the public product list and leaves out the
 *      vendor's own product; Enter in the search box searches, it does not submit.
 *   3. A submit with the required fields missing sends nothing and marks the fields.
 *   4. A good submit sends the create body (own product, counterpart, the fields),
 *      announces, revalidates the integrations scope and lists the server's
 *      possible duplicates as a warning, never a block.
 *   5. The type picker leaves out the connector-delivered kinds (decision 9).
 *   6. A refusal renders its own sentence in a `role="alert"`.
 *   7. The preview token opens the form on first render.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE, VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  VENDOR_CREATE_FORM_START_OPEN,
  VendorIntegrationCreate,
  createErrorMessage,
} from './vendor-integration-create';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const OWN = VENDOR_ME_FIXTURE.products[0]!;

const product = (id: string, name: string): ProductListItem => ({
  id,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  logo_url: null,
  product_role: 'application',
  vendor: {
    id: '00000000-0000-4000-8000-000000009999',
    slug: 'v',
    name: 'Vendor Co',
    logo_url: null,
    verified: false,
  },
  primary_category: null,
  integration_count: 0,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
});
const PROCORE = product('00000000-0000-4000-8000-000000005301', 'Procore');

let api: {
  searchProducts: ReturnType<typeof vi.fn>;
  createIntegration: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

function configure(startOpen?: boolean): void {
  TestBed.resetTestingModule();
  api = {
    searchProducts: vi.fn().mockResolvedValue({
      data: [PROCORE, product(OWN.id, OWN.name)],
      total: 2,
      page: 1,
      perPage: 8,
    }),
    createIntegration: vi.fn(),
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
      ...(startOpen === undefined
        ? []
        : [{ provide: VENDOR_CREATE_FORM_START_OPEN, useValue: startOpen }]),
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
}

beforeEach(() => configure());
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

async function mount(): Promise<ComponentFixture<VendorIntegrationCreate>> {
  const fixture = TestBed.createComponent(VendorIntegrationCreate);
  fixture.componentRef.setInput('contextProductId', OWN.id);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const q = <T extends Element>(fixture: ComponentFixture<unknown>, selector: string) =>
  el(fixture).querySelector<T>(selector);

async function type(
  fixture: ComponentFixture<unknown>,
  selector: string,
  value: string,
  event: 'input' | 'change' = 'input',
): Promise<void> {
  const node = el(fixture).querySelector(selector) as HTMLInputElement;
  node.value = value;
  node.dispatchEvent(new Event(event));
  await settle(fixture);
}

async function open(fixture: ComponentFixture<unknown>): Promise<void> {
  q<HTMLButtonElement>(fixture, '[data-testid="add-integration"]')!.click();
  await settle(fixture);
}

async function pickProcore(fixture: ComponentFixture<unknown>): Promise<void> {
  await type(fixture, '#vendor-create-search', 'pro');
  q<HTMLButtonElement>(fixture, '[data-testid="create-search"]')!.click();
  await settle(fixture);
  const radio = q<HTMLInputElement>(fixture, `input[type="radio"][value="${PROCORE.id}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change'));
  await settle(fixture);
}

async function fillRequired(fixture: ComponentFixture<unknown>): Promise<void> {
  await type(fixture, '#vendor-create-name', 'Summit to Procore');
  await type(fixture, '#vendor-create-mechanism_kind', 'native', 'change');
  await type(fixture, '#vendor-create-direction', 'outbound', 'change');
}

const submit = async (fixture: ComponentFixture<unknown>) => {
  q<HTMLFormElement>(fixture, 'form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
};

describe('opening the form', () => {
  it('is closed until the trigger is pressed, and sends nothing on open', async () => {
    const fixture = await mount();
    expect(q(fixture, 'form')).toBeNull();
    const trigger = q<HTMLButtonElement>(fixture, '[data-testid="add-integration"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await open(fixture);
    expect(q(fixture, 'form')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(api.createIntegration).not.toHaveBeenCalled();
  });

  it('opens on first render when the preview token says so', async () => {
    configure(true);
    const fixture = await mount();
    expect(q(fixture, 'form')).not.toBeNull();
  });

  it('preselects the tab’s product as the vendor’s own', async () => {
    const fixture = await mount();
    await open(fixture);
    expect((el(fixture).querySelector('#vendor-create-own') as HTMLInputElement).value).toBe(
      OWN.id,
    );
  });

  it('leaves the connector-delivered kinds out of the type picker', async () => {
    const fixture = await mount();
    await open(fixture);
    const values = [
      ...el(fixture).querySelectorAll<HTMLOptionElement>('#vendor-create-mechanism_kind option'),
    ].map((o) => o.value);
    expect(values).not.toContain('iPaaS');
    expect(values).not.toContain('integrator');
    expect(values).toContain('native');
  });
});

describe('the counterpart search', () => {
  it('searches the public list and leaves the vendor’s own product out', async () => {
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    expect(api.searchProducts).toHaveBeenCalledWith('pro');
    const radios = el(fixture).querySelectorAll(
      '[data-testid="create-results"] input[type="radio"]',
    );
    expect(radios).toHaveLength(1);
  });

  it('asks for two letters before searching', async () => {
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-create-search', 'p');
    q<HTMLButtonElement>(fixture, '[data-testid="create-search"]')!.click();
    await settle(fixture);
    expect(api.searchProducts).not.toHaveBeenCalled();
    expect(el(fixture).textContent).toContain('at least two letters');
  });

  it('searches on Enter without submitting the form', async () => {
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-create-search', 'pro');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    q(fixture, '#vendor-create-search')!.dispatchEvent(enter);
    await settle(fixture);
    expect(api.searchProducts).toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(true);
    expect(api.createIntegration).not.toHaveBeenCalled();
  });

  it('lists what is already on record for the chosen pair, without blocking', async () => {
    await TestBed.inject(VendorPortalStore).reload('integrations');
    const onRecord = VENDOR_INTEGRATIONS_FIXTURE.integrations.filter(
      (i) => i.context_product.id === OWN.id && i.other_product.id === PROCORE.id,
    );
    expect(onRecord.length).toBeGreaterThan(0);
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    expect(q(fixture, '[data-testid="create-on-record"]')?.textContent).toContain(
      `(${new Set(onRecord.map((i) => i.id)).size})`,
    );
    expect(q<HTMLButtonElement>(fixture, '[data-testid="create-submit"]')!.disabled).toBe(false);
  });
});

describe('submitting', () => {
  it('sends nothing and marks the fields when required values are missing', async () => {
    const fixture = await mount();
    await open(fixture);
    await submit(fixture);
    expect(api.createIntegration).not.toHaveBeenCalled();
    expect(el(fixture).textContent).toContain('Search for the other product');
    expect(q(fixture, '#vendor-create-name')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('sends the create body, announces, revalidates and warns about duplicates', async () => {
    api.createIntegration.mockResolvedValue({
      integration: { id: '00000000-0000-4000-8000-000000000777' },
      possible_duplicates: [
        {
          id: '00000000-0000-4000-8000-000000000778',
          name: 'Procore sync',
          mechanism_kind: 'api',
          mechanism_name: null,
          orientation: 'reversed',
          owner: null,
          claimed: false,
          retired: false,
        },
      ],
    });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const revalidate = vi.spyOn(TestBed.inject(VendorPortalStore), 'revalidate');
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    await fillRequired(fixture);
    await type(fixture, '#vendor-create-listing_url', 'https://summit.example/procore');
    await submit(fixture);

    expect(api.createIntegration).toHaveBeenCalledWith({
      product_id: OWN.id,
      counterpart_product_id: PROCORE.id,
      name: 'Summit to Procore',
      mechanism_kind: 'native',
      direction: 'outbound',
      listing_url: 'https://summit.example/procore',
    });
    expect(announce).toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledWith(['integrations']);
    expect(q(fixture, 'form')).toBeNull();
    const dupes = q(fixture, '[data-testid="create-duplicates"]');
    expect(dupes?.textContent).toContain('Procore sync, no owner on file');
  });

  it('renders a refusal in an alert and keeps the form open', async () => {
    api.createIntegration.mockRejectedValue(apiError(404, 'NOT_FOUND'));
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    await fillRequired(fixture);
    await submit(fixture);
    expect(q(fixture, 'form')).not.toBeNull();
    const alert = [...el(fixture).querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alert.join(' ')).toContain('not available to link');
  });
});

describe('createErrorMessage', () => {
  it('maps each refusal to its own sentence', () => {
    const codes = ['NOT_FOUND', 'INTEGRATION_INVALID_VALUE', 'VALIDATION_FAILED', 'RATE_LIMITED'];
    const messages = codes.map((code) => createErrorMessage(apiError(400, code)));
    expect(new Set(messages).size).toBe(codes.length);
    expect(createErrorMessage(new Error('x'))).toContain('Could not add');
  });
});
