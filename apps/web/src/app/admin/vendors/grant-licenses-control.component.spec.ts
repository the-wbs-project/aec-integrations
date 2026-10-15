/**
 * `GrantLicensesControl`: the admin "Grant licenses" control on `/admin/vendors/:id`
 * (AECI-1370, E4.1).
 *
 * Pinned here:
 *  1. the copy says a grant assigns nothing;
 *  2. the form sends one `grant_id` per open form, so a retry replays the same grant,
 *     and a reopened form mints a new one;
 *  3. an invoice grant needs a reference, and the end must be after the start;
 *  4. a pure connector vendor warns and never disables (AECI-738);
 *  5. no heading and no live region of its own; announcements go to the host.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GrantLicensesInput, GrantLicensesResponse } from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { GrantLicensesControl } from './grant-licenses-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

interface ApiMock {
  grantLicenses: ReturnType<typeof vi.fn>;
}

function response(input: GrantLicensesInput, over: Partial<GrantLicensesResponse> = {}) {
  return {
    vendor_id: VENDOR_ID,
    billing_account_id: 'acct-1',
    grant_id: input.grant_id,
    replayed: false,
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
  button(el, 'Grant licenses').click();
  await refresh();
  type(field(el, 'quantity') as HTMLInputElement, '3');
  type(field(el, 'end') as HTMLInputElement, end);
  await refresh();
}

describe('GrantLicensesControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('says a grant assigns nothing, and has no heading or live region of its own', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('A grant assigns nothing.');
    expect(el.textContent).toContain('the vendor chooses which products they go on');
    const control = el.querySelector('aec-grant-licenses-control')!;
    expect(control.querySelector('h1, h2, h3, h4, [role="status"]')).toBeNull();
  });

  it('grants a complimentary set with one grant id, and announces no assignment', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api);
    await openAndFill(el, refresh);
    expect(button(el, 'Grant the licenses').disabled).toBe(false);

    button(el, 'Grant the licenses').click();
    await refresh();
    expect(api.grantLicenses).toHaveBeenCalledTimes(1);
    const [vendorId, body] = api.grantLicenses.mock.calls[0]! as [string, GrantLicensesInput];
    expect(vendorId).toBe(VENDOR_ID);
    expect(body).toMatchObject({ quantity: 3, source: 'complimentary', ends_at: '2099-06-30' });
    expect(body.starts_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.grant_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('reference');
    expect(host.grants).toHaveLength(1);
    expect(host.announced()).toBe('3 licenses granted to Bentley. None is on a product yet.');
    // The form closed.
    expect(button(el, 'Grant licenses')).toBeTruthy();
  });

  it('keeps the grant id across retries of one form, and mints a new one on reopen', async () => {
    const api = makeApiMock();
    api.grantLicenses.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    const { el, refresh } = await setup(api);
    await openAndFill(el, refresh);
    button(el, 'Grant the licenses').click();
    await refresh();
    expect(el.textContent).toContain('Something went wrong.');
    button(el, 'Grant the licenses').click();
    await refresh();
    const first = (api.grantLicenses.mock.calls[0]![1] as GrantLicensesInput).grant_id;
    const retry = (api.grantLicenses.mock.calls[1]![1] as GrantLicensesInput).grant_id;
    expect(retry).toBe(first);

    await openAndFill(el, refresh);
    button(el, 'Grant the licenses').click();
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
    expect(button(el, 'Grant the licenses').disabled).toBe(true);
    expect(el.textContent).toContain('Invoice or PO reference');

    type(field(el, 'reference'), '  PO-77 ');
    await refresh();
    button(el, 'Grant the licenses').click();
    await refresh();
    expect(api.grantLicenses.mock.calls[0]![1]).toMatchObject({
      source: 'invoice',
      reference: 'PO-77',
    });
  });

  it('blocks an end date on or before the start, and describes why', async () => {
    const { el, refresh } = await setup(makeApiMock());
    button(el, 'Grant licenses').click();
    await refresh();
    type(field(el, 'start') as HTMLInputElement, '2027-01-02');
    type(field(el, 'end') as HTMLInputElement, '2027-01-02');
    await refresh();
    expect(button(el, 'Grant the licenses').disabled).toBe(true);
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
    expect(button(el, 'Grant the licenses').disabled).toBe(true);
    expect(field(el, 'quantity').getAttribute('aria-invalid')).toBe('true');
  });

  it('warns on a pure connector vendor and stays enabled', async () => {
    const api = makeApiMock({
      warnings: [{ code: 'pure_connector_vendor', message: 'server text' }],
    });
    const { el, refresh } = await setup(api, true);
    await openAndFill(el, refresh);
    expect(el.textContent).toContain('Every product this vendor owns is a connector.');
    expect(button(el, 'Grant the licenses').disabled).toBe(false);
    button(el, 'Grant the licenses').click();
    await refresh();
    expect(el.querySelector('[data-testid="grant-licenses-warning"]')?.textContent).toContain(
      'Granted to a vendor whose every product is a connector.',
    );
  });

  it('announces a replay as nothing changed', async () => {
    const { el, host, refresh } = await setup(makeApiMock({ replayed: true }));
    await openAndFill(el, refresh);
    button(el, 'Grant the licenses').click();
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
    button(el, 'Grant the licenses').click();
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
    button(el, 'Grant the licenses').click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('reopen the form');
  });
});
