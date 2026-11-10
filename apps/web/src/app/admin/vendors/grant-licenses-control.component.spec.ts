/**
 * `GrantLicensesControl`: the admin "Grant licenses" control on `/admin/vendors/:id`
 * (AECI-1370, E4.1).
 *
 * Pinned here:
 *  1. the copy says a grant starts nothing until an owner accepts (AECI-1615);
 *  2. the form sends one `grant_id` per open form, so a retry replays the same grant,
 *     and a reopened form mints a new one;
 *  3. an invoice grant needs a reference, and the end must be after the start;
 *  4. a pure connector vendor warns and never disables (AECI-738);
 *  5. no heading and no live region of its own; announcements go to the host;
 *  6. AECI-1615: the "Recorded signed deal" section is collapsed by default, every field
 *     is required once it is open, and the success line follows the response status.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  type GrantLicensesInput,
  type GrantLicensesResponse,
} from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { GrantLicensesControl } from './grant-licenses-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

interface ApiMock {
  grantLicenses: ReturnType<typeof vi.fn>;
}

/** The pending grant a test response carries (AECI-1615). */
function grantFixture(id: string, kind: 'grant' | 'ban_term', quantity: number) {
  return {
    id,
    kind,
    status: 'pending_acceptance' as const,
    source: 'complimentary',
    quantity,
    starts_at: null,
    ends_at: '2027-06-30T00:00:00.000Z',
    reference: null,
    notes: null,
    terms_version: '1.1',
    items: [],
    granted_by: 'admin-1',
    acceptance_id: null,
    acceptance_method: null,
    decided_at: null,
    decided_by: null,
    withdraw_reason: null,
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
  };
}

function response(input: GrantLicensesInput, over: Partial<GrantLicensesResponse> = {}) {
  return {
    vendor_id: VENDOR_ID,
    billing_account_id: 'acct-1',
    grant_id: input.grant_id,
    replayed: false,
    // AECI-1615: the API answers with a pending grant; the licenses here keep the
    // control's existing success copy under test until P11 reworks it.
    status: 'pending_acceptance',
    grant: grantFixture(input.grant_id, 'grant', input.quantity),
    licenses: Array.from({ length: input.quantity }, (_, i) => ({
      id: `lic-${i}`,
      source: input.source,
      starts_at: `${input.starts_at}T00:00:00.000Z`,
      ends_at: `${input.ends_at}T00:00:00.000Z`,
      reference: input.reference ?? null,
      assigned_product_id: null,
    })),
    warnings: [],
    ...over,
  } satisfies GrantLicensesResponse;
}

function makeApiMock(over: Partial<GrantLicensesResponse> = {}): ApiMock {
  return {
    grantLicenses: vi.fn(async (_vendorId: string, input: GrantLicensesInput) =>
      response(input, over),
    ),
  };
}

