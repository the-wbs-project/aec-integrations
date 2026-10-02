/**
 * `EmailActivity` (`/admin/email`) — AECI-1223. Source of truth: `ADMIN_PANEL_SPEC.md` §5.14.
 *
 * What these tests hold in place:
 *
 *  1. **The address goes to the search call, and nowhere else.** Never to the plain list,
 *     never into the page. The ledger is hash-only (ADR 0038, §13 D23).
 *  2. **The sign-in panel exists only when the API sends it** (production). A zero panel on
 *     another tier would state something false.
 *  3. **Empty and "no matches" are different sentences.**
 *  4. **Summary and list fail separately**, and only an auth failure blames the session.
 *  5. **Rows link out correctly**: the related entity to its admin page, the message to
 *     Resend in a new tab.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminEmailSearchResponse,
  AdminEmailSendRow,
  AdminEmailSendsResponse,
  AdminEmailSummaryResponse,
  AdminEmailWindowCounts,
} from '@aeci/shared';

import { AdminEmailApi } from './admin-email-api';
import { EmailActivity } from './email-activity';

const counts = (
  over: Partial<AdminEmailWindowCounts['outcomes']> = {},
): AdminEmailWindowCounts => ({
  outcomes: { sent: 3, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0, ...over },
  delivery: { delivered: 2, bounced: 1, complained: 0, delivery_delayed: 0 },
});

function makeSummary(over: Partial<AdminEmailSummaryResponse> = {}): AdminEmailSummaryResponse {
  return {
    generated_at: '2026-10-02T12:00:00.000Z',
    environment: 'staging',
    templates: [
      {
        id: 'claim-approved',
        summary: 'Tells a claimant the claim is approved.',
        audience: 'external',
      },
    ],
    rows: [
      {
        notification_id: 'claim-approved',
        summary: 'Tells a claimant the claim is approved.',
        audience: 'external',
        registered: true,
        d7: counts(),
        d30: counts({ sent: 9 }),
      },
    ],
    sign_in: null,
    ...over,
  };
}

function makeRow(over: Partial<AdminEmailSendRow> = {}): AdminEmailSendRow {
  return {
    id: 7,
    notification_id: 'claim-approved',
    summary: 'Tells a claimant the claim is approved.',
    outcome: 'sent',
    created_at: '2026-10-01T09:30:00.000Z',
    provider_message_id: 're_abc',
    recipient_hash_prefix: '1a2b3c4d',
    entity: { type: 'vendor_request', id: 'req-1', admin_path: '/admin/claims/req-1' },
    latest_delivery: {
      event_type: 'bounced',
      occurred_at: '2026-10-01T09:30:05.000Z',
      bounce_type: 'Permanent',
      bounce_subtype: 'General',
    },
    ...over,
  };
}

function makeList(over: Partial<AdminEmailSendsResponse> = {}): AdminEmailSendsResponse {
  return {
    data: [makeRow()],
    page: 1,
    perPage: 25,
    total: 1,
    generated_at: '2026-10-02T12:00:00.000Z',
    ...over,
  };
}

interface ApiMock {
  summary: ReturnType<typeof vi.fn>;
  listSends: ReturnType<typeof vi.fn>;
  searchSends: ReturnType<typeof vi.fn>;
}

function makeApi(
  opts: {
    summary?: AdminEmailSummaryResponse | HttpErrorResponse;
    list?: AdminEmailSendsResponse | HttpErrorResponse;
    search?: AdminEmailSearchResponse;
  } = {},
): ApiMock {
  const answer = <T>(v: T | HttpErrorResponse | undefined, fallback: T) =>
    vi.fn(async () => {
      if (v instanceof Error || v instanceof HttpErrorResponse) throw v;
      return structuredClone(v ?? fallback);
    });
  return {
    summary: answer(opts.summary, makeSummary()),
    listSends: answer(opts.list, makeList()),
    searchSends: answer(opts.search, { ...makeList(), unmatched_events: [] }),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApi()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminEmailApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(EmailActivity);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rerender = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, api, el, rerender };
}

async function search(el: HTMLElement, rerender: () => Promise<void>, address: string) {
  const input = el.querySelector<HTMLInputElement>('#admin-email-address')!;
  input.value = address;
  input.dispatchEvent(new Event('input'));
  el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
  await rerender();
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

describe('EmailActivity', () => {
  it('renders one h2, the template summary and the sends', async () => {
    const { el } = await setup();
    expect(el.querySelectorAll('h2')).toHaveLength(1);
    expect(el.textContent).toContain('claim-approved');
    expect(el.textContent).toContain('Tells a claimant the claim is approved.');
    expect(el.textContent).toContain('1 send matches.');
    expect(el.textContent).toContain('Bounced');
    expect(el.textContent).toContain('Permanent');
  });

  it('switches the summary window between 7 and 30 days', async () => {
    const { el, rerender } = await setup();
    const sentCell = () =>
      el
        .querySelector<HTMLTableRowElement>(
          'section[aria-labelledby="admin-email-summary-heading"] tbody tr',
        )!
        .querySelectorAll('td')[0]!
        .textContent!.trim();
    expect(sentCell()).toBe('3');
    const button = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) =>
      b.textContent?.includes('Last 30 days'),
    )!;
    button.click();
    await rerender();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(sentCell()).toBe('9');
  });

  it('hides the sign-in panel when the API sends none, and shows it when it does', async () => {
    const off = await setup();
    expect(off.el.textContent).not.toContain('Sign-in emails');

    const zero = { sent: 0, delivered: 0, delivery_delayed: 0, bounced: 0, complained: 0 };
    const on = await setup(
      makeApi({
        summary: makeSummary({
          environment: 'production',
          sign_in: { d7: { ...zero, delivered: 41 }, d30: { ...zero, delivered: 160, bounced: 2 } },
        }),
      }),
    );
    expect(on.el.textContent).toContain('Sign-in emails');
    expect(on.el.textContent).toContain('41');
    expect(on.el.textContent).toContain('160');
  });

  it('sends a typed address to the search call only, and never renders it', async () => {
    const { el, api, rerender } = await setup();
    expect(api.listSends).toHaveBeenCalledTimes(1);

    await search(el, rerender, 'Dana@Acme.com');

    expect(api.searchSends).toHaveBeenCalledTimes(1);
    expect(api.searchSends.mock.calls[0]![0]).toBe('Dana@Acme.com');
    for (const call of api.listSends.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Dana');
    }
    // The input keeps its own value, but no other node repeats the address.
    const text = el.textContent!;
    expect(text).not.toContain('Dana@Acme.com');
    expect(el.textContent).toContain('to this address');
  });

  it('shows delivery reports with no send record during a search', async () => {
    const api = makeApi({
      search: {
        ...makeList({ data: [], total: 0 }),
        unmatched_events: [
          {
            id: 3,
            notification_id: 'supabase-sign-in',
            tier: 'auth',
            event_type: 'delivered',
            occurred_at: '2026-10-01T08:00:00.000Z',
            provider_message_id: 're_auth',
            bounce_type: null,
            bounce_subtype: null,
          },
        ],
      },
    });
    const { el, rerender } = await setup(api);
    expect(el.textContent).not.toContain('Delivery reports with no send record');
    await search(el, rerender, 'dana@acme.com');
    expect(el.textContent).toContain('Delivery reports with no send record');
    expect(el.textContent).toContain('supabase-sign-in');
    expect(el.textContent).toContain('No sends match this search or filter.');
  });

  it('says nothing was sent when the tier is empty, and "no matches" when a filter is set', async () => {
    const empty = await setup(makeApi({ list: makeList({ data: [], total: 0 }) }));
    expect(empty.el.textContent).toContain('Nothing has been sent from this site yet.');
    expect(empty.el.textContent).not.toContain('No sends match');

    (empty.fixture.componentInstance as unknown as { onOutcome(v: string): void }).onOutcome(
      'failed',
    );
    await empty.rerender();
    expect(empty.el.textContent).toContain('No sends match this search or filter.');
    expect(empty.api.listSends.mock.calls.at(-1)![0]).toMatchObject({ outcome: 'failed', page: 1 });

    const clear = [...empty.el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Clear filters'),
    )!;
    clear.click();
    await empty.rerender();
    expect(empty.api.listSends.mock.calls.at(-1)![0].outcome).toBeUndefined();
  });

  it('fails the summary and the list separately, and blames the session only on 401/403', async () => {
    const { el } = await setup(
      makeApi({ summary: new HttpErrorResponse({ status: 500 }), list: makeList() }),
    );
    expect(el.textContent).toContain("We couldn't load the template summary.");
    expect(el.textContent).not.toContain('Your session may have expired.');
    expect(el.textContent).toContain('claim-approved'); // the list still rendered

    const auth = await setup(makeApi({ list: new HttpErrorResponse({ status: 401 }) }));
    expect(auth.el.textContent).toContain("We couldn't load the sends.");
    expect(auth.el.textContent).toContain('Your session may have expired.');
  });

  it('links the related entity to its admin page and the message to Resend in a new tab', async () => {
    const { el } = await setup();
    const entity = el.querySelector<HTMLAnchorElement>('a[href="/admin/claims/req-1"]');
    expect(entity?.textContent?.trim()).toBe('Vendor claim');
    const resend = el.querySelector<HTMLAnchorElement>(
      'a[href="https://resend.com/emails/re_abc"]',
    );
    expect(resend).not.toBeNull();
    expect(resend!.target).toBe('_blank');
    expect(resend!.rel).toContain('noopener');
  });

  it('says "No report yet" for a sent row with no event, and "Not applicable" without an id', async () => {
    const { el } = await setup(
      makeApi({
        list: makeList({
          total: 2,
          data: [
            makeRow({ id: 1, latest_delivery: null }),
            makeRow({
              id: 2,
              outcome: 'suppressed',
              provider_message_id: null,
              latest_delivery: null,
              entity: null,
            }),
          ],
        }),
      }),
    );
    expect(el.textContent).toContain('No report yet');
    expect(el.textContent).toContain('Not applicable');
    expect(el.textContent).toContain('Not recorded');
  });
});
