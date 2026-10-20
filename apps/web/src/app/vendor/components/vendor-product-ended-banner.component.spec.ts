/**
 * `VendorProductEndedBanner` (AECI-1408, `docs/VENDOR_SIGNUP_PROCESS.md` §3 step
 * 10, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18).
 *
 * Named `.component.spec.ts` so it runs under `ng test` (TestBed DI for
 * `LOCALE_ID` and `routerLink`).
 *
 * Pinned here:
 *  1. it shows for a product whose plan ended inside the last 90 days, and not
 *     after;
 *  2. never for a live plan, a plan that never existed, or one with no date;
 *  3. "Get licenses" only when the host passes a Billing link (an owner seat);
 *  4. calm: no alert role, no dismiss button.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorEntitlementBlock } from '@aeci/shared';
import { capabilitiesFor } from '@aeci/shared/entitlements';

import { VendorProductEndedBanner } from './vendor-product-ended-banner';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
});

function endedDaysAgo(days: number): VendorEntitlementBlock {
  const at = new Date(NOW - days * DAY_MS).toISOString();
  return {
    tier: 'unclaimed',
    status: 'expired',
    period_end: at,
    ended_at: at,
    capabilities: [...capabilitiesFor('unclaimed')],
  };
}

function create(
  plan: VendorEntitlementBlock,
  billingLink: string | null = '/vendor/summit-bim/billing',
): ComponentFixture<VendorProductEndedBanner> {
  const fixture = TestBed.createComponent(VendorProductEndedBanner);
  fixture.componentRef.setInput('plan', plan);
  fixture.componentRef.setInput('billingLink', billingLink);
  fixture.componentRef.setInput('now', NOW);
  fixture.detectChanges();
  return fixture;
}

const banner = (f: ComponentFixture<VendorProductEndedBanner>) =>
  (f.nativeElement as HTMLElement).querySelector('[data-testid="product-ended-banner"]');
const text = (f: ComponentFixture<VendorProductEndedBanner>) =>
  (banner(f)?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('VendorProductEndedBanner: when it shows', () => {
  it('shows for a plan that ended 10 days ago, with the date and what stays', () => {
    const f = create(endedDaysAgo(10));
    expect(banner(f)).not.toBeNull();
    expect(text(f)).toContain('Managed ended for this product');
    expect(text(f)).toContain('It ended on October 9, 2026.');
    expect(text(f)).toContain('Its content stays live and nothing you entered was removed.');
    expect(text(f)).toContain(
      'Its Managed fields stay as you left them, and you can no longer edit them. Get a license to edit them again.',
    );
    expect(text(f)).not.toContain('AEC Integrations maintains');
  });

  it('shows for a revoked plan too', () => {
    expect(banner(create({ ...endedDaysAgo(3), status: 'revoked' }))).not.toBeNull();
  });

  it('still shows on day 90, and stops after it', () => {
    expect(banner(create(endedDaysAgo(90)))).not.toBeNull();
    expect(banner(create(endedDaysAgo(91)))).toBeNull();
  });

  it('never shows for a live plan, a plan that never existed, or one with no date', () => {
    const live: VendorEntitlementBlock = {
      tier: 'verified',
      status: 'active',
      period_end: new Date(NOW - DAY_MS).toISOString(),
      ended_at: null,
      capabilities: [...capabilitiesFor('verified')],
    };
    expect(banner(create(live))).toBeNull();
    expect(banner(create({ ...endedDaysAgo(5), status: null, ended_at: null }))).toBeNull();
    expect(banner(create({ ...endedDaysAgo(5), ended_at: null }))).toBeNull();
  });
});

describe('VendorProductEndedBanner: who gets the button', () => {
  it('an owner gets "Get licenses" to the Billing tab', () => {
    const link = banner(create(endedDaysAgo(10)))?.querySelector('a');
    expect(link?.textContent?.trim()).toBe('Get licenses');
    expect(link?.getAttribute('href')).toBe('/vendor/summit-bim/billing');
  });

  it('a member sees the banner with no button', () => {
    const f = create(endedDaysAgo(10), null);
    expect(banner(f)).not.toBeNull();
    expect(banner(f)?.querySelector('a, button')).toBeNull();
  });

  it('is calm: no alert role and nothing to dismiss', () => {
    const f = create(endedDaysAgo(10));
    expect(banner(f)?.querySelector('[role="alert"]')).toBeNull();
    expect(banner(f)?.getAttribute('role')).toBeNull();
    expect(banner(f)?.querySelector('button')).toBeNull();
  });
});
