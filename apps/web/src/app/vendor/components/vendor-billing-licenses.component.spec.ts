import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorBillingLicenses } from './vendor-billing-licenses';

/**
 * The vendor licenses table (AECI-1390, E5.4): source words, calendar dates that
 * never shift a day, the reference or a dash, the status and its flags, live
 * first, and an empty state with no buy button.
 */
const [ASSIGNED, POOL, ENDED] = VENDOR_BILLING_FIXTURE.licenses as [
  VendorBillingLicense,
  VendorBillingLicense,
  VendorBillingLicense,
];

describe('VendorBillingLicenses', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  function render(
    licenses: readonly VendorBillingLicense[],
    truncated = false,
  ): ComponentFixture<VendorBillingLicenses> {
    const fixture = TestBed.createComponent(VendorBillingLicenses);
    fixture.componentRef.setInput('licenses', licenses);
    fixture.componentRef.setInput('truncated', truncated);
    fixture.detectChanges();
    return fixture;
  }

  const rows = (fixture: ComponentFixture<VendorBillingLicenses>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="license-row"]')].map(
      (row) => [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''),
    );

  it('renders source, product, dates, status and reference for each license', () => {
    const [assigned, pool, ended] = rows(render(VENDOR_BILLING_FIXTURE.licenses));

    expect(assigned).toEqual([
      'Complimentary',
      'Summit Model Coordination',
      'Sep 1, 2026',
      'Aug 31, 2027',
      expect.stringContaining('Live'),
      expect.stringContaining('None'),
    ]);
    expect(assigned![4]).toContain('Releases at renewal');
    expect(pool).toEqual([
      'Invoice',
      'In pool, not assigned',
      'Oct 1, 2026',
      'Sep 30, 2027',
      'Live',
      'PO-2026-0412',
    ]);
    expect(ended![4]).toBe('Ended Aug 31, 2026, term ended');
    expect(ended![5]).toBe('INV-1043');
  });

  it('links an assigned product to its portal page', () => {
    const fixture = render([ASSIGNED]);
    const link = (fixture.nativeElement as HTMLElement).querySelector('td a');

    expect(link?.getAttribute('href')).toBe('/products/summit-model-coordination');
  });

  it('puts live licenses first, whatever order they arrive in', () => {
    const [first, , last] = rows(render([ENDED, POOL, ASSIGNED]));

    expect(first![4]).toContain('Live');
    expect(last![4]).toContain('Ended');
  });

  it('says a card license with no end is monthly, and flags a term-end cancel', () => {
    const [row] = rows(
      render([{ ...POOL, source: 'stripe', ends_at: null, cancel_at_term_end: true }]),
    );

    expect(row![0]).toBe('Card');
    expect(row![3]).toBe('Monthly, no end date');
    expect(row![4]).toContain('Cancels at term end');
  });

  it('has no Actions column until E5.5 passes row actions', () => {
    const fixture = render(VENDOR_BILLING_FIXTURE.licenses);

    expect((fixture.nativeElement as HTMLElement).querySelectorAll('th')).toHaveLength(6);
  });

  it('shows the empty state with no buy button', () => {
    const el = render([]).nativeElement as HTMLElement;

    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('No licenses yet.');
    expect(el.querySelector('button, a')).toBeNull();
  });

  it('says so when the list was cut at the cap', () => {
    const el = render([POOL], true).nativeElement as HTMLElement;

    expect(el.textContent).toContain('Showing the first 500 licenses.');
  });
});
