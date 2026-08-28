/**
 * `EntitlementControl` — the set / renew / clear form (AECI-532 §5, extracted by
 * AECI-652 §5.6).
 *
 * Most of this moved verbatim from `claim-queue.component.spec.ts`, because the
 * behaviour did not change — only its home did. What is NEW, and what the
 * extraction could plausibly have got wrong, is the last describe: the control
 * must render neither a heading nor a live region, because `/admin/claims`
 * mounts one per row and either would multiply.
 *
 * The copy assertions are the reason this component exists at all. §5.2 (a clear
 * is not a seat revoke and not a ban), §5.3 (search lags a day, in both
 * directions) and §5.4 (the lockout and its escape hatch) are sentences whose
 * absence causes an incident, not a typo — so they are asserted here rather than
 * left to a reviewer to notice.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorEntitlementResponse } from '@aeci/shared';

import { AdminEntitlementApi } from './admin-entitlement-api';
import { EntitlementControl } from './entitlement-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';
const VENDOR = { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' };

function activeEntitlement(
  over: Partial<VendorEntitlementResponse> = {},
): VendorEntitlementResponse {
  return {
    vendor_id: VENDOR_ID,
    tier: 'verified',
    status: 'active',
    period_start: '2026-09-01',
    period_end: '2027-09-01',
    granted_at: '2026-09-01T00:00:00.000Z',
    ended_at: null,
    verified: true,
    payer: 'Autodesk, Inc.',
    amount: 'USD 5,000 / yr',
    terms: null,
    arranged_by: 'chris@aecintegrations.com',
    invoice_ref: 'PO-4471',
    notes: null,
    ...over,
  };
}

interface ApiMock {
  setEntitlement: ReturnType<typeof vi.fn>;
}

function makeApiMock(): ApiMock {
  return {
    setEntitlement: vi.fn(
      async (vendorId: string, input: { action: string; period_end?: string }) =>
        activeEntitlement({
          vendor_id: vendorId,
          status: input.action === 'clear' ? 'revoked' : 'active',
          verified: input.action !== 'clear',
          period_end: input.period_end ?? '2027-09-01',
        }),
    ),
  };
}

/** A host, because the component's contract includes what it hands BACK: the
 *  committed readout and the announcement text both leave through outputs. */