@Component({
  selector: 'aec-test-host',
  imports: [GrantLicensesControl],
  template: `
    <h3 id="host-heading">Licenses</h3>
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-grant-licenses-control
      [vendorId]="vendorId"
      vendorName="Bentley"
      [isPureConnectorVendor]="pureConnector()"
      idPrefix="host-1"
      labelledBy="host-heading"
      (granted)="grants.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly pureConnector = signal(false);
  readonly announced = signal('');
  readonly grants: GrantLicensesResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(api: ApiMock, pureConnector = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminLicensesApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.pureConnector.set(pureConnector);
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

const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};
const field = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#host-1-licenses-${name}`)!;
const radio = (el: HTMLElement, value: string) =>
  el.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function openAndFill(el: HTMLElement, refresh: () => Promise<void>, end = '2099-06-30') {
  button(el, 'Grant subscriptions').click();
  await refresh();
  type(field(el, 'quantity') as HTMLInputElement, '3');
  type(field(el, 'end') as HTMLInputElement, end);
  await refresh();
}

describe('GrantLicensesControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('says a grant starts nothing until accepted, and has no heading or live region of its own', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('A grant starts nothing on its own.');
    expect(el.textContent).toContain('until an owner seat accepts the Managed plan agreement');
    expect(el.textContent).toContain('the vendor chooses which products they go on');
    const control = el.querySelector('aec-grant-licenses-control')!;
    expect(control.querySelector('h1, h2, h3, h4, [role="status"]')).toBeNull();
  });

  it('grants a complimentary set with one grant id, and announces no assignment', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api);
    await openAndFill(el, refresh);
    expect(button(el, 'Grant the subscriptions').disabled).toBe(false);

    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(api.grantLicenses).toHaveBeenCalledTimes(1);
    const [vendorId, body] = api.grantLicenses.mock.calls[0]! as [string, GrantLicensesInput];
    expect(vendorId).toBe(VENDOR_ID);
    expect(body).toMatchObject({ quantity: 3, source: 'complimentary', ends_at: '2099-06-30' });
    expect(body.starts_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.grant_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('reference');
    expect(host.grants).toHaveLength(1);
    expect(host.announced()).toBe(
      '3 subscriptions granted to Bentley. Waiting for an owner to accept in the portal.',
    );
    // AECI-1615: the control says the grant waits, from the response status.
    expect(el.querySelector('[data-testid="grant-licenses-status"]')?.textContent?.trim()).toBe(
      'Waiting for an owner to accept in the portal.',
    );
    // No signed deal was opened, so none was sent.
    expect(body).not.toHaveProperty('signed_deal');
    // The form closed.
    expect(button(el, 'Grant subscriptions')).toBeTruthy();
  });

  it('keeps the grant id across retries of one form, and mints a new one on reopen', async () => {
    const api = makeApiMock();
    api.grantLicenses.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(el.textContent).toContain('Something went wrong.');
    button(el, 'Grant the subscriptions').click();
    await refresh();
    const first = (api.grantLicenses.mock.calls[0]![1] as GrantLicensesInput).grant_id;
    const retry = (api.grantLicenses.mock.calls[1]![1] as GrantLicensesInput).grant_id;
    expect(retry).toBe(first);

    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    const reopened = (api.grantLicenses.mock.calls[2]![1] as GrantLicensesInput).grant_id;
    expect(reopened).not.toBe(first);
  });

  it('needs a reference for an invoice grant, and sends it trimmed', async () => {
    const api = makeApiMock();
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    radio(el, 'invoice').click();
    await refresh();
    expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
    expect(el.textContent).toContain('Invoice or PO reference');

    type(field(el, 'reference'), '  PO-77 ');
    await refresh();
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(api.grantLicenses.mock.calls[0]![1]).toMatchObject({
      source: 'invoice',
      reference: 'PO-77',
    });
  });

  it('blocks an end date on or before the start, and describes why', async () => {
    const { el, refresh } = await setup(makeApiMock());
    button(el, 'Grant subscriptions').click();
    await refresh();
    type(field(el, 'start') as HTMLInputElement, '2027-01-02');
    type(field(el, 'end') as HTMLInputElement, '2027-01-02');
    await refresh();
    expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
    const end = field(el, 'end');
    expect(end.getAttribute('aria-invalid')).toBe('true');
    const errorId = end.getAttribute('aria-describedby')!;
    expect(el.querySelector(`#${errorId}`)?.textContent).toContain(
      'The end date must be after the start date.',
    );
  });

  it('blocks a quantity outside 1 to 50', async () => {
    const { el, refresh } = await setup(makeApiMock());
    await openAndFill(el, refresh);
    type(field(el, 'quantity') as HTMLInputElement, '51');
    await refresh();
    expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
    expect(field(el, 'quantity').getAttribute('aria-invalid')).toBe('true');
  });

  it('warns on a pure connector vendor and stays enabled', async () => {
    const api = makeApiMock({
      warnings: [{ code: 'pure_connector_vendor', message: 'server text' }],
    });
    const { el, refresh } = await setup(api, true);
    await openAndFill(el, refresh);
    expect(el.textContent).toContain('Every product this vendor owns is a connector.');
    expect(button(el, 'Grant the subscriptions').disabled).toBe(false);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(el.querySelector('[data-testid="grant-licenses-warning"]')?.textContent).toContain(
      'Granted to a vendor whose every product is a connector.',
    );
  });

  it('announces a replay as nothing changed', async () => {
    const { el, host, refresh } = await setup(makeApiMock({ replayed: true }));
    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(host.announced()).toBe('This grant was already recorded for Bentley. Nothing changed.');
  });

  it('names the missing billing account on a 404', async () => {
    const api = makeApiMock();
    api.grantLicenses.mockRejectedValue(
      new HttpErrorResponse({
        status: 404,
        error: { error: { code: 'NOT_FOUND', details: { resource: 'billing_account' } } },
      }),
    );
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This vendor has no billing account yet.',
    );
  });

  it('tells the operator to reopen on a 409', async () => {
    const api = makeApiMock();
    api.grantLicenses.mockRejectedValue(new HttpErrorResponse({ status: 409 }));
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('reopen the form');
  });

  it.each([
    ['VENDOR_STILL_BANNED', 'Every owner seat on this vendor is banned. Unban a seat first'],
    ['VENDOR_SEATS_CHANGED', "This vendor's seats changed while the grant ran"],
    ['LICENSE_GRANT_CONFLICT', 'reopen the form'],
  ])('names the cause of a 409 %s', async (code, text) => {
    const api = makeApiMock();
    api.grantLicenses.mockRejectedValue(
      new HttpErrorResponse({ status: 409, error: { error: { code } } }),
    );
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    button(el, 'Grant the subscriptions').click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(text);
  });

  describe('the recorded signed deal (AECI-1615)', () => {
    const deal = (el: HTMLElement, name: string) =>
      el.querySelector<HTMLInputElement>(`#host-1-deal-${name}`)!;

    async function fillDeal(el: HTMLElement, refresh: () => Promise<void>, skip?: string) {
      const values: Record<string, string> = {
        name: 'Ada Lane',
        role: 'Chief Executive Officer',
        company: 'Bentley Systems, Incorporated',
        email: 'ada@bentley.example.com',
        reference: 'DocuSign 4F2A',
        'version-date': '2026-11-07',
        'signed-at': '2026-11-08',
      };
      for (const [key, value] of Object.entries(values)) {
        if (key !== skip) type(deal(el, key), value);
      }
      if (skip !== 'accepts') {
        const box = el.querySelector<HTMLInputElement>('[data-testid="grant-deal-accepts"]')!;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
      }
      await refresh();
    }

    it('is collapsed by default and pre-fills the current version when opened', async () => {
      const { el, refresh } = await setup(makeApiMock());
      await openAndFill(el, refresh);
      const toggle = el.querySelector<HTMLButtonElement>('[data-testid="grant-deal-toggle"]')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelector('[data-testid="grant-deal"]')).toBeNull();

      toggle.click();
      await refresh();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(el.querySelector('[data-testid="grant-deal"]')).not.toBeNull();
      expect(deal(el, 'version').value).toBe(LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan);
    });

    it('requires every field once open', async () => {
      const { el, refresh } = await setup(makeApiMock());
      await openAndFill(el, refresh);
      expect(button(el, 'Grant the subscriptions').disabled).toBe(false);
      el.querySelector<HTMLButtonElement>('[data-testid="grant-deal-toggle"]')!.click();
      await refresh();
      // Opened and empty: the grant cannot be sent.
      expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
      for (const input of el.querySelectorAll('[data-testid="grant-deal"] input')) {
        expect((input as HTMLInputElement).required).toBe(true);
      }

      for (const skip of [
        'name',
        'role',
        'company',
        'email',
        'reference',
        'version-date',
        'signed-at',
        'accepts',
      ]) {
        const { el: e, refresh: r } = await setup(makeApiMock());
        await openAndFill(e, r);
        e.querySelector<HTMLButtonElement>('[data-testid="grant-deal-toggle"]')!.click();
        await r();
        await fillDeal(e, r, skip);
        expect(button(e, 'Grant the subscriptions').disabled, `missing ${skip}`).toBe(true);
      }
    });

    it('refuses a version other than the current one, and a signing date in the future', async () => {
      const { el, refresh } = await setup(makeApiMock());
      await openAndFill(el, refresh);
      el.querySelector<HTMLButtonElement>('[data-testid="grant-deal-toggle"]')!.click();
      await refresh();
      await fillDeal(el, refresh);
      expect(button(el, 'Grant the subscriptions').disabled).toBe(false);

      type(deal(el, 'version'), '0.9');
      await refresh();
      expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
      expect(deal(el, 'version').getAttribute('aria-invalid')).toBe('true');

      type(deal(el, 'version'), LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan);
      type(deal(el, 'signed-at'), '2999-01-01');
      await refresh();
      expect(button(el, 'Grant the subscriptions').disabled).toBe(true);
      expect(el.textContent).toContain('The signing date cannot be in the future.');
    });

    it('sends the deal and says the grant is active when the API accepts it', async () => {
      const api = makeApiMock({ status: 'accepted' });
      const { el, host, refresh } = await setup(api);
      await openAndFill(el, refresh);
      el.querySelector<HTMLButtonElement>('[data-testid="grant-deal-toggle"]')!.click();
      await refresh();
      await fillDeal(el, refresh);
      button(el, 'Grant the subscriptions').click();
      await refresh();

      const body = api.grantLicenses.mock.calls[0]![1] as GrantLicensesInput;
      expect(body.signed_deal).toEqual({
        signer_name: 'Ada Lane',
        signer_role: 'Chief Executive Officer',
        company_legal_name: 'Bentley Systems, Incorporated',
        signer_email: 'ada@bentley.example.com',
        deal_reference: 'DocuSign 4F2A',
        version_named: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
        version_date_named: '2026-11-07',
        signing_accepts: true,
        signed_at: '2026-11-08',
      });
      expect(el.querySelector('[data-testid="grant-licenses-status"]')?.textContent?.trim()).toBe(
        'Active: recorded signed deal.',
      );
      expect(host.announced()).toBe(
        '3 subscriptions granted to Bentley. Active: recorded signed deal. None is on a product yet.',
      );
    });
  });
});
