/**
 * `BanTermLicensesControl`: "Grant complimentary licenses for the ban term" on the
 * Billing tab of `/admin/vendors/:id` (AECI-1589).
 *
 * Pinned here:
 *  1. it shows only when a license ended `banned` is on a product no live license holds,
 *     no license on that product was created after the ban (restored or replaced), AND
 *     the vendor has an unbanned seat; one row per such product;
 *  2. each date is prefilled from `ends_at`; a NULL `ends_at` is empty, required and
 *     explained; an untouched prefill sends the stored instant;
 *  3. one `grant_id` per open form, so a retry replays; a reopened form mints a new one;
 *  4. success emits `granted` and announces through the host; an error names its cause;
 *  5. a date is checked by the API's rule: the value sent, as an instant, after now, so a
 *     typed date is UTC midnight and must be after today in UTC.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminBillingLicense,
  BanTermLicensesInput,
  BanTermLicensesResponse,
} from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import {
  BanTermLicensesControl,
  banTermCandidates,
  banTermEndIsValid,
  banTermEndToSend,
} from './ban-term-licenses-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';
const P1 = 'prod-1';
const P2 = 'prod-2';
const P3 = 'prod-3';
const STRIPE_END = '2099-03-31T14:22:05.000Z';

function license(over: Partial<AdminBillingLicense>): AdminBillingLicense {
  return {
    id: 'lic',
    source: 'complimentary',
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: null,
    ended_at: null,
    end_reason: null,
    live: true,
    reference: null,
    assigned_product: null,
    assigned_at: null,
    release_at_renewal: false,
    cancel_at_term_end: false,
    cancel_reason: null,
    stripe_subscription_id: null,
    terms_version: null,
    granted_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const product = (id: string, name: string) => ({ id, slug: id, name });
const banned = (id: string, productId: string, name: string, endsAt: string | null) =>
  license({
    id,
    live: false,
    ended_at: '2026-11-01T00:00:00.000Z',
    end_reason: 'banned',
    ends_at: endsAt,
    assigned_product: product(productId, name),
  });

/** Three banned products: one with a Stripe period end, one unknown, one relicensed. */
const ROWS: AdminBillingLicense[] = [
  license({ id: 'live-3', assigned_product: product(P3, 'Gamma') }),
  banned('ban-1', P1, 'Alpha', STRIPE_END),
  banned('ban-2', P2, 'Beta', null),
  banned('ban-3', P3, 'Gamma', '2099-01-01T00:00:00.000Z'),
  license({
    id: 'rev-1',
    live: false,
    end_reason: 'revoked',
    ended_at: '2026-10-01T00:00:00.000Z',
    assigned_product: product('prod-4', 'Delta'),
  }),
];

function response(input: BanTermLicensesInput, replayed = false): BanTermLicensesResponse {
  return {
    vendor_id: VENDOR_ID,
    billing_account_id: 'acct-1',
    grant_id: input.grant_id,
    replayed,
    licenses: input.items.map((item, i) => ({
      id: `new-${i}`,
      source: 'complimentary',
      starts_at: '2026-11-03T00:00:00.000Z',
      ends_at: item.ends_at,
      reference: 'Complimentary for the ban term',
      assigned_product_id: item.product_id,
    })),
  };
}

interface ApiMock {
  grantBanTermLicenses: ReturnType<typeof vi.fn>;
}

function makeApiMock(replayed = false): ApiMock {
  return {
    grantBanTermLicenses: vi.fn(async (_v: string, input: BanTermLicensesInput) =>
      response(input, replayed),
    ),
  };
}

