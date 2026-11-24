import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorBillingLicenses, toVendorBillingLicenseRow } from './vendor-billing-licenses';

/**
 * The vendor licenses table (AECI-1390, E5.4): source words, calendar dates that
 * never shift a day, the reference or a dash, the status and its flags, live
 * first, and an empty state with no buy button. AECI-1866: the status chip tones,
 * the real end date on an ended row, and ended rows in a closed group.
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
    // AECI-1866: Ends is the day it ended, and the chip carries no date.
    expect(ended![3]).toBe('Aug 31, 2026');
    expect(ended![4]).toBe('Ended, lapsed');
    expect(ended![5]).toBe('INV-1043');
  });

  it('flags an open early-unassign request, with its date, in the status', () => {
    const [row] = rows(
      render([
        {
          ...ASSIGNED,
          open_release_request: { id: 'req-1', created_at: '2026-10-14T09:30:00.000Z' },
        },
      ]),
    );

    expect(row![4]).toContain('Early unassign requested Oct 14, 2026');
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

    const [main] = (fixture.nativeElement as HTMLElement).querySelectorAll('table');
    expect(main!.querySelectorAll('th')).toHaveLength(6);
  });

  it('keeps a minimum table width so a narrow screen scrolls, not crushes (AECI-1866 review)', () => {
    const el = render(VENDOR_BILLING_FIXTURE.licenses).nativeElement as HTMLElement;
    const tables = [...el.querySelectorAll('table')];

    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(t.classList).toContain('min-w-[58rem]');
      expect(t.closest('.overflow-x-auto')).not.toBeNull();
      // Rem widths, never percentages: a percentage column shrinks with the screen.
      expect([...t.querySelectorAll('col')].some((c) => c.className.includes('%'))).toBe(false);
    }
  });

  it('shows an empty state that no longer promises buying "later" (AECI-1502)', () => {
    const el = render([]).nativeElement as HTMLElement;

    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('No subscriptions yet.');
    expect(el.textContent).toContain('Subscriptions your company pays for');
    expect(el.textContent).not.toContain('later');
    // The buy panel is the section's, gated on stripe_checkout_available: the table
    // itself never carries a buy control.
    expect(el.querySelector('button, a')).toBeNull();
  });

  it('says so when the list was cut at the cap', () => {
    const el = render([POOL], true).nativeElement as HTMLElement;

    expect(el.textContent).toContain('Showing the first 500 subscriptions.');
  });
  describe('ended rows (AECI-1866)', () => {
    const RELEASED: VendorBillingLicense = {
      ...ENDED,
      id: 'l-released',
      ends_at: '2027-11-16',
      ended_at: '2026-11-16T10:00:00.000Z',
      end_reason: 'released',
    };

    const el = (fixture: ComponentFixture<VendorBillingLicenses>) =>
      fixture.nativeElement as HTMLElement;

    it('keeps live rows in the main table and ended rows in a closed group', () => {
      const root = el(render([ASSIGNED, ENDED, RELEASED]));
      const group = root.querySelector(
        'details[data-testid="licenses-ended"]',
      ) as HTMLDetailsElement;

      expect(group).not.toBeNull();
      expect(group.open).toBe(false);
      expect(group.querySelector('summary')?.textContent?.trim()).toBe('Ended subscriptions (2)');
      expect(group.querySelectorAll('[data-testid="license-row"]')).toHaveLength(2);

      const mainRows = [...root.querySelectorAll('[data-testid="license-row"]')].filter(
        (r) => !group.contains(r),
      );
      expect(mainRows).toHaveLength(1);
      expect(mainRows[0]!.getAttribute('data-tone')).toBe('live');
    });

    it('uses the same columns in the ended group', () => {
      const root = el(render([ASSIGNED, ENDED]));
      const [main, ended] = [...root.querySelectorAll('table')];
      const heads = (t: Element) => [...t.querySelectorAll('th')].map((h) => h.textContent?.trim());

      expect(heads(ended!)).toEqual(heads(main!));
    });

    it('renders no group when nothing has ended', () => {
      const root = el(render([ASSIGNED, POOL]));

      expect(root.querySelector('details')).toBeNull();
    });

    it('shows the day it actually ended, not the term end', () => {
      const [row] = rows(render([RELEASED]));

      expect(row![3]).toBe('Nov 16, 2026');
      expect(row![3]).not.toContain('2027');
      expect(row![4]).toBe('Ended, released');
    });

    it('says there is no live subscription when every row has ended', () => {
      const root = el(render([ENDED]));

      expect(root.querySelector('[data-testid="licenses-none-live"]')?.textContent?.trim()).toBe(
        'No live subscriptions.',
      );
      expect(root.querySelector('details')).not.toBeNull();
    });
  });

  // AECI-1812: the status is an `aec-chip`. The tone is on the inner `.aec-chip`.
  describe('status chips (AECI-1866, AECI-1812)', () => {
    const chip = (fixture: ComponentFixture<VendorBillingLicenses>) =>
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="license-status"] .aec-chip',
      )!;
    const tone = (c: Element) => c.getAttribute('data-tone');
    const soon = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

    it('gives a live subscription the Forest chip', () => {
      const c = chip(render([POOL]));

      expect(tone(c)).toBe('wash');
      expect(c.textContent?.trim()).toBe('Live');
    });

    it('gives a subscription that will not renew the warning chip, and says so in words', () => {
      const fixture = render([{ ...POOL, cancel_at_term_end: true }]);
      const [row] = rows(fixture);

      expect(tone(chip(fixture))).toBe('strong');
      // The clock keeps the warning apart from an ended row by more than colour.
      expect(chip(fixture).querySelector('svg')).not.toBeNull();
      expect(chip(fixture).textContent?.trim()).toBe('Live');
      expect(row![4]).toContain('Cancels at term end');
    });

    it('says "Ends soon" in the warning chip inside the renewal window', () => {
      const c = chip(render([{ ...POOL, ends_at: soon(10) }]));

      expect(tone(c)).toBe('strong');
      expect(c.textContent?.trim()).toBe('Ends soon');
    });

    it('never calls a card subscription "Ends soon": Stripe renews it', () => {
      const c = chip(render([{ ...POOL, source: 'stripe', ends_at: soon(10) }]));

      expect(tone(c)).toBe('wash');
      expect(c.textContent?.trim()).toBe('Live');
    });

    it('gives an ended subscription the neutral chip', () => {
      const c = chip(render([ENDED]));

      expect(tone(c)).toBe('quiet');
    });

    it('draws the window edge at 45 days', () => {
      const now = Date.UTC(2026, 10, 18);
      const at = (iso: string) =>
        toVendorBillingLicenseRow({ ...POOL, ends_at: iso }, 'en-US', now).tone;

      expect(at('2027-01-02')).toBe('warning');
      expect(at('2027-01-03')).toBe('live');
      // A past end on a live row is not "ending soon"; the term sweep owns it.
      expect(at('2026-11-17')).toBe('live');
    });
  });
});
