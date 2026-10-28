import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingLicense, VendorBillingResponse, VendorMeResponse } from '@aeci/shared';

import { VendorBillingStripePanel } from '../components/vendor-billing-stripe-panel';
import { stripeBillingErrorMessage } from '../components/vendor-billing-stripe-errors';
import {
  STRIPE_WATCH_INTERVAL_MS,
  STRIPE_WATCH_TIMEOUT_MS,
  VendorBillingStripeWatch,
} from '../components/vendor-billing-stripe-watch';
import { VendorApi } from '../vendor-api';
import {
  VENDOR_ACCEPTANCES_FIXTURE,
  VENDOR_BILLING_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorBillingSection } from './vendor-billing-section';

/**
 * The Billing tab's "Pay by card" panel and the Stripe return (AECI-1502, E9.4 of
 * AECI-1339). The panel shows for an owner only, and only when the read says
 * `stripe_checkout_available` (amendment R2). With no subscription it buys through
 * Checkout. With one it adds licenses in a dialog and opens the portal. Every refusal
 * code gets its own line. A `?checkout=` return shows a banner, drops the parameter,
 * and on success re-reads billing every 3 s until the licenses land or 60 s pass.
 */
function flush(): Promise<void> {
  if (vi.isFakeTimers()) return vi.advanceTimersByTimeAsync(0).then(() => undefined);
  return new Promise((resolve) => setTimeout(resolve));
}

/** Fake only the timers the watch uses, before the section schedules any. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function apiError(status: number, code: string, details?: Record<string, unknown>) {
  return new HttpErrorResponse({ status, error: { error: { code, message: 'x', details } } });
}

const AVAILABLE: VendorBillingResponse = {
  ...VENDOR_BILLING_FIXTURE,
  stripe_checkout_available: true,
};

const STRIPE_LICENSE: VendorBillingLicense = {
  ...VENDOR_BILLING_FIXTURE.licenses[1]!,
  id: '00000000-0000-4000-8000-0000000055a1',
  source: 'stripe',
  reference: null,
  ends_at: '2027-10-28',
};

const SUBSCRIBED: VendorBillingResponse = {
  ...AVAILABLE,
  licenses: [STRIPE_LICENSE, ...VENDOR_BILLING_FIXTURE.licenses],
  stripe: {
    interval: 'year',
    quantity: 1,
    current_period_end: '2027-10-28T00:00:00.000Z',
    cancel_at_period_end: false,
    synced: true,
  },
};

/** `billing` with `extra` more live Stripe licenses. */
function withMoreLicenses(billing: VendorBillingResponse, extra: number): VendorBillingResponse {
  const added = Array.from({ length: extra }, (_, i) => ({
    ...STRIPE_LICENSE,
    id: `00000000-0000-4000-8000-0000000056${String(i).padStart(2, '0')}`,
  }));
  return {
    ...billing,
    licenses: [...added, ...billing.licenses],
    stripe: billing.stripe ?? {
      interval: 'year',
      quantity: extra,
      current_period_end: '2027-10-28T00:00:00.000Z',
      cancel_at_period_end: false,
      synced: true,
    },
  };
}

