/**
 * AECI-1011 — "Add an integration" on the Integrations tab
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7).
 *
 * What these pin:
 *   1. The trigger opens the form; nothing is sent until the vendor submits.
 *   2. The counterpart search is the shared type-ahead combobox (AECI-1244): it
 *      calls the public product list as the vendor types, leaves out the vendor's
 *      own product, and Enter in it never submits the form.
 *   3. A submit with the required fields missing sends nothing and marks the fields.
 *   4. A good submit sends the create body (own product, counterpart, the fields),
 *      announces, revalidates the integrations scope and lists the server's
 *      possible duplicates as a warning, never a block.
 *   5. The type picker leaves out the connector-delivered kinds (decision 9).
 *   6. A refusal renders its own sentence in a `role="alert"`.
 *   7. The preview token opens the form on first render.
 *
 * AECI-1377 (§4.7.6) adds:
 *   8. Two steps. Step 1 is the locked product and the search only. Choosing a
 *      product is step 2. Change goes back to step 1 and keeps typed values.
 *   9. "Can't find it? Ask us to add it" swaps in the request form, prefilled from
 *      the search, with Back to search, the receipt, and the 409 sentence.
 *  10. The `?create=open&counterpart={slug}` deep link: a hit lands on step 2, a
 *      404 or the tab's own product stays on step 1, and the params are removed.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE, VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { PRODUCT_COMBOBOX_DEBOUNCE_MS } from '../../shared/product-combobox/product-combobox';

import {
  VENDOR_CREATE_FORM_START_OPEN,
  VendorIntegrationCreate,
  createErrorMessage,
  productRequestErrorMessage,
} from './vendor-integration-create';
import { expectVendorDocsLink } from './vendor-docs-link.testing';

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
  },
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
  getProduct: ReturnType<typeof vi.fn>;
  createProductRequest: ReturnType<typeof vi.fn>;
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
    getProduct: vi.fn(),
    createProductRequest: vi.fn(),
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
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

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

/** Type into the counterpart combobox and wait out its debounce (AECI-1244). */
async function searchFor(fixture: ComponentFixture<unknown>, value: string): Promise<void> {
  const input = q<HTMLInputElement>(fixture, '#vendor-create-search')!;
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await settle(fixture);
  await new Promise((resolve) => setTimeout(resolve, PRODUCT_COMBOBOX_DEBOUNCE_MS + 30));
  await settle(fixture);
}

/** The popup renders into the body-level CDK overlay under jsdom. */
const options = () => [...document.querySelectorAll<HTMLElement>('[data-product-option]')];

