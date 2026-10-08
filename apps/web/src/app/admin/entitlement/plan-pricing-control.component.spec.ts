/**
 * `PlanPricingControl`: the admin "Plan price" control on `/admin/vendors/:id`
 * (ruling 2026-10-08, `STAGE_2_PAID_TIERS_SPEC.md` §13.13).
 *
 * Pinned here:
 *  1. the preview line says exactly what the vendor panel will, by precedence
 *     (message, then price, then the default);
 *  2. the price field is dollars and goes on the wire as whole cents;
 *  3. a blank message is null, and Reset sends both null;
 *  4. invalid input blocks Save and is described to assistive tech;
 *  5. like `EntitlementControl`, no heading and no live region of its own.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SetVendorPlanPricingInput, VendorPlanPricingResponse } from '@aeci/shared';

import { AdminPlanPricingApi } from './admin-plan-pricing-api';
import { PlanPricingControl } from './plan-pricing-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';
const DEFAULT: VendorPlanPricingResponse = {
  vendor_id: VENDOR_ID,
  managed_price_cents: null,
  message: null,
  updated_by: null,
  updated_at: null,
};

interface ApiMock {
  setPlanPricing: ReturnType<typeof vi.fn>;
}

function makeApiMock(): ApiMock {
  return {
    setPlanPricing: vi.fn(
      async (
        vendorId: string,
        input: SetVendorPlanPricingInput,
      ): Promise<VendorPlanPricingResponse> =>
        input.managed_price_cents === null && input.message === null
          ? { ...DEFAULT, vendor_id: vendorId }
          : {
              vendor_id: vendorId,
              ...input,
              updated_by: '00000000-0000-4000-8000-000000000900',
              updated_at: '2026-10-08T12:00:00.000Z',
            },
    ),
  };
}

@Component({
  selector: 'aec-test-host',
  imports: [PlanPricingControl],
  template: `
    <h3 id="host-heading">Plan price</h3>
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-plan-pricing-control
      [vendorId]="vendorId"
      vendorName="Autodesk, Inc."
      [pricing]="pricing()"
      idPrefix="host-1"
      labelledBy="host-heading"
      (changed)="onChanged($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly pricing = signal<VendorPlanPricingResponse>(DEFAULT);
  readonly announced = signal('');
  readonly changes: VendorPlanPricingResponse[] = [];

  onChanged(p: VendorPlanPricingResponse): void {
    this.changes.push(p);
    this.pricing.set(p);
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(api: ApiMock, pricing: VendorPlanPricingResponse = DEFAULT) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminPlanPricingApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.pricing.set(pricing);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };
  return { fixture, host: fixture.componentInstance, el, refresh };
}

const priceInput = (el: HTMLElement) => el.querySelector<HTMLInputElement>('#plan-price-host-1')!;
const messageInput = (el: HTMLElement) =>
  el.querySelector<HTMLTextAreaElement>('#plan-message-host-1')!;
const preview = (el: HTMLElement) =>
  el.querySelector('[data-testid="plan-pricing-preview"]')?.textContent?.trim();
const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('PlanPricingControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('starts on the default, with the default hint and preview', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('Default price');
    expect(el.textContent).toContain('Default: $25 a month per product.');
    expect(preview(el)).toBe('Managed is $25 a month per product.');
    expect(button(el, 'Reset to default').disabled).toBe(true);
  });

  it('says it is display only', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('Display only.');
    expect(el.textContent).toContain('never changes the plan');
  });

  it('previews a price override, then saves it as whole cents', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api);
    type(priceInput(el), '12.50');
    await refresh();
    expect(preview(el)).toBe('Managed is $12.50 a month per product.');

    button(el, 'Save plan price').click();
    await refresh();
    expect(api.setPlanPricing).toHaveBeenCalledWith(VENDOR_ID, {
      managed_price_cents: 1250,
      message: null,
    });
    expect(host.changes).toHaveLength(1);
    expect(el.textContent).toContain('Custom price set: $12.50 a month per product');
    expect(el.textContent).toContain('Last changed October 8, 2026');
    expect(host.announced()).toBe('Plan price saved for Autodesk, Inc..');
  });

  it('parses cents by string, so 0.29 is 29 cents', async () => {
    const api = makeApiMock();
    const { el, refresh } = await setup(api);
    type(priceInput(el), '0.29');
    await refresh();
    button(el, 'Save plan price').click();
    await refresh();
    expect(api.setPlanPricing.mock.calls[0]![1]).toEqual({
      managed_price_cents: 29,
      message: null,
    });
  });

  it('lets a message beat the price in the preview, and trims it on the wire', async () => {
    const api = makeApiMock();
    const { el, refresh } = await setup(api);
    type(priceInput(el), '12.50');
    type(messageInput(el), '  Free until December 12,\n then 50% off for the next year.  ');
    await refresh();
    expect(preview(el)).toBe('Free until December 12, then 50% off for the next year.');
    expect(el.querySelector('[data-testid="plan-message-count"]')?.textContent).toContain(
      '55 of 280 characters',
    );

    button(el, 'Save plan price').click();
    await refresh();
    expect(api.setPlanPricing).toHaveBeenCalledWith(VENDOR_ID, {
      managed_price_cents: 1250,
      message: 'Free until December 12, then 50% off for the next year.',
    });
  });

  it('renders a message preview as text, never markup', async () => {
    const { el, refresh } = await setup(makeApiMock());
    type(messageInput(el), '<b>Half</b> price');
    await refresh();
    const line = el.querySelector('[data-testid="plan-pricing-preview"]')!;
    expect(line.querySelector('b')).toBeNull();
    expect(line.textContent?.trim()).toBe('<b>Half</b> price');
  });

  it('blocks Save on an invalid price and describes the error', async () => {
    const api = makeApiMock();
    const { el, refresh } = await setup(api);
    type(priceInput(el), '12.345');
    await refresh();
    const input = priceInput(el);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('plan-price-error-host-1');
    expect(el.querySelector('#plan-price-error-host-1')?.textContent).toContain(
      'Enter a price in dollars',
    );
    expect(button(el, 'Save plan price').disabled).toBe(true);
    // The preview ignores the bad price rather than inventing one.
    expect(preview(el)).toBe('Managed is $25 a month per product.');
  });

  it('blocks Save on a message over the limit', async () => {
    const { el, refresh } = await setup(makeApiMock());
    type(messageInput(el), 'x'.repeat(281));
    await refresh();
    expect(messageInput(el).getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Keep it to 280 characters');
    expect(button(el, 'Save plan price').disabled).toBe(true);
  });

  it('pre-fills from the stored override, and Reset sends both null', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api, {
      ...DEFAULT,
      managed_price_cents: 4000,
      message: 'Half price for pilots',
      updated_at: '2026-10-01T00:00:00.000Z',
    });
    expect(priceInput(el).value).toBe('40');
    expect(messageInput(el).value).toBe('Half price for pilots');
    expect(el.textContent).toContain('Custom message set');

    button(el, 'Reset to default').click();
    await refresh();
    expect(api.setPlanPricing).toHaveBeenCalledWith(VENDOR_ID, {
      managed_price_cents: null,
      message: null,
    });
    expect(host.pricing()).toEqual(DEFAULT);
    expect(priceInput(el).value).toBe('');
    expect(messageInput(el).value).toBe('');
    expect(preview(el)).toBe('Managed is $25 a month per product.');
    expect(host.announced()).toBe('Plan price reset to the default for Autodesk, Inc..');
  });

  it('keeps the form and shows an alert when the save fails', async () => {
    const api = makeApiMock();
    api.setPlanPricing.mockRejectedValueOnce(new HttpErrorResponse({ status: 400 }));
    const { el, host, refresh } = await setup(api);
    type(priceInput(el), '10');
    await refresh();
    button(el, 'Save plan price').click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Check the price and the message',
    );
    expect(host.changes).toHaveLength(0);
    expect(priceInput(el).value).toBe('10');
  });

  it('labels every field and renders no heading or live region of its own', async () => {
    const { el } = await setup(makeApiMock());
    const control = el.querySelector('aec-plan-pricing-control') as HTMLElement;
    expect(control.querySelector('label[for="plan-price-host-1"]')).not.toBeNull();
    expect(control.querySelector('label[for="plan-message-host-1"]')).not.toBeNull();
    expect(control.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(control.querySelector('[role="status"], [aria-live]')).toBeNull();
    expect(control.firstElementChild?.getAttribute('aria-labelledby')).toBe('host-heading');
  });
});
