/**
 * AECI-1372 (E4.3): the Billing tab body. Flags, the ban banner, the dash cells for
 * absent Stripe fields, the empty states, and the E4.2 row-actions seam, with the
 * AECI-1371 `LicenseRowActions` mounted in it.
 */
import { Component, TemplateRef, provideZonelessChangeDetection, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AdminBillingLicense, AdminVendorBillingResponse } from '@aeci/shared';

import {
  BillingLicensesTable,
  toBillingLicenseRow,
  type BillingLicenseRowContext,
} from './billing-licenses-table';
import { AdminLicensesApi } from './admin-licenses-api';
import { LicenseRowActions } from './license-row-actions';

function makeLicense(over: Partial<AdminBillingLicense> = {}): AdminBillingLicense {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    source: 'invoice',
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2027-09-30',
    ended_at: null,
    end_reason: null,
    live: true,
    reference: 'PO-77',
    assigned_product: { id: 'p1', slug: 'revit', name: 'Revit' },
    assigned_at: '2026-10-02T00:00:00.000Z',
    release_at_renewal: false,
    cancel_at_term_end: false,
    cancel_reason: null,
    stripe_subscription_id: null,
    terms_version: null,
    granted_by: 'admin-1',
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function makeBilling(over: Partial<AdminVendorBillingResponse> = {}): AdminVendorBillingResponse {
  return {
    vendor_id: 'v1',
    billing_account: {
      id: 'ba1',
      name: 'Autodesk, Inc.',
      billing_email: null,
      stripe_customer_id: null,
      created_at: '2026-10-01T00:00:00.000Z',
      owner_seats: [
        { user_id: 'u1', display_name: 'Ada', email: 'ada@autodesk.com', banned: false },
        { user_id: 'u2', display_name: null, email: 'bob@autodesk.com', banned: true },
      ],
      seat_emails_available: true,
    },
    licenses: [makeLicense()],
    licenses_truncated: false,
    acceptances: [],
    acceptances_truncated: false,
    release_requests: [],
    ...over,
  };
}

function mount(
  billing: AdminVendorBillingResponse | null,
  state: Partial<{ loading: boolean; failed: boolean }> = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(BillingLicensesTable);
  fixture.componentRef.setInput('billing', billing);
  fixture.componentRef.setInput('loading', state.loading ?? false);
  fixture.componentRef.setInput('failed', state.failed ?? false);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('BillingLicensesTable', () => {
  it('renders the account with a dash for each absent Stripe field', () => {
    const { el } = mount(makeBilling());
    const account = el.querySelector('section[aria-labelledby="admin-vendor-billing-account"]')!;
    expect(account.textContent).toContain('Autodesk, Inc.');
    // The visible dash is hidden from AT; the words are what a screen reader hears.
    expect(account.textContent).toContain('No billing email set');
    expect(account.textContent).toContain('No Stripe customer');
    expect(account.querySelectorAll('[aria-hidden="true"]').length).toBe(2);
    expect(account.textContent).toContain('Ada');
    // No display name: the seat reads by its email (AECI-1277), and the ban shows.
    expect(account.textContent).toContain('bob@autodesk.com');
    expect(account.textContent).toContain('Banned');
  });

  it('renders the license row with a dash for no Stripe subscription', () => {
    const { el } = mount(makeBilling());
    const row = el.querySelector('[data-testid="billing-license-row"]')!;
    expect(row.textContent).toContain('Revit');
    expect(row.textContent).toContain('Invoice or PO');
    expect(row.textContent).toContain('PO-77');
    expect(row.textContent).toContain('Live');
    expect(row.textContent).toContain('No Stripe subscription');
    expect(row.textContent).toContain('No terms version');
    // A table per AECI-694: captioned, header cells scoped.
    const table = row.closest('table')!;
    expect(table.querySelector('caption')?.textContent?.trim()).toBeTruthy();
    for (const th of table.querySelectorAll('thead th'))
      expect(th.getAttribute('scope')).toBe('col');
  });

  it('flags a live license that cancels at term end, and raises the banner', () => {
    const { el } = mount(
      makeBilling({
        licenses: [
          makeLicense({ cancel_at_term_end: true, cancel_reason: 'vendor-banned' }),
          makeLicense({ id: 'l2', assigned_product: null }),
        ],
      }),
    );
    const flags = el.querySelectorAll('[data-testid="billing-license-cancel"]');
    expect(flags).toHaveLength(1);
    expect(flags[0].textContent?.trim()).toBe('Cancels at term end: vendor banned');
    const banner = el.querySelector('[data-testid="billing-cancel-banner"]');
    expect(banner?.textContent).toContain('1 live license cancels at term end');
    expect(banner?.textContent).toContain('vendor banned');
    expect(el.textContent).toContain('Unassigned');
  });

  it('raises no banner when only an ended license carries the flag', () => {
    const { el } = mount(
      makeBilling({
        licenses: [
          makeLicense({
            live: false,
            ended_at: '2026-10-10T00:00:00.000Z',
            end_reason: 'lapsed',
            cancel_at_term_end: true,
            cancel_reason: 'vendor-banned',
          }),
        ],
      }),
    );
    expect(el.querySelector('[data-testid="billing-cancel-banner"]')).toBeNull();
    expect(el.querySelector('[data-testid="billing-license-cancel"]')).toBeNull();
    expect(el.textContent).toContain('Ended Oct 10, 2026, lapsed');
  });

  it('says the vendor has no billing account, that it is a bug to file, and lists no licenses', () => {
    const { el } = mount(makeBilling({ billing_account: null, licenses: [] }));
    const note = el.querySelector('[data-testid="billing-no-account"]')?.textContent ?? '';
    expect(note).toContain('This vendor has no billing account.');
    expect(note).toContain('The E1.5 back-fill should have created one');
    expect(note).toContain('this is a bug: file it in Linear');
    expect(note).not.toContain('Report it to the team');
    expect(el.querySelector('section[aria-labelledby="admin-vendor-billing-licenses"]')).toBeNull();
  });

  it('renders the empty states for licenses, acceptances and requests', () => {
    const { el } = mount(makeBilling({ licenses: [] }));
    expect(el.textContent).toContain('No licenses on this account.');
    expect(el.textContent).toContain('No acceptances on record.');
    expect(el.textContent).toContain('No early-unassign requests.');
  });

  it('renders acceptances with a dash for an unrecorded IP', () => {
    const { el } = mount(
      makeBilling({
        acceptances: [
          {
            id: 'a1',
            document: 'managed_plan',
            version: '1.0',
            source: 'checkout',
            email: 'ada@autodesk.com',
            profile_id: null,
            billing_account_id: 'ba1',
            vendor_request_id: null,
            stripe_checkout_session_id: 'cs_1',
            accepted_at: '2026-10-03T00:00:00.000Z',
            vendor_id: 'v1',
            ip: null,
            user_agent: null,
            created_at: '2026-10-03T00:00:00.000Z',
          },
        ],
      }),
    );
    const section = el.querySelector(
      'section[aria-labelledby="admin-vendor-billing-acceptances"]',
    )!;
    expect(section.textContent).toContain('Managed plan agreement');
    expect(section.textContent).toContain('Stripe checkout');
    expect(section.textContent).toContain('Not recorded');
  });

  it('shows the loading and failed states', () => {
    expect(mount(null, { loading: true }).el.textContent).toContain('Loading this vendor');
    expect(mount(null, { failed: true }).el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('has no Actions column until a row-actions template is supplied (the E4.2 seam)', () => {
    const { el } = mount(makeBilling());
    expect(el.textContent).not.toContain('Actions');
  });

  it('renders the row-actions template once per license with the row model', () => {
    @Component({
      imports: [BillingLicensesTable],
      template: `
        <ng-template #actions let-row>
          <button type="button" class="row-action">Act on {{ row.license.id }}</button>
        </ng-template>
        <aec-billing-licenses-table
          [billing]="billing"
          [loading]="false"
          [failed]="false"
          [rowActions]="actions"
        />
      `,
    })
    class Host {
      billing = makeBilling();
      readonly actions = viewChild<TemplateRef<BillingLicenseRowContext>>('actions');
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Actions');
    const buttons = [...el.querySelectorAll('button.row-action')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'Act on 00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('with the E4.2 row actions (AECI-1371): live rows act, Stripe revokes only, ended rows offer nothing', () => {
    @Component({
      imports: [BillingLicensesTable, LicenseRowActions],
      template: `
        <ng-template #actions let-row>
          <aec-license-row-actions [row]="row" [idPrefix]="'l-' + row.license.id" />
        </ng-template>
        <aec-billing-licenses-table
          [billing]="billing"
          [loading]="false"
          [failed]="false"
          [rowActions]="actions"
        />
      `,
    })
    class Host {
      billing = makeBilling({
        licenses: [
          makeLicense({ id: 'live-invoice' }),
          makeLicense({ id: 'live-stripe', source: 'stripe', reference: null }),
          makeLicense({
            id: 'ended',
            live: false,
            ended_at: '2026-10-10T00:00:00.000Z',
            end_reason: 'revoked',
          }),
        ],
      });
      readonly actions = viewChild<TemplateRef<BillingLicenseRowContext>>('actions');
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AdminLicensesApi, useValue: { updateLicense: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const rows = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="billing-license-row"]',
      ),
    ];
    const labels = rows.map((r) =>
      [...r.querySelectorAll('aec-license-row-actions button')].map((b) => b.textContent?.trim()),
    );
    expect(labels).toEqual([['Extend', 'Change reference', 'Revoke'], ['Revoke'], []]);
    expect(rows[2]!.textContent).toContain('Ended Oct 10, 2026, revoked by AEC Integrations');
    expect(rows[2]!.textContent).toContain('No actions on an ended license');
  });
});

describe('toBillingLicenseRow', () => {
  it('formats a date-only end without shifting it a day', () => {
    const row = toBillingLicenseRow(makeLicense({ ends_at: '2027-09-01' }), 'en-US');
    expect(row.endsLabel).toBe('Sep 1, 2027');
  });

  it('reads a monthly license as having no scheduled end', () => {
    expect(toBillingLicenseRow(makeLicense({ ends_at: null }), 'en-US').endsLabel).toBeNull();
  });

  it('shows an unknown source token as is', () => {
    expect(toBillingLicenseRow(makeLicense({ source: 'barter' }), 'en-US').sourceLabel).toBe(
      'barter',
    );
  });
});