describe('VendorBillingSection, paying by card (AECI-1502)', () => {
  let getBilling: ReturnType<typeof vi.fn>;
  let startCheckout: ReturnType<typeof vi.fn>;
  let addStripeLicenses: ReturnType<typeof vi.fn>;
  let openBillingPortal: ReturnType<typeof vi.fn>;
  let redirect: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getBilling = vi.fn().mockResolvedValue(AVAILABLE);
    startCheckout = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    addStripeLicenses = vi.fn().mockResolvedValue({ ok: true, pending: true });
    openBillingPortal = vi
      .fn()
      .mockResolvedValue({ url: 'https://billing.stripe.com/p/session/bps_1' });
    redirect = vi
      .spyOn(
        VendorBillingStripePanel.prototype as unknown as { redirect: (url: string) => void },
        'redirect',
      )
      .mockImplementation(() => undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: {
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
            getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
            startCheckout,
            addStripeLicenses,
            openBillingPortal,
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
    globalThis.history.replaceState(null, '', '/');
  });

  async function create(
    me: VendorMeResponse = VENDOR_ME_FIXTURE,
  ): Promise<ComponentFixture<VendorBillingSection>> {
    TestBed.inject(VendorPortalStore).seed(me);
    const fixture = TestBed.createComponent(VendorBillingSection);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Land on the tab the way Stripe sends the owner back: the browser URL carries
   *  the marker, and so does the router's. Returns the router's URL-drop spy. */
  async function returnFromStripe(search: string): Promise<ReturnType<typeof vi.spyOn>> {
    globalThis.history.replaceState(null, '', `/${search}`);
    const router = TestBed.inject(Router);
    await router.navigateByUrl(`/${search}`);
    return vi.spyOn(router, 'navigateByUrl');
  }

  const q = (fixture: ComponentFixture<unknown>, id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  // ── Gating ────────────────────────────────────────────────────────────────

  it('hides the panel when the tier does not sell through Stripe (R2)', async () => {
    getBilling.mockResolvedValue(VENDOR_BILLING_FIXTURE);
    const fixture = await create();

    expect(q(fixture, 'billing-stripe-panel')).toBeNull();
    expect(q(fixture, 'billing-intro-card')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Stripe');
  });

  // AECI-1396: the intro names paying by card only when the panel is there to do it.
  it('adds the card sentence to the intro when the tier sells through Stripe', async () => {
    getBilling.mockResolvedValue(AVAILABLE);
    const fixture = await create();

    expect(q(fixture, 'billing-intro-card')?.textContent?.trim()).toBe(
      'You can pay for licenses by card below, through Stripe.',
    );
  });

  it('hides the panel even with a subscription when unavailable', async () => {
    getBilling.mockResolvedValue({ ...SUBSCRIBED, stripe_checkout_available: false });
    const fixture = await create();

    expect(q(fixture, 'billing-stripe-panel')).toBeNull();
  });

  it('never shows a member the panel, and calls nothing', async () => {
    const fixture = await create({ ...VENDOR_ME_FIXTURE, seat_owner: false });

    expect(q(fixture, 'billing-stripe-panel')).toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
  });

  // ── Buying ────────────────────────────────────────────────────────────────

  it('offers an owner both billing periods with their prices and the agreement note', async () => {
    const fixture = await create();
    const panel = q(fixture, 'billing-stripe-panel') as HTMLElement;

    expect(panel.textContent).toContain('Pay by card');
    expect(panel.textContent).toContain('$250 a year per license');
    expect(panel.textContent).toContain('$25 a month per license');
    expect(panel.textContent).toContain('Total: $250 a year, plus tax where applicable.');
    expect(panel.textContent).toContain('you accept the');
    expect(panel.textContent).toContain('Card statements read THE WBS PROJECT.');
    const link = panel.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/legal/managed-plan-agreement');
    expect(q(fixture, 'stripe-checkout')?.textContent?.trim()).toBe('Continue to Stripe');
  });

  it('posts the chosen quantity and interval, then sends the browser to Stripe', async () => {
    const fixture = await create();
    (q(fixture, 'stripe-interval-month')!.querySelector('input') as HTMLInputElement).click();
    type(q(fixture, 'stripe-buy-quantity') as HTMLInputElement, '3');
    fixture.detectChanges();

    expect(q(fixture, 'stripe-total')?.textContent).toContain('Total: $75 a month');
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).click();
    await settle(fixture);

    expect(startCheckout).toHaveBeenCalledWith(3, 'month');
    expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1');
  });

  it('refuses a bad quantity before any request and focuses the field', async () => {
    const fixture = await create();
    const input = q(fixture, 'stripe-buy-quantity') as HTMLInputElement;
    type(input, '101');
    fixture.detectChanges();
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).click();
    await settle(fixture);

    expect(startCheckout).not.toHaveBeenCalled();
    expect(q(fixture, 'stripe-quantity-error')?.textContent).toContain('from 1 to 100');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('says so when Stripe is switched off, and stays put', async () => {
    startCheckout.mockRejectedValueOnce(apiError(503, 'STRIPE_UNAVAILABLE'));
    const fixture = await create();
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).click();
    await settle(fixture);

    const error = q(fixture, 'stripe-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('Paying by card is not available right now.');
    expect(redirect).not.toHaveBeenCalled();
    expect(getBilling).toHaveBeenCalledTimes(1);
  });

  it('re-reads billing on an interval mismatch and names the interval', async () => {
    startCheckout.mockRejectedValueOnce(
      apiError(409, 'LICENSE_INTERVAL_MISMATCH', { interval: 'month' }),
    );
    const fixture = await create();
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).click();
    await settle(fixture);

    expect(q(fixture, 'stripe-error')?.textContent).toContain('billed monthly');
    expect(getBilling).toHaveBeenCalledTimes(2);
  });

  it('moves focus to the reason when a stale checkout swaps the panel', async () => {
    startCheckout.mockRejectedValueOnce(
      apiError(409, 'STRIPE_SUBSCRIPTION_EXISTS', { interval: 'year' }),
    );
    const fixture = await create();
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).focus();
    getBilling.mockResolvedValue(SUBSCRIBED);
    (q(fixture, 'stripe-checkout') as HTMLButtonElement).click();
    await settle(fixture);
    await settle(fixture);

    expect(q(fixture, 'stripe-checkout')).toBeNull();
    const error = q(fixture, 'stripe-error') as HTMLElement;
    expect(error.textContent).toContain('already has a card subscription');
    expect(error.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(error);
  });

  // ── With a subscription ───────────────────────────────────────────────────

  it('shows the subscription, Add licenses and Manage billing in Stripe', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    const fixture = await create();
    const panel = q(fixture, 'billing-stripe-panel') as HTMLElement;

    expect(panel.textContent).toContain('Card subscription');
    expect(q(fixture, 'stripe-quantity')?.textContent?.trim()).toBe('1');
    expect(q(fixture, 'stripe-interval')?.textContent?.trim()).toBe('Billed yearly');
    expect(panel.textContent).toContain('Renews');
    expect(q(fixture, 'stripe-checkout')).toBeNull();
    expect(q(fixture, 'stripe-add-open')?.textContent?.trim()).toBe('Add licenses');
    expect(q(fixture, 'stripe-portal')?.textContent?.trim()).toBe('Manage billing in Stripe');
  });

  it('says when the subscription is set to end, and when Stripe was not reached', async () => {
    getBilling.mockResolvedValue({
      ...SUBSCRIBED,
      stripe: { ...SUBSCRIBED.stripe!, cancel_at_period_end: true, synced: false },
    });
    const fixture = await create();

    expect(q(fixture, 'stripe-cancelling')).not.toBeNull();
    expect(q(fixture, 'stripe-unsynced')).not.toBeNull();
    expect((q(fixture, 'billing-stripe-panel') as HTMLElement).textContent).toContain('Ends');
  });

  it('opens the portal and sends the browser there', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    const fixture = await create();
    (q(fixture, 'stripe-portal') as HTMLButtonElement).click();
    await settle(fixture);

    expect(openBillingPortal).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('https://billing.stripe.com/p/session/bps_1');
  });

  // AECI-1501: a lapsed card customer keeps its invoices and receipts in the portal.
  it('offers a lapsed customer the buy form and Manage billing in Stripe', async () => {
    getBilling.mockResolvedValue({ ...AVAILABLE, stripe: null, stripe_customer: true });
    const fixture = await create();

    expect(q(fixture, 'stripe-checkout')).not.toBeNull();
    expect(q(fixture, 'stripe-past')?.textContent).toContain(
      'Your past card invoices and receipts are in Stripe.',
    );
    (q(fixture, 'stripe-portal') as HTMLButtonElement).click();
    await settle(fixture);

    expect(openBillingPortal).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('https://billing.stripe.com/p/session/bps_1');
  });

  it('shows no portal button to an account that never paid by card', async () => {
    const fixture = await create();

    expect(q(fixture, 'stripe-checkout')).not.toBeNull();
    expect(q(fixture, 'stripe-portal')).toBeNull();
    expect(q(fixture, 'stripe-past')).toBeNull();
  });

  it('adds licenses from the dialog with the quantity only, then waits for them', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    const fixture = await create();
    (q(fixture, 'stripe-add-open') as HTMLButtonElement).click();
    await settle(fixture);

    const dialog = document.querySelector('[data-testid="stripe-add-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('$250 a year per license');
    expect(dialog.textContent).toContain('pro-rated');
    type(dialog.querySelector('[data-testid="stripe-add-quantity"]') as HTMLInputElement, '2');
    getBilling.mockResolvedValue(withMoreLicenses(SUBSCRIBED, 2));
    (dialog.querySelector('[data-testid="stripe-add-submit"]') as HTMLButtonElement).click();
    await settle(fixture);

    await settle(fixture);
    // Spartan closes after its 100 ms `closeDelay`.
    await new Promise((resolve) => setTimeout(resolve, 150));
    fixture.detectChanges();

    expect(addStripeLicenses).toHaveBeenCalledWith(2);
    expect(document.querySelector('[data-testid="stripe-add-dialog"]')).toBeNull();
    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain(
      'Stripe accepted the change',
    );
  });

  it('keeps an add refusal inside the dialog', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    addStripeLicenses.mockRejectedValueOnce(apiError(503, 'DEPENDENCY_FAILURE'));
    const fixture = await create();
    (q(fixture, 'stripe-add-open') as HTMLButtonElement).click();
    await settle(fixture);
    (document.querySelector('[data-testid="stripe-add-submit"]') as HTMLButtonElement).click();
    await settle(fixture);

    const error = document.querySelector('[data-testid="stripe-add-error"]');
    expect(error?.textContent).toContain('Stripe did not answer. Nothing was charged.');
    expect(document.querySelector('[data-testid="stripe-add-dialog"]')).not.toBeNull();
  });

  it('moves a stale add refusal out of the dialog and re-reads billing', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    addStripeLicenses.mockRejectedValueOnce(apiError(409, 'STRIPE_SUBSCRIPTION_REQUIRED'));
    const fixture = await create();
    (q(fixture, 'stripe-add-open') as HTMLButtonElement).click();
    await settle(fixture);
    getBilling.mockResolvedValue(AVAILABLE);
    (document.querySelector('[data-testid="stripe-add-submit"]') as HTMLButtonElement).click();
    await settle(fixture);
    // Spartan closes after its 100 ms `closeDelay`.
    await new Promise((resolve) => setTimeout(resolve, 150));
    fixture.detectChanges();

    expect(getBilling).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="stripe-add-dialog"]')).toBeNull();
    // The subscription is gone, so the buy form is back, with the reason above it.
    expect(q(fixture, 'stripe-checkout')).not.toBeNull();
    expect(q(fixture, 'stripe-error')?.textContent).toContain('no active card subscription');
    // The swap destroyed the dialog and its trigger: focus lands on the reason, not <body>.
    expect(document.activeElement).toBe(q(fixture, 'stripe-error'));
  });

  it('keeps an unpaid add in the dialog, says the card was not charged, and points to Stripe', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    addStripeLicenses.mockRejectedValueOnce(apiError(409, 'STRIPE_PAYMENT_INCOMPLETE'));
    const fixture = await create();
    (q(fixture, 'stripe-add-open') as HTMLButtonElement).click();
    await settle(fixture);
    (document.querySelector('[data-testid="stripe-add-submit"]') as HTMLButtonElement).click();
    await settle(fixture);

    const error = document.querySelector('[data-testid="stripe-add-error"]');
    expect(error?.textContent).toContain('Your card was not charged');
    expect(error?.textContent).toContain('Manage billing in Stripe');
    expect(document.querySelector('[data-testid="stripe-add-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="stripe-add-quantity"]'),
    );
    // Not stale: no re-read, and no "Stripe accepted the change" banner.
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(q(fixture, 'billing-checkout-notice')).toBeNull();
  });

  // ── The Stripe return ─────────────────────────────────────────────────────

  it('shows the cancelled banner and drops the parameter', async () => {
    const drop = await returnFromStripe('?checkout=cancelled&fixture=verified');
    const fixture = await create();
    await settle(fixture);

    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain(
      'Checkout cancelled',
    );
    expect(drop).toHaveBeenCalledTimes(1);
    const [tree, extras] = drop.mock.calls[0]!;
    expect(String(tree)).toBe('/?fixture=verified');
    expect(extras).toEqual({ replaceUrl: true });
  });

  it('re-reads billing every 3 s after a checkout until the licenses land, then stops', async () => {
    fakeTimers();
    const drop = await returnFromStripe('?checkout=success');
    const fixture = await create();
    await settle(fixture);
    const watch = fixture.debugElement.injector.get(VendorBillingStripeWatch);

    expect(String(drop.mock.calls[0]![0])).toBe('/');
    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain('Checkout complete');
    expect(getBilling).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STRIPE_WATCH_INTERVAL_MS);
    expect(getBilling).toHaveBeenCalledTimes(2);

    getBilling.mockResolvedValue(withMoreLicenses(AVAILABLE, 2));
    await vi.advanceTimersByTimeAsync(STRIPE_WATCH_INTERVAL_MS);
    fixture.detectChanges();
    expect(getBilling).toHaveBeenCalledTimes(3);
    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain(
      'Your new licenses are here',
    );
    expect(watch.polling).toBe(false);

    await vi.advanceTimersByTimeAsync(STRIPE_WATCH_INTERVAL_MS * 3);
    expect(getBilling).toHaveBeenCalledTimes(3);
  });

  it('stops after 60 s and says the licenses have not arrived yet', async () => {
    fakeTimers();
    await returnFromStripe('?checkout=success');
    const fixture = await create();
    await settle(fixture);
    const watch = fixture.debugElement.injector.get(VendorBillingStripeWatch);

    await vi.advanceTimersByTimeAsync(STRIPE_WATCH_TIMEOUT_MS);
    fixture.detectChanges();
    const reads = getBilling.mock.calls.length;

    expect(reads).toBe(1 + STRIPE_WATCH_TIMEOUT_MS / STRIPE_WATCH_INTERVAL_MS);
    expect(watch.polling).toBe(false);
    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain(
      'have not arrived yet',
    );
    await vi.advanceTimersByTimeAsync(STRIPE_WATCH_INTERVAL_MS * 3);
    expect(getBilling).toHaveBeenCalledTimes(reads);
  });

  it('ends the wait at once when the webhook beat the redirect back', async () => {
    getBilling.mockResolvedValue(SUBSCRIBED);
    await returnFromStripe('?checkout=success');
    const fixture = await create();
    await settle(fixture);

    expect(q(fixture, 'billing-checkout-notice-title')?.textContent).toContain(
      'Your new licenses are here',
    );
    expect(fixture.debugElement.injector.get(VendorBillingStripeWatch).polling).toBe(false);
  });

  it('dismissing the banner stops the wait', async () => {
    await returnFromStripe('?checkout=success');
    const fixture = await create();
    await settle(fixture);
    (q(fixture, 'billing-checkout-notice-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(q(fixture, 'billing-checkout-notice')).toBeNull();
    expect(fixture.debugElement.injector.get(VendorBillingStripeWatch).polling).toBe(false);
  });
});

