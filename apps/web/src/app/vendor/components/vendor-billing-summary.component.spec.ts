import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorBillingSummary } from './vendor-billing-summary';

/**
 * The Billing tab's "At a glance" card: live licenses only, split into on a
 * product and unassigned, the release-at-renewal row only when one is set, and
 * a note when the read was truncated.
 */
const [ASSIGNED, POOL, ENDED] = VENDOR_BILLING_FIXTURE.licenses as [
  VendorBillingLicense,
  VendorBillingLicense,
  VendorBillingLicense,
];

describe('VendorBillingSummary', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function render(
    licenses: readonly VendorBillingLicense[],
    productsOnFree = 2,
    truncated = false,
  ): ComponentFixture<VendorBillingSummary> {
    const fixture = TestBed.createComponent(VendorBillingSummary);
    fixture.componentRef.setInput('licenses', licenses);
    fixture.componentRef.setInput('productsOnFree', productsOnFree);
    fixture.componentRef.setInput('truncated', truncated);
    fixture.detectChanges();
    return fixture;
  }

  const value = (fixture: ComponentFixture<VendorBillingSummary>, id: string) =>
    (fixture.nativeElement as HTMLElement)
      .querySelector(`[data-testid="summary-${id}"]`)
      ?.textContent?.trim() ?? null;

  it('counts live licenses and ignores ended ones', () => {
    const fixture = render([ASSIGNED, POOL, ENDED]);
    expect(value(fixture, 'total')).toBe('2');
    expect(value(fixture, 'assigned')).toBe('1');
    expect(value(fixture, 'unassigned')).toBe('1');
    expect(value(fixture, 'on-free')).toBe('2');
  });

  it('shows the release-at-renewal row only when a live license has the flag', () => {
    expect(value(render([ASSIGNED, POOL]), 'releasing')).toBe('1');
    expect(value(render([{ ...ASSIGNED, release_at_renewal: false }, POOL]), 'releasing')).toBe(
      null,
    );
  });

  it('shows the products-on-Free row only when the count is above zero', () => {
    expect(value(render([POOL], 3), 'on-free')).toBe('3');
    expect(value(render([POOL], 0), 'on-free')).toBe(null);
  });

  it('shows zeros with no licenses and notes a truncated read', () => {
    const empty = render([], 0);
    expect(value(empty, 'total')).toBe('0');
    expect((empty.nativeElement as HTMLElement).textContent).not.toContain('Counts cover');
    const truncated = render([POOL], 1, true);
    expect((truncated.nativeElement as HTMLElement).textContent).toContain('Counts cover');
  });
});