@Component({
  selector: 'aec-test-host',
  imports: [BanTermLicensesControl],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-ban-term-licenses-control
      [vendorId]="vendorId"
      vendorName="Bentley"
      [licenses]="rows()"
      [hasUnbannedSeat]="hasSeat()"
      idPrefix="host-1"
      (granted)="grants.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly rows = signal<readonly AdminBillingLicense[]>(ROWS);
  readonly hasSeat = signal<boolean | null>(true);
  readonly announced = signal('');
  readonly grants: BanTermLicensesResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(
  api: ApiMock,
  opts: { hasSeat?: boolean | null; rows?: AdminBillingLicense[] } = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminLicensesApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(TestHost);
  if (opts.hasSeat !== undefined) fixture.componentInstance.hasSeat.set(opts.hasSeat);
  if (opts.rows) fixture.componentInstance.rows.set(opts.rows);
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

const OPEN = 'Review the ban-term licenses';
const CONFIRM = 'Grant complimentary licenses for the ban term';

const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};
const dateFor = (el: HTMLElement, productId: string) =>
  el.querySelector<HTMLInputElement>(`#host-1-ban-term-end-${productId}`)!;
const includeFor = (el: HTMLElement, productId: string) =>
  el.querySelector<HTMLInputElement>(`#host-1-ban-term-include-${productId}`)!;

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('banTermCandidates', () => {
  it('lists each banned product no live license holds, once, and nothing else', () => {
    expect(banTermCandidates(ROWS)).toEqual([
      { productId: P1, productName: 'Alpha', endedLicenseId: 'ban-1', endsAt: STRIPE_END },
      { productId: P2, productName: 'Beta', endedLicenseId: 'ban-2', endsAt: null },
    ]);
  });

  // A `banned` row is permanent. Once the ban-term license it restored ends, the
  // product is unlicensed again, but the row is spent: the panel must not come back.
  it('drops a product whose restored license later lapsed, or was revoked', () => {
    for (const endReason of ['lapsed', 'revoked']) {
      const rows = [
        license({
          id: 'restored',
          live: false,
          created_at: '2026-11-03T00:00:00.000Z',
          ended_at: '2027-03-31T00:00:00.000Z',
          end_reason: endReason,
          assigned_product: product(P1, 'Alpha'),
        }),
        banned('ban-1', P1, 'Alpha', STRIPE_END),
        banned('ban-2', P2, 'Beta', null),
      ];
      expect(banTermCandidates(rows).map((c) => c.productId)).toEqual([P2]);
    }
  });

  it('keeps a product whose only other license predates the ban', () => {
    const rows = [
      banned('ban-1', P1, 'Alpha', STRIPE_END),
      license({
        id: 'old',
        live: false,
        created_at: '2025-01-01T00:00:00.000Z',
        ended_at: '2025-12-31T00:00:00.000Z',
        end_reason: 'lapsed',
        assigned_product: product(P1, 'Alpha'),
      }),
    ];
    expect(banTermCandidates(rows).map((c) => c.endedLicenseId)).toEqual(['ban-1']);
  });

  it('keeps the first (most recently ended) banned row per product', () => {
    const rows = [banned('newer', P1, 'Alpha', null), banned('older', P1, 'Alpha', STRIPE_END)];
    expect(banTermCandidates(rows).map((c) => c.endedLicenseId)).toEqual(['newer']);
  });
});

// The API compares `new Date(ends_at)` with its request time. A date-only value is UTC
// midnight, so the form's check is the same comparison, never the operator's local date.
describe('banTermEndIsValid (the API rule)', () => {
  // 21:00 on 2026-11-03 in UTC-5 is already 2026-11-04 in UTC.
  const LATE_EVENING_US = Date.parse('2026-11-04T02:00:00.000Z');

  it('a typed date must be after today in UTC', () => {
    expect(banTermEndIsValid('2026-11-04', LATE_EVENING_US)).toBe(false);
    expect(banTermEndIsValid('2026-11-05', LATE_EVENING_US)).toBe(true);
    expect(banTermEndIsValid('2026-11-03', Date.parse('2026-11-03T00:00:00.000Z'))).toBe(false);
  });

  it('a stored instant later today passes, as the API passes it', () => {
    expect(banTermEndIsValid('2026-11-04T12:00:00.000Z', LATE_EVENING_US)).toBe(true);
  });

  it('an empty or unreadable value fails', () => {
    expect(banTermEndIsValid('', 0)).toBe(false);
    expect(banTermEndIsValid('not-a-date', 0)).toBe(false);
  });

  it('sends the stored instant for an untouched prefill, else the typed date', () => {
    expect(banTermEndToSend('2027-03-31T12:00:00.000Z', '2027-03-31')).toBe(
      '2027-03-31T12:00:00.000Z',
    );
    expect(banTermEndToSend('2027-03-31T12:00:00.000Z', '2027-04-01')).toBe('2027-04-01');
    expect(banTermEndToSend(null, '2027-04-01')).toBe('2027-04-01');
  });
});

describe('BanTermLicensesControl', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing while every seat is banned, or the roster is unknown', async () => {
    for (const hasSeat of [false, null]) {
      const { el } = await setup(makeApiMock(), { hasSeat });
      expect(el.querySelector('[data-testid="ban-term-licenses"]')).toBeNull();
    }
  });

  it('does not come back once the restored licenses have lapsed', async () => {
    const lapsed = (id: string, productId: string, name: string) =>
      license({
        id,
        live: false,
        created_at: '2026-11-03T00:00:00.000Z',
        ended_at: '2027-03-31T00:00:00.000Z',
        end_reason: 'lapsed',
        assigned_product: product(productId, name),
      });
    const { el } = await setup(makeApiMock(), {
      rows: [
        lapsed('r-1', P1, 'Alpha'),
        lapsed('r-2', P2, 'Beta'),
        banned('ban-1', P1, 'Alpha', STRIPE_END),
        banned('ban-2', P2, 'Beta', null),
      ],
    });
    expect(el.querySelector('[data-testid="ban-term-licenses"]')).toBeNull();
  });

  it('renders nothing when no banned product is left unlicensed', async () => {
    const { el } = await setup(makeApiMock(), { rows: [ROWS[0]!, ROWS[3]!, ROWS[4]!] });
    expect(el.querySelector('[data-testid="ban-term-licenses"]')).toBeNull();
  });

  it('offers one row per product, prefilled, with the unknown-term hint on a NULL end', async () => {
    const { el, refresh } = await setup(makeApiMock());
    expect(el.querySelector('[data-testid="ban-term-licenses"]')).not.toBeNull();
    button(el, OPEN).click();
    await refresh();

    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.textContent).toContain('Include Alpha');
    expect(el.textContent).toContain('Include Beta');
    expect(el.textContent).not.toContain('Gamma');
    expect(dateFor(el, P1).value).toBe('2099-03-31');
    expect(dateFor(el, P2).value).toBe('');
    expect(dateFor(el, P2).getAttribute('aria-required')).toBe('true');
    const hint = el.querySelector(`#host-1-ban-term-end-hint-${P2}`);
    expect(hint?.textContent?.trim()).toBe(
      'Term end unknown: enter the date the vendor had paid through',
    );
    expect(dateFor(el, P2).getAttribute('aria-describedby')).toBe(`host-1-ban-term-end-hint-${P2}`);
    expect(dateFor(el, P1).getAttribute('aria-describedby')).toBeNull();
    // The unknown date blocks the grant until it is typed.
    expect(button(el, CONFIRM).disabled).toBe(true);
  });

  it('grants the included rows: an untouched prefill sends the stored instant', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api);
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2099-05-15');
    await refresh();
    button(el, CONFIRM).click();
    await refresh();

    expect(api.grantBanTermLicenses).toHaveBeenCalledWith(VENDOR_ID, {
      grant_id: '11111111-1111-4111-8111-111111111111',
      items: [
        { ended_license_id: 'ban-1', product_id: P1, ends_at: STRIPE_END },
        { ended_license_id: 'ban-2', product_id: P2, ends_at: '2099-05-15' },
      ],
    });
    expect(host.grants).toHaveLength(1);
    expect(host.announced()).toBe(
      '2 complimentary licenses granted to Bentley for the ban term. Their products are on Managed again.',
    );
    // The form closed; the host reloads Billing.
    expect(() => button(el, CONFIRM)).toThrow();
  });

  it('an excluded row is not sent and does not need a date', async () => {
    const api = makeApiMock();
    const { el, host, refresh } = await setup(api);
    button(el, OPEN).click();
    await refresh();
    includeFor(el, P2).click();
    await refresh();
    expect(dateFor(el, P2).disabled).toBe(true);
    button(el, CONFIRM).click();
    await refresh();
    const input = api.grantBanTermLicenses.mock.calls[0]![1] as BanTermLicensesInput;
    expect(input.items.map((i) => i.product_id)).toEqual([P1]);
    expect(host.announced()).toBe(
      '1 complimentary license granted to Bentley for the ban term. Its product is on Managed again.',
    );
  });

  it('a typed past date shows an error and blocks the grant', async () => {
    const { el, refresh } = await setup(makeApiMock());
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2020-01-01');
    await refresh();
    expect(dateFor(el, P2).getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Enter a date after today (UTC).');
    expect(dateFor(el, P2).getAttribute('aria-describedby')).toBe(
      `host-1-ban-term-end-hint-${P2} host-1-ban-term-end-error-${P2}`,
    );
    expect(button(el, CONFIRM).disabled).toBe(true);
  });

  it('a date that is tomorrow locally but today in UTC is refused, as the API refuses it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T02:00:00.000Z'));
    const { el, refresh } = await setup(makeApiMock());
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2026-11-04');
    await refresh();
    expect(dateFor(el, P2).getAttribute('aria-invalid')).toBe('true');
    expect(button(el, CONFIRM).disabled).toBe(true);
    type(dateFor(el, P2), '2026-11-05');
    await refresh();
    expect(dateFor(el, P2).getAttribute('aria-invalid')).toBeNull();
  });

  it('a retry from the same form reuses the grant id; a reopened form mints a new one', async () => {
    const api = makeApiMock();
    api.grantBanTermLicenses.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { el, refresh } = await setup(api);
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2099-05-15');
    await refresh();
    button(el, CONFIRM).click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
    button(el, CONFIRM).click();
    await refresh();
    const ids = api.grantBanTermLicenses.mock.calls.map(
      (c) => (c[1] as BanTermLicensesInput).grant_id,
    );
    expect(ids).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('announces a replay as nothing changed', async () => {
    const { el, host, refresh } = await setup(makeApiMock(true));
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2099-05-15');
    await refresh();
    button(el, CONFIRM).click();
    await refresh();
    expect(host.announced()).toBe('This grant was already recorded for Bentley. Nothing changed.');
  });

  it.each([
    [409, 'VENDOR_STILL_BANNED', 'Every owner seat on this vendor is still banned'],
    [409, 'LICENSE_PRODUCT_ALREADY_LICENSED', 'A product already holds a live license'],
    [409, 'LICENSE_GRANT_CONFLICT', 'This grant clashes with one already recorded'],
    [404, 'NOT_FOUND', 'A product is no longer this vendor'],
    [429, 'RATE_LIMITED', 'Too many changes at once'],
  ])('names the cause of a %s %s', async (status, code, text) => {
    const api = makeApiMock();
    api.grantBanTermLicenses.mockRejectedValueOnce(
      new HttpErrorResponse({ status, error: { error: { code } } }),
    );
    const { el, host, refresh } = await setup(api);
    button(el, OPEN).click();
    await refresh();
    type(dateFor(el, P2), '2099-05-15');
    await refresh();
    button(el, CONFIRM).click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(host.grants).toHaveLength(0);
  });
});