describe('stripeBillingErrorMessage (AECI-1502)', () => {
  const cases: readonly [HttpErrorResponse, string, boolean][] = [
    [apiError(503, 'STRIPE_UNAVAILABLE'), 'not available right now', false],
    [apiError(409, 'STRIPE_SUBSCRIPTION_EXISTS', { interval: 'year' }), 'billed yearly', true],
    [apiError(409, 'STRIPE_SUBSCRIPTION_EXISTS'), 'already has a card subscription', true],
    [apiError(409, 'LICENSE_INTERVAL_MISMATCH', { interval: 'month' }), 'billed monthly', true],
    [apiError(409, 'STRIPE_SUBSCRIPTION_REQUIRED'), 'no active card subscription', true],
    [apiError(409, 'STRIPE_PAYMENT_INCOMPLETE'), 'Your card was not charged', false],
    [apiError(503, 'DEPENDENCY_FAILURE'), 'Stripe did not answer', false],
    [apiError(429, 'RATE_LIMITED'), 'Too many attempts', false],
    [apiError(400, 'VALIDATION_FAILED'), 'from 1 to 100', false],
    [apiError(403, 'FORBIDDEN'), 'Only an account owner', false],
  ];

  it.each(cases)('maps %#', (err, text, stale) => {
    const mapped = stripeBillingErrorMessage(err, 'checkout');
    expect(mapped.message).toContain(text);
    expect(mapped.stale).toBe(stale);
  });

  it('falls back to the action line for anything else', () => {
    expect(stripeBillingErrorMessage(new Error('offline'), 'portal').message).toBe(
      'Could not open billing in Stripe. Try again.',
    );
    expect(stripeBillingErrorMessage(apiError(500, 'INTERNAL'), 'add').message).toBe(
      'Could not add the licenses. Try again.',
    );
  });

  it('never uses imperative upsell copy', () => {
    for (const [err] of cases) {
      expect(stripeBillingErrorMessage(err, 'checkout').message).not.toMatch(/^(Get|Buy) /);
    }
  });
});