@Component({
  selector: 'aec-test-host',
  imports: [EntitlementControl],
  template: `
    <h3 id="host-heading">Entitlement</h3>
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-entitlement-control
      [vendor]="vendor"
      [entitlement]="entitlement()"
      idPrefix="host-1"
      labelledBy="host-heading"
      (changed)="onChanged($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendor = VENDOR;
  readonly entitlement = signal<VendorEntitlementResponse | null>(null);
  readonly announced = signal('');
  readonly changes: VendorEntitlementResponse[] = [];

  onChanged(e: VendorEntitlementResponse): void {
    this.changes.push(e);
    this.entitlement.set(e);
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock, entitlement: VendorEntitlementResponse | null = null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminEntitlementApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.entitlement.set(entitlement);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return {
    fixture,
    api,
    host: fixture.componentInstance,
    el: fixture.nativeElement as HTMLElement,
  };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function control(el: HTMLElement): HTMLElement {
  return el.querySelector('aec-entitlement-control') as HTMLElement;
}

describe('EntitlementControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('offers Grant when the vendor has no active entitlement', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('No entitlement on record');
    expect(buttonByText(el, 'Grant entitlement')).toBeTruthy();
    expect(() => buttonByText(el, 'Clear entitlement')).toThrow();
  });

  it('offers Renew + Clear when it is active, and shows the term and paperwork', async () => {
    const { el } = await setup(makeApiMock(), activeEntitlement());
    expect(el.textContent).toContain('Verified: entitlement active');
    expect(el.textContent).toContain('2027-09-01');
    expect(el.textContent).toContain('PO-4471');
    expect(buttonByText(el, 'Renew term')).toBeTruthy();
    expect(buttonByText(el, 'Clear entitlement')).toBeTruthy();
    expect(() => buttonByText(el, 'Grant entitlement')).toThrow();
  });

  it('reads a null period_end as PERPETUAL, never as a blank', async () => {
    // §2.4 backfilled rows carry no end date, and rendering that as an empty
    // string would read as "we do not know", which is a different answer.
    const { el } = await setup(makeApiMock(), activeEntitlement({ period_end: null }));
    expect(el.textContent).toContain('No end date on record');
  });

  it('sends set with the term + paperwork, and never names `verified`', async () => {
    const { el, fixture, api } = await setup(makeApiMock());

    buttonByText(el, 'Grant entitlement').click();
    fixture.detectChanges();
    const date = el.querySelector('input[type="date"]') as HTMLInputElement;
    date.value = '2027-09-01';
    date.dispatchEvent(new Event('input'));
    const invoice = el.querySelector('input[type="text"]') as HTMLInputElement;
    invoice.value = 'PO-99';
    invoice.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    buttonByText(el, 'Confirm grant').click();
    await settle();
    fixture.detectChanges();

    expect(api.setEntitlement).toHaveBeenCalledWith(VENDOR_ID, {
      action: 'set',
      period_end: '2027-09-01',
      invoice_ref: 'PO-99',
    });
    // `vendors.verified` is a server-side mirror; a payload that named it would
    // be a second direct writer (§2.1).
    expect(Object.keys(api.setEntitlement.mock.calls[0]![1])).not.toContain('verified');
  });

  it('pre-fills the renew form from the current term rather than blanking it', async () => {
    // The API patches rather than replaces, so a blank field would silently wipe
    // the paperwork of an admin who only meant to extend the date.
    const { el, fixture } = await setup(makeApiMock(), activeEntitlement());

    buttonByText(el, 'Renew term').click();
    fixture.detectChanges();
    expect((el.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2027-09-01');
    expect((el.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('PO-4471');
  });

  it('carries the §5.2 and §5.4 copy on the clear form', async () => {
    const { el, fixture } = await setup(makeApiMock(), activeEntitlement());

    buttonByText(el, 'Clear entitlement').click();
    fixture.detectChanges();

    // Clearing is not a seat revoke and not a ban.
    expect(el.textContent).toContain('does not remove');
    expect(el.textContent).toContain('read-only');
    // The §5.4 lockout, with its escape hatch named on screen.
    expect(el.textContent).toContain('grant the entitlement again, edit, then clear it');
  });

  it('never promises instant search on the grant form', async () => {
    // The Algolia sync is nightly in BOTH directions (§5.3 / R2).
    const { el, fixture } = await setup(makeApiMock());
    buttonByText(el, 'Grant entitlement').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('within a day');
    expect(el.textContent).not.toContain('immediately');
  });

  it('clears, emits the committed readout, and announces that portal access continues', async () => {
    const { el, fixture, api, host } = await setup(makeApiMock(), activeEntitlement());

    buttonByText(el, 'Clear entitlement').click();
    fixture.detectChanges();
    buttonByText(el, 'Confirm clear').click();
    await settle();
    fixture.detectChanges();

    expect(api.setEntitlement).toHaveBeenCalledWith(VENDOR_ID, { action: 'clear' });
    // The host gets the readout back so it can update with no refetch.
    expect(host.changes).toHaveLength(1);
    expect(host.changes[0].status).toBe('revoked');
    expect(host.announced()).toContain('read-only');
    expect(host.announced()).toContain('within a day');
    expect(el.textContent).toContain('Entitlement cleared');
  });

  it('sends the clear reason as `reason`, not as `notes`', async () => {
    // On a clear it is an INTERNAL audit reason, never emailed; on set/renew the
    // same box is the arrangement note. Same control, different field.
    const { el, fixture, api } = await setup(makeApiMock(), activeEntitlement());

    buttonByText(el, 'Clear entitlement').click();
    fixture.detectChanges();
    const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Non-payment, 60 days';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    buttonByText(el, 'Confirm clear').click();
    await settle();
    fixture.detectChanges();

    expect(api.setEntitlement).toHaveBeenCalledWith(VENDOR_ID, {
      action: 'clear',
      reason: 'Non-payment, 60 days',
    });
  });

  describe('error handling', () => {
    it('surfaces a 422 as "already in the state you asked for" and keeps the form', async () => {
      const api = makeApiMock();
      api.setEntitlement.mockRejectedValueOnce(
        new HttpErrorResponse({ status: 422, statusText: 'Unprocessable' }),
      );
      const { el, fixture } = await setup(api);

      buttonByText(el, 'Grant entitlement').click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm grant').click();
      await settle();
      fixture.detectChanges();

      expect(el.textContent).toContain('already in the state you asked for');
      expect(el.querySelector('[role="alert"]')).toBeTruthy();
      // Nothing is dropped — an entitlement row is not a queue item.
      expect(buttonByText(el, 'Confirm grant')).toBeTruthy();
    });

    it('surfaces a 403 by naming the right action (clear, not downgrade)', async () => {
      const api = makeApiMock();
      api.setEntitlement.mockRejectedValueOnce(
        new HttpErrorResponse({ status: 403, statusText: 'Forbidden' }),
      );
      const { el, fixture } = await setup(api);

      buttonByText(el, 'Grant entitlement').click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm grant').click();
      await settle();
      fixture.detectChanges();

      expect(el.textContent).toContain('clear it rather than downgrading the tier');
    });

    it('falls back to a generic message on an unrecognised failure', async () => {
      const api = makeApiMock();
      api.setEntitlement.mockRejectedValueOnce(new Error('boom'));
      const { el, fixture } = await setup(api);

      buttonByText(el, 'Grant entitlement').click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm grant').click();
      await settle();
      fixture.detectChanges();

      expect(el.textContent).toContain('Something went wrong');
    });

    it('emits nothing to the host when the call fails', async () => {
      const api = makeApiMock();
      api.setEntitlement.mockRejectedValueOnce(new Error('boom'));
      const { el, fixture, host } = await setup(api);

      buttonByText(el, 'Grant entitlement').click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm grant').click();
      await settle();
      fixture.detectChanges();

      expect(host.changes).toHaveLength(0);
      expect(host.announced()).toBe('');
    });
  });

  describe('host-owned chrome (the extraction contract)', () => {
    it('renders NO live region of its own', async () => {
      // `/admin/claims` mounts one of these per row. A control that owned its own
      // `role="status"` would give that page N live regions — and a
      // `querySelector` assertion would keep passing on the first one, so the
      // regression would be invisible. Announcements go out through `announce`.
      const { el } = await setup(makeApiMock(), activeEntitlement());
      expect(control(el).querySelector('[role="status"]')).toBeNull();
    });

    it('renders NO heading of its own', async () => {
      // The block used to hard-code an `<h4>`, correct inside a claim card and
      // wrong on `/admin/vendors/:id`, where the section heading is an `<h3>`. The
      // host owns the level and points `labelledBy` at it.
      const { el } = await setup(makeApiMock(), activeEntitlement());
      expect(control(el).querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    });

    it('wires aria-labelledby to the host heading', async () => {
      const { el } = await setup(makeApiMock(), activeEntitlement());
      expect(control(el).querySelector('[aria-labelledby="host-heading"]')).toBeTruthy();
    });

    it('scopes every form control id by idPrefix so two instances cannot collide', async () => {
      const { el, fixture } = await setup(makeApiMock());
      buttonByText(el, 'Grant entitlement').click();
      fixture.detectChanges();

      const date = el.querySelector('input[type="date"]') as HTMLInputElement;
      expect(date.id).toBe('ent-end-host-1');
      const label = el.querySelector('label[for="ent-end-host-1"]');
      expect(label).toBeTruthy();
    });
  });
});