async function pickProcore(fixture: ComponentFixture<unknown>): Promise<void> {
  await searchFor(fixture, 'pro');
  const row = options().find((o) => o.textContent?.includes('Procore'))!;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

const panel = (fixture: ComponentFixture<unknown>) => q(fixture, '[data-testid="create-panel"]');
const stepText = (fixture: ComponentFixture<unknown>) =>
  (q(fixture, '[data-testid="create-step"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('opening the form', () => {
  it('is closed until the trigger is pressed, and sends nothing on open', async () => {
    const fixture = await mount();
    expect(panel(fixture)).toBeNull();
    const trigger = q<HTMLButtonElement>(fixture, '[data-testid="add-integration"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await open(fixture);
    expect(panel(fixture)).not.toBeNull();
    expect(panel(fixture)!.id).toBe(trigger.getAttribute('aria-controls'));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(api.createIntegration).not.toHaveBeenCalled();
  });

  it('opens on first render when the preview token says so', async () => {
    configure(true);
    const fixture = await mount();
    expect(panel(fixture)).not.toBeNull();
  });

  it('shows the tab’s product as fixed, with no picker to change it', async () => {
    const fixture = await mount();
    await open(fixture);
    expect(q(fixture, '#vendor-create-own')).toBeNull();
    const own = q(fixture, '[data-testid="create-own-product"]')!;
    expect(own.textContent).toContain(OWN.name);
  });

  it('stays locked, never a picker, when the tab names a product the list lacks', async () => {
    const fixture = TestBed.createComponent(VendorIntegrationCreate);
    fixture.componentRef.setInput('contextProductId', 'not-in-the-list');
    await settle(fixture);
    await open(fixture);
    expect(q(fixture, '#vendor-create-own')).toBeNull();
    const own = q(fixture, '[data-testid="create-own-product"]')!;
    expect(own.textContent).toContain('Loading your product');
    expect(own.textContent).not.toContain(OWN.name);
  });

  it('offers the picker only where the page names no product', async () => {
    const fixture = TestBed.createComponent(VendorIntegrationCreate);
    await settle(fixture);
    await open(fixture);
    expect(q(fixture, '[data-testid="create-own-product"]')).toBeNull();
    expect((q(fixture, '#vendor-create-own') as HTMLInputElement).value).toBe(OWN.id);
  });

  it('leaves the connector-delivered kinds out of the type picker', async () => {
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    const values = [
      ...el(fixture).querySelectorAll<HTMLOptionElement>('#vendor-create-mechanism_kind option'),
    ].map((o) => o.value);
    expect(values).not.toContain('iPaaS');
    expect(values).not.toContain('integrator');
    expect(values).toContain('native');
  });
});

describe('the counterpart search', () => {
  it('searches the public list as the vendor types and leaves the vendor’s own product out', async () => {
    const fixture = await mount();
    await open(fixture);
    expect(q(fixture, '[data-testid="create-search"]')).toBeNull();
    await searchFor(fixture, 'pro');
    expect(api.searchProducts).toHaveBeenCalledWith('pro');
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain('Procore');
    expect(options()[0]!.textContent).toContain('Vendor Co');
  });

  it('waits for two letters before searching', async () => {
    const fixture = await mount();
    await open(fixture);
    await searchFor(fixture, 'p');
    expect(api.searchProducts).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('at least two letters');
  });

  it('never submits the form on Enter in the search box', async () => {
    const fixture = await mount();
    await open(fixture);
    await searchFor(fixture, 'pro');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    q(fixture, '#vendor-create-search')!.dispatchEvent(enter);
    await settle(fixture);
    expect(enter.defaultPrevented).toBe(true);
    expect(api.createIntegration).not.toHaveBeenCalled();
  });

  it('shows the chosen product with a Change button that brings the search back', async () => {
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    const chosen = q(fixture, '[data-testid="create-counterpart"]');
    expect(chosen?.textContent).toContain('Procore');
    expect(q(fixture, '#vendor-create-search')).toBeNull();
    q<HTMLButtonElement>(fixture, '[data-testid="create-change-counterpart"]')!.click();
    await settle(fixture);
    expect(q(fixture, '[data-testid="create-counterpart"]')).toBeNull();
    expect(q(fixture, '#vendor-create-search')).not.toBeNull();
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
    await pickProcore(fixture);
    await submit(fixture);
    expect(api.createIntegration).not.toHaveBeenCalled();
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
    expect(panel(fixture)).toBeNull();
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
    expect(q(fixture, '[data-testid="create-form"]')).not.toBeNull();
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

describe('VendorIntegrationCreate: the guide link (AECI-1253)', () => {
  it('links Owning an integration beside the trigger', async () => {
    expectVendorDocsLink(el(await mount()), 'owning-an-integration');
  });
});

describe('the two steps (AECI-1377)', () => {
  it('opens on step 1 with only the locked product and the search', async () => {
    const fixture = await mount();
    await open(fixture);
    expect(stepText(fixture)).toBe('Step 1 of 2, Find the other product');
    expect(q(fixture, '[data-testid="create-own-product"]')).not.toBeNull();
    expect(q(fixture, '#vendor-create-search')).not.toBeNull();
    expect(q(fixture, '[data-testid="create-ask-us"]')?.textContent).toContain(
      "Can't find it? Ask us to add it",
    );
    expect(q(fixture, '#vendor-create-name')).toBeNull();
    expect(q(fixture, '[data-testid="create-submit"]')).toBeNull();
  });

  it('moves to step 2 on a pick, and puts focus on the step heading', async () => {
    const fixture = await mount();
    document.body.appendChild(el(fixture));
    await open(fixture);
    await pickProcore(fixture);
    expect(stepText(fixture)).toBe('Step 2 of 2, About the integration');
    expect(q(fixture, '[data-testid="create-counterpart"]')?.textContent).toContain('Procore');
    expect(q(fixture, '#vendor-create-name')).not.toBeNull();
    expect(document.activeElement).toBe(q(fixture, '[data-testid="create-step"]'));
    el(fixture).remove();
  });

  it('keeps the typed values when Change goes back to step 1', async () => {
    const fixture = await mount();
    await open(fixture);
    await pickProcore(fixture);
    await type(fixture, '#vendor-create-name', 'Summit to Procore');
    q<HTMLButtonElement>(fixture, '[data-testid="create-change-counterpart"]')!.click();
    await settle(fixture);
    expect(stepText(fixture)).toContain('Step 1 of 2');
    expect(q(fixture, '#vendor-create-name')).toBeNull();
    await pickProcore(fixture);
    expect(q<HTMLInputElement>(fixture, '#vendor-create-name')!.value).toBe('Summit to Procore');
  });

  it('says no product matches when a finished search finds none', async () => {
    api.searchProducts.mockResolvedValue({ data: [product(OWN.id, OWN.name)], total: 1 });
    const fixture = await mount();
    await open(fixture);
    expect(q(fixture, '[data-testid="create-no-match"]')).toBeNull();
    await searchFor(fixture, 'Trimble');
    expect(q(fixture, '[data-testid="create-no-match"]')?.textContent?.trim()).toBe(
      'No product matches Trimble.',
    );
    // The ask-us button is there whether or not the search missed.
    expect(q(fixture, '[data-testid="create-ask-us"]')).not.toBeNull();
    expect(q(fixture, '#vendor-create-search')!.getAttribute('aria-describedby')).toContain(
      'vendor-create-no-match',
    );
  });
});

describe('asking us to add a product (AECI-1377)', () => {
  async function openRequest(
    fixture: ComponentFixture<VendorIntegrationCreate>,
    query = 'Trimble Connect',
  ): Promise<void> {
    await open(fixture);
    await searchFor(fixture, query);
    q<HTMLButtonElement>(fixture, '[data-testid="create-ask-us"]')!.click();
    await settle(fixture);
  }

  it('swaps step 1 for the request form, with the search text as the name', async () => {
    const fixture = await mount();
    await openRequest(fixture);
    expect(q(fixture, '[data-testid="product-request-form"]')).not.toBeNull();
    expect(q(fixture, '#vendor-create-search')).toBeNull();
    expect(q<HTMLInputElement>(fixture, '#vendor-request-name')!.value).toBe('Trimble Connect');
    expect(q<HTMLInputElement>(fixture, '#vendor-request-maker')!.value).toBe('');
    const labels = [...el(fixture).querySelectorAll('label')].map((l) =>
      (l.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(labels).toEqual([
      'Product name',
      'Company that makes it',
      'Website (optional)',
      'Anything we should know? (optional)',
    ]);
  });

  it('goes back to step 1 from Back to search', async () => {
    const fixture = await mount();
    await openRequest(fixture);
    q<HTMLButtonElement>(fixture, '[data-testid="product-request-back"]')!.click();
    await settle(fixture);
    expect(q(fixture, '[data-testid="product-request-form"]')).toBeNull();
    expect(q(fixture, '#vendor-create-search')).not.toBeNull();
  });

  it('sends nothing until the required fields are filled and the website is https', async () => {
    const fixture = await mount();
    await openRequest(fixture);
    await type(fixture, '#vendor-request-website', 'http://trimble.example');
    await submit(fixture);
    expect(api.createProductRequest).not.toHaveBeenCalled();
    expect(q(fixture, '#vendor-request-maker')!.getAttribute('aria-invalid')).toBe('true');
    expect(q(fixture, '#vendor-request-website-error')?.textContent).toContain('https://');
  });

  it('sends the request, shows the receipt, announces it and tells the tab', async () => {
    api.createProductRequest.mockImplementation(async (body: { name: string }) => ({
      request: { id: '00000000-0000-4000-8000-0000000071a9', name: body.name },
    }));
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount();
    const requested: unknown[] = [];
    fixture.componentInstance.requested.subscribe((r) => requested.push(r));
    await openRequest(fixture);
    await type(fixture, '#vendor-request-maker', 'Trimble');
    await type(fixture, '#vendor-request-website', 'https://connect.trimble.example');
    await type(fixture, '#vendor-request-body', 'We sync issues.');
    await submit(fixture);

    expect(api.createProductRequest).toHaveBeenCalledWith({
      context_product_id: OWN.id,
      name: 'Trimble Connect',
      maker: 'Trimble',
      website: 'https://connect.trimble.example',
      body: 'We sync issues.',
    });
    const receipt = q(fixture, '[data-testid="product-request-receipt"]')!;
    expect(receipt.textContent).toContain('We have your request.');
    expect(receipt.textContent).toContain(
      'We will add Trimble Connect or tell you why not. You will get an email and a message in your portal.',
    );
    expect(announce).toHaveBeenCalled();
    expect(requested).toHaveLength(1);

    q<HTMLButtonElement>(fixture, '[data-testid="product-request-again"]')!.click();
    await settle(fixture);
    expect(stepText(fixture)).toContain('Step 1 of 2');
  });

  it('says it is already in the list on a 409', async () => {
    api.createProductRequest.mockRejectedValue(apiError(409, 'PRODUCT_REQUEST_EXISTS'));
    const fixture = await mount();
    await openRequest(fixture);
    await type(fixture, '#vendor-request-maker', 'Trimble');
    await submit(fixture);
    expect(q(fixture, '[data-testid="product-request-notice"]')?.textContent?.trim()).toBe(
      'You already asked us to add Trimble Connect. It is in the list below.',
    );
    expect(q(fixture, '[data-testid="product-request-notice"]')?.getAttribute('role')).toBe(
      'alert',
    );
  });

  it('maps each refusal to its own sentence', () => {
    const codes = ['PRODUCT_REQUEST_EXISTS', 'NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED'];
    const messages = codes.map((code) => productRequestErrorMessage(apiError(400, code), 'X'));
    expect(new Set(messages).size).toBe(codes.length);
    expect(productRequestErrorMessage(new Error('x'), 'X')).toContain('Could not send');
  });
});

describe('the deep link (AECI-1377)', () => {
  async function mountAt(url: string): Promise<ComponentFixture<VendorIntegrationCreate>> {
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    const fixture = TestBed.createComponent(VendorIntegrationCreate);
    fixture.componentRef.setInput('contextProductId', OWN.id);
    fixture.componentRef.setInput('deepLink', true);
    await settle(fixture);
    await settle(fixture);
    return fixture;
  }

  it('opens on step 2 with the named product, and removes the params', async () => {
    api.getProduct.mockResolvedValue(PROCORE);
    const fixture = await mountAt('/?create=open&counterpart=procore');
    expect(api.getProduct).toHaveBeenCalledWith('procore');
    expect(stepText(fixture)).toContain('Step 2 of 2');
    expect(q(fixture, '[data-testid="create-counterpart"]')?.textContent).toContain('Procore');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('stays on step 1 when the product is not found', async () => {
    api.getProduct.mockRejectedValue(apiError(404, 'NOT_FOUND'));
    const fixture = await mountAt('/?create=open&counterpart=nope');
    expect(stepText(fixture)).toContain('Step 1 of 2');
    expect(q(fixture, '[data-testid="create-counterpart"]')).toBeNull();
  });

  it('stays on step 1 when the link names the tab’s own product', async () => {
    api.getProduct.mockResolvedValue(product(OWN.id, OWN.name));
    const fixture = await mountAt('/?create=open&counterpart=own');
    expect(stepText(fixture)).toContain('Step 1 of 2');
  });

  it('opens on step 1 with only create=open, and ignores the link when not routed', async () => {
    const fixture = await mountAt('/?create=open');
    expect(stepText(fixture)).toContain('Step 1 of 2');
    expect(api.getProduct).not.toHaveBeenCalled();

    configure();
    await TestBed.inject(Router).navigateByUrl('/?create=open&counterpart=procore');
    const unrouted = TestBed.createComponent(VendorIntegrationCreate);
    unrouted.componentRef.setInput('contextProductId', OWN.id);
    await settle(unrouted);
    expect(panel(unrouted)).toBeNull();
  });
});
