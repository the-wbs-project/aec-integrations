/**
 * `VendorSuspensionSection`: suspend, then terminate, on `/admin/vendors/:id` (AECI-1623).
 *
 * Pinned here, against the real children and a stubbed client:
 *  1. each state the section can be in says what is true: no suspension, an unconfirmed
 *     notice with no clock, a running window, stage 2;
 *  2. the forms refuse an empty required field and call the API with the right body;
 *  3. Terminate shows why it is disabled, what Stripe being down means, and a preview that
 *     moves as invoice amounts are typed, with the cost never above the refund;
 *  4. a 409 on the refund re-reads the state and says to check the numbers;
 *  5. history shows the statement and each refund's status, and offers Retry only when a
 *     refund is unsettled.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AbuseCostEntry,
  VendorSuspension,
  VendorSuspensionStateResponse,
  VendorTerminationPreview,
} from '@aeci/shared';

import { AdminVendorSuspensionApi } from './admin-vendor-suspension-api';
import { REFUND_SETTLE_DELAY_MS, VendorSuspensionSection } from './vendor-suspension-section';
import {
  formatCents,
  manualGrossCents,
  parseDollarsToCents,
  terminateBlockedReason,
} from './vendor-suspension-model';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';
const LICENSE_ID = '00000000-0000-4000-8000-000000000009';

function suspension(overrides: Partial<VendorSuspension> = {}): VendorSuspension {
  return {
    id: 's1',
    kind: 'breach',
    rule: 'Rule 4: no false listings',
    evidence: 'Screenshots of the page',
    reason: 'Internal note on the case',
    suspended_at: '2026-11-01T00:00:00.000Z',
    notice_sent_at: '2026-11-01T00:05:00.000Z',
    window_ends_at: '2026-11-10T00:05:00.000Z',
    stage_2_finding: null,
    stage_2_notice_sent_at: null,
    stage_2_ends_at: null,
    can_start_stage_2: false,
    can_terminate: false,
    cost_log: [],
    resolution: null,
    resolved_at: null,
    resolution_reason: null,
    statement: null,
    refunds: [],
    ...overrides,
  };
}

function preview(overrides: Partial<VendorTerminationPreview> = {}): VendorTerminationPreview {
  return {
    available: true,
    currency: 'usd',
    gross_cents: 50_000,
    cost_total_cents: 10_000,
    payments: [],
    manual_payments: [],
    ...overrides,
  };
}

function stateOf(open: VendorSuspension | null, p = preview()): VendorSuspensionStateResponse {
  return { open, history: open ? [open] : [], preview: open ? p : null };
}

const NONE: VendorSuspensionStateResponse = { open: null, history: [], preview: null };

const ENTRY: AbuseCostEntry = {
  id: 'e1',
  kind: 'staff',
  work_date: '2026-11-02',
  description: 'Reviewed the false listing',
  minutes: 60,
  amount_cents: null,
  cents: 15_000,
  logged_at: '2026-11-02T10:00:00.000Z',
  voided_at: null,
  void_reason: null,
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: 'x' } } });
}

@Component({
  selector: 'aec-test-host',
  imports: [VendorSuspensionSection],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-vendor-suspension-section
      [vendorId]="vendorId"
      idPrefix="host"
      (changed)="changed = changed + 1"
      (terminated)="terminated = terminated + 1"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly announced = signal('');
  changed = 0;
  terminated = 0;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

type ApiStub = Record<keyof AdminVendorSuspensionApi, ReturnType<typeof vi.fn>>;

async function setup(state: VendorSuspensionStateResponse, overrides: Partial<ApiStub> = {}) {
  const written = { suspension: state.open ?? suspension() };
  const api = {
    getState: vi.fn(async () => state),
    suspend: vi.fn(async () => ({ suspension: suspension(), notice_sent: true })),
    resendNotice: vi.fn(async () => ({ ...written, notice_sent: true })),
    startStage2: vi.fn(async () => ({ ...written, notice_sent: true })),
    addCostEntry: vi.fn(async () => written),
    voidCostEntry: vi.fn(async () => written),
    lift: vi.fn(async () => ({
      suspension: suspension({ resolution: 'lifted', resolved_at: '2026-11-03T00:00:00.000Z' }),
    })),
    terminate: vi.fn(async () => ({
      suspension: suspension({ resolution: 'terminated', resolved_at: '2026-11-20T00:00:00.000Z' }),
    })),
    retryRefunds: vi.fn(async () => written),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminVendorSuspensionApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };
  await refresh();
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  const type = (id: string, value: string) => {
    const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${id}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const text = (selector: string) =>
    (el.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { fixture, el, api, refresh, button, type, text, host: fixture.componentInstance };
}

describe('VendorSuspensionSection', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('no open suspension', () => {
    it('offers Suspend, and the form says what it does and who reads what', async () => {
      const { el, button, refresh } = await setup(NONE);
      button('Suspend')!.click();
      await refresh();

      expect(el.querySelector('[role="note"]')?.textContent).toContain(
        'locks every seat out at once and sends the notice',
      );
      expect(el.querySelector('label[for="host-suspend-rule"]')?.textContent).toContain(
        'vendor-facing',
      );
      expect(el.querySelector('label[for="host-suspend-evidence"]')?.textContent).toContain(
        'vendor-facing',
      );
      expect(el.querySelector('label[for="host-suspend-reason"]')?.textContent).toContain(
        'internal',
      );
    });

    it('refuses an empty field and calls nothing', async () => {
      const { el, api, button, refresh } = await setup(NONE);
      button('Suspend')!.click();
      await refresh();
      button('Suspend and send the notice')!.click();
      await refresh();

      expect(api.suspend).not.toHaveBeenCalled();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Fill in the rule, the evidence and the reason.',
      );
      expect(el.querySelector('#host-suspend-rule')?.getAttribute('aria-invalid')).toBe('true');
    });

    it('suspends with the chosen kind, then re-reads the state', async () => {
      const getState = vi.fn().mockResolvedValueOnce(NONE).mockResolvedValue(stateOf(suspension()));
      const { el, api, host, button, type, refresh } = await setup(NONE, { getState });
      button('Suspend')!.click();
      await refresh();
      el.querySelector<HTMLInputElement>('#host-suspend-kind-false-claim')!.click();
      type('host-suspend-rule', ' Rule 4 ');
      type('host-suspend-evidence', 'The page');
      type('host-suspend-reason', 'Why');
      await refresh();
      button('Suspend and send the notice')!.click();
      await refresh();

      expect(api.suspend).toHaveBeenCalledWith(VENDOR_ID, {
        kind: 'false_claim',
        rule: 'Rule 4',
        evidence: 'The page',
        reason: 'Why',
      });
      expect(api.getState).toHaveBeenCalledTimes(2);
      expect(host.changed).toBe(1);
      expect(el.querySelector('[role="status"]')?.textContent).toContain('window has started');
      expect(el.querySelector('[data-testid="suspension-banner"]')).not.toBeNull();
    });

    it('shows an already-suspended refusal and re-reads', async () => {
      const suspend = vi.fn(async () => {
        throw apiError(409, 'VENDOR_SUSPENSION_STATE');
      });
      const { el, api, button, type, refresh } = await setup(NONE, { suspend });
      button('Suspend')!.click();
      await refresh();
      type('host-suspend-rule', 'r');
      type('host-suspend-evidence', 'e');
      type('host-suspend-reason', 'w');
      button('Suspend and send the notice')!.click();
      await refresh();

      expect(el.querySelector('[role="alert"]')?.textContent).toContain('nothing was saved');
      expect(api.getState).toHaveBeenCalledTimes(2);
    });
  });

  describe('the banner', () => {
    it('states the window while the notice is confirmed, with no re-send', async () => {
      const { text, button } = await setup(stateOf(suspension()));
      const banner = text('[data-testid="suspension-banner"]');
      expect(banner).toContain('Stage 1 notice confirmed sent');
      expect(banner).toContain('ends Nov 10, 2026');
      expect(banner).toContain('Every seat is locked out');
      expect(button('Re-send notice')).toBeUndefined();
    });

    it('says there is no clock and offers a re-send while unconfirmed', async () => {
      const open = suspension({ notice_sent_at: null, window_ends_at: null });
      const { api, text, button, refresh } = await setup(stateOf(open), {
        resendNotice: vi.fn(async () => ({ suspension: open, notice_sent: false })),
      });
      expect(text('[data-testid="suspension-banner"]')).toContain('There is no clock yet.');

      button('Re-send notice')!.click();
      await refresh();
      expect(api.resendNotice).toHaveBeenCalledWith(VENDOR_ID);
      expect(text('[data-testid="suspension-banner"]')).toContain(
        'The last send reached no address.',
      );
    });

    it('states stage 2, and offers a re-send on its unconfirmed notice', async () => {
      const running = suspension({
        kind: 'false_claim',
        stage_2_finding: 'They do not work there',
        stage_2_notice_sent_at: '2026-11-11T00:00:00.000Z',
        stage_2_ends_at: '2026-11-20T00:00:00.000Z',
      });
      const first = await setup(stateOf(running));
      const banner = first.text('[data-testid="suspension-banner"]');
      expect(banner).toContain('Stage 2 notice confirmed sent');
      expect(banner).toContain('ends Nov 20, 2026');
      expect(first.button('Re-send notice')).toBeUndefined();

      const second = await setup(
        stateOf({ ...running, stage_2_notice_sent_at: null, stage_2_ends_at: null }),
      );
      expect(second.text('[data-testid="suspension-banner"]')).toContain(
        'The stage 2 notice has not been confirmed sent.',
      );
      expect(second.button('Re-send notice')).toBeDefined();
    });
  });

  describe('stage 2', () => {
    it('offers the form only when the API allows it, and sends the finding', async () => {
      const closed = await setup(stateOf(suspension()));
      expect(closed.el.querySelector('[data-testid="suspension-stage-2"]')).toBeNull();

      const { el, api, button, type, refresh } = await setup(
        stateOf(suspension({ can_start_stage_2: true })),
      );
      button('Start stage 2')!.click();
      await refresh();
      button('Start stage 2 and send the notice')!.click();
      await refresh();
      expect(api.startStage2).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Write the finding before starting stage 2.');

      type('host-stage2-finding', 'Not their product');
      button('Start stage 2 and send the notice')!.click();
      await refresh();
      expect(api.startStage2).toHaveBeenCalledWith(VENDOR_ID, { finding: 'Not their product' });
    });
  });

  describe('lift', () => {
    it('requires a reason, then lifts and shows the history row', async () => {
      const lifted = suspension({
        resolution: 'lifted',
        resolved_at: '2026-11-03T00:00:00.000Z',
        resolution_reason: 'Cured',
      });
      const getState = vi
        .fn()
        .mockResolvedValueOnce(stateOf(suspension()))
        .mockResolvedValue({ open: null, history: [lifted], preview: null });
      const { el, api, button, type, refresh } = await setup(stateOf(suspension()), { getState });

      button('Lift the suspension')!.click();
      await refresh();
      button('Lift and restore every seat')!.click();
      await refresh();
      expect(api.lift).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Write a reason before lifting the suspension.');

      type('host-lift-reason', 'Cured');
      button('Lift and restore every seat')!.click();
      await refresh();
      expect(api.lift).toHaveBeenCalledWith(VENDOR_ID, 'Cured');
      expect(el.querySelector('[data-history-row="lifted"]')?.textContent).toContain('Cured');
      expect(button('Suspend')).toBeDefined();
    });
  });

  describe('the cost log', () => {
    const withEntries = (cost_log: AbuseCostEntry[]) => stateOf(suspension({ cost_log }));

    it('lists each entry with its minutes, value and voided state, and says the rule', async () => {
      const { el, text } = await setup(
        withEntries([
          ENTRY,
          {
            ...ENTRY,
            id: 'e2',
            kind: 'recovery',
            minutes: null,
            amount_cents: 5_000,
            cents: -5_000,
            voided_at: '2026-11-03T00:00:00.000Z',
            void_reason: 'Logged twice',
          },
        ]),
      );
      const log = text('[data-testid="suspension-cost-log"]');
      expect(log).toContain('Write each entry at the time, by task');
      expect(log).toContain('only for costs the breach caused');
      expect(log).toContain('$150 an hour');

      const first = el.querySelector('[data-entry="e1"]')!.textContent!;
      expect(first).toContain('2026-11-02');
      expect(first).toContain('60 min');
      expect(first).toContain('$150.00');
      expect(first).toContain('Nov 2, 2026');

      const second = el.querySelector('[data-entry="e2"]')!.textContent!;
      expect(second).toContain('$50.00');
      expect(second).toContain('-$50.00');
      expect(second).toContain('Voided');
      expect(second).toContain('Logged twice');
    });

    it('adds staff time as minutes and a third-party cost as cents', async () => {
      const { el, api, button, type, refresh } = await setup(withEntries([]));
      button('Add a cost entry')!.click();
      await refresh();
      type('host-cost-date', '2026-11-02');
      type('host-cost-description', 'Reviewed the page');
      type('host-cost-quantity', '30');
      await refresh();
      expect(el.textContent).toContain('Counts for $75.00.');
      button('Log this cost')!.click();
      await refresh();
      expect(api.addCostEntry).toHaveBeenCalledWith(VENDOR_ID, {
        kind: 'staff',
        work_date: '2026-11-02',
        description: 'Reviewed the page',
        minutes: 30,
      });

      button('Add a cost entry')!.click();
      await refresh();
      el.querySelector<HTMLInputElement>('#host-cost-kind-third_party')!.click();
      await refresh();
      type('host-cost-date', '2026-11-02');
      type('host-cost-description', 'Counsel');
      type('host-cost-quantity', '1,200.50');
      button('Log this cost')!.click();
      await refresh();
      expect(api.addCostEntry).toHaveBeenLastCalledWith(VENDOR_ID, {
        kind: 'third_party',
        work_date: '2026-11-02',
        description: 'Counsel',
        amount_cents: 120_050,
      });
    });

    it('refuses a future date and a bad amount before it calls the API', async () => {
      const { el, api, button, type, refresh } = await setup(withEntries([]));
      button('Add a cost entry')!.click();
      await refresh();
      type('host-cost-date', '2999-01-01');
      type('host-cost-description', 'x');
      type('host-cost-quantity', '1.5');
      await refresh();
      button('Log this cost')!.click();
      await refresh();
      expect(api.addCostEntry).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Enter a date no later than today (UTC).');
      expect(el.textContent).toContain('Enter a whole number of minutes');
    });

    it('voids with a required reason', async () => {
      const { el, api, button, type, refresh } = await setup(withEntries([ENTRY]));
      button('Void')!.click();
      await refresh();
      button('Void this entry')!.click();
      await refresh();
      expect(api.voidCostEntry).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Write a reason before voiding the entry.');

      type('host-void-reason-e1', 'Logged twice');
      button('Void this entry')!.click();
      await refresh();
      expect(api.voidCostEntry).toHaveBeenCalledWith(VENDOR_ID, 'e1', 'Logged twice');
    });
  });

  describe('terminate', () => {
    const ready = () => suspension({ can_terminate: true });
    const manual = {
      license_id: LICENSE_ID,
      reference: 'INV-7',
      starts_at: '2026-01-01T00:00:00.000Z',
      ends_at: '2027-01-01T00:00:00.000Z',
    };

    it('is disabled with the reason while the window runs', async () => {
      const { el, button, api } = await setup(stateOf(suspension()));
      const terminate = button('Terminate')!;
      expect(terminate.disabled).toBe(true);
      expect(el.querySelector('#host-terminate-blocked')?.textContent).toContain(
        'The window of 7 business days is still open.',
      );
      expect(terminate.getAttribute('aria-describedby')).toBe('host-terminate-blocked');
      expect(api.terminate).not.toHaveBeenCalled();
    });

    it('says Stripe cannot be read, and that Terminate would refuse, with no numbers', async () => {
      const { el, text, button } = await setup(
        stateOf(ready(), preview({ available: false, gross_cents: 0 })),
      );
      expect(text('[data-testid="suspension-stripe-down"]')).toContain(
        'Stripe cannot be read right now',
      );
      expect(text('[data-testid="suspension-stripe-down"]')).toContain('Terminate would refuse');
      expect(el.querySelector('[data-testid="suspension-statement-preview"]')).toBeNull();
      expect(button('Terminate')!.disabled).toBe(true);
    });

    it('previews the statement and never applies more cost than the refund', async () => {
      const first = await setup(stateOf(ready()));
      expect(first.text('[data-testid="preview-gross"]')).toBe('$500.00');
      expect(first.text('[data-testid="preview-cost"]')).toBe('$100.00');
      expect(first.text('[data-testid="preview-applied"]')).toBe('$100.00');
      expect(first.text('[data-testid="preview-refund"]')).toBe('$400.00');

      const capped = await setup(stateOf(ready(), preview({ cost_total_cents: 80_000 })));
      expect(capped.text('[data-testid="preview-cost"]')).toBe('$800.00');
      expect(capped.text('[data-testid="preview-applied"]')).toBe('$500.00');
      expect(capped.text('[data-testid="preview-refund"]')).toBe('$0.00');
    });

    it('sends the amounts and the numbers it showed, and the preview moves as they are typed', async () => {
      const { api, host, text, button, type, refresh, el } = await setup(
        stateOf(ready(), preview({ manual_payments: [manual] })),
      );
      // An empty invoice amount stops it, and points at the field.
      button('Terminate')!.click();
      await refresh();
      expect(
        el.querySelector(`[id="host-manual-${LICENSE_ID}"]`)?.getAttribute('aria-invalid'),
      ).toBe('true');
      expect(button('Terminate')).toBeDefined();

      // 1 Jan to 1 Jan is 365 days and 304 were used by 1 Nov, so 61 are unused.
      type(`host-manual-${LICENSE_ID}`, '3650');
      await refresh();
      expect(text('[data-testid="preview-gross"]')).toBe('$1,110.00');
      expect(text('[data-testid="preview-refund"]')).toBe('$1,010.00');

      button('Terminate')!.click();
      await refresh();
      expect(el.querySelector('[role="note"]')?.textContent).toContain('cannot be undone');
      expect(api.terminate).not.toHaveBeenCalled();
      button('Terminate and refund $1,010.00')!.click();
      await refresh();

      expect(api.terminate).toHaveBeenCalledWith(VENDOR_ID, {
        manual_payments: [{ license_id: LICENSE_ID, paid_cents: 365_000 }],
        expected_gross_cents: 50_000,
        expected_cost_cents: 10_000,
      });
      expect(host.terminated).toBe(1);
    });

    it('re-reads on a changed refund and says to check the numbers', async () => {
      const getState = vi
        .fn()
        .mockResolvedValueOnce(stateOf(ready()))
        .mockResolvedValue(stateOf(ready(), preview({ gross_cents: 40_000 })));
      const terminate = vi.fn(async () => {
        throw apiError(409, 'VENDOR_TERMINATION_REFUND_CHANGED');
      });
      const { el, text, button, refresh } = await setup(stateOf(ready()), { getState, terminate });

      button('Terminate')!.click();
      await refresh();
      button('Terminate and refund $400.00')!.click();
      await refresh();

      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Check the new numbers.');
      expect(getState).toHaveBeenCalledTimes(2);
      expect(text('[data-testid="preview-gross"]')).toBe('$400.00');
    });

    it('re-reads the state again after a short delay, because refunds settle later', async () => {
      const { api, button, refresh } = await setup(stateOf(ready()));
      const timers = vi.spyOn(globalThis, 'setTimeout');
      button('Terminate')!.click();
      await refresh();
      button('Terminate and refund $400.00')!.click();
      await refresh();

      const call = timers.mock.calls.find(([, delay]) => delay === REFUND_SETTLE_DELAY_MS);
      expect(call).toBeDefined();
      const reads = api.getState.mock.calls.length;
      (call![0] as () => void)();
      await refresh();
      expect(api.getState.mock.calls.length).toBe(reads + 1);
    });
  });

  describe('history', () => {
    const statement = {
      currency: 'usd',
      period_used_ends: '2026-11-01T00:00:00.000Z',
      payments: [
        {
          key: 'in_1',
          source: 'stripe' as const,
          period_start: '2026-01-01T00:00:00.000Z',
          period_end: '2027-01-01T00:00:00.000Z',
          paid_cents: 120_000,
          gross_cents: 20_000,
          cost_applied_cents: 5_000,
          refund_cents: 15_000,
        },
      ],
      costs: [],
      gross_cents: 20_000,
      cost_total_cents: 5_000,
      cost_applied_cents: 5_000,
      refund_cents: 15_000,
    };
    const row = (refunds: VendorSuspension['refunds']) =>
      suspension({
        resolution: 'terminated',
        resolved_at: '2026-11-20T00:00:00.000Z',
        statement,
        refunds,
      });
    const of = (s: VendorSuspension): VendorSuspensionStateResponse => ({
      open: null,
      history: [s],
      preview: null,
    });
    const refund = (status: VendorSuspension['refunds'][number]['status']) => ({
      id: `r-${status}`,
      status,
      refund_cents: 15_000,
      currency: 'usd',
      stripe_refund_id: null,
    });

    it('shows the statement, each status, and what a manual row means', async () => {
      const { text, button } = await setup(of(row([refund('succeeded'), refund('manual')])));
      const history = text('[data-history-row="terminated"]');
      expect(history).toContain('Terminated Nov 20, 2026');
      expect(history).toContain('Refund before cost');
      expect(history).toContain('$200.00');
      expect(history).toContain('Refunded');
      expect(history).toContain('the operator pays this by hand');
      expect(button('Retry refunds')).toBeUndefined();
    });

    it('offers Retry on a failed or pending refund, and Suspend stays available', async () => {
      const { api, button, refresh } = await setup(of(row([refund('failed')])));
      expect(button('Suspend')).toBeDefined();
      button('Retry refunds')!.click();
      await refresh();
      expect(api.retryRefunds).toHaveBeenCalledWith(VENDOR_ID);

      const pending = await setup(of(row([refund('pending')])));
      expect(pending.button('Retry refunds')).toBeDefined();
      expect(pending.button('Refresh')).toBeDefined();
    });

    it('offers Retry only on the newest terminated row, which is the one the API retries', async () => {
      const older = { ...row([refund('failed')]), id: 'old' };
      const newer = { ...row([refund('succeeded')]), id: 'new' };
      const { button } = await setup({ open: null, history: [newer, older], preview: null });
      expect(button('Retry refunds')).toBeUndefined();
    });
  });

  it('offers Try again when the first read fails', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }))
      .mockResolvedValue(NONE);
    const { el, button, refresh } = await setup(NONE, { getState });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load the suspension state.",
    );
    button('Try again')!.click();
    await refresh();
    expect(button('Suspend')).toBeDefined();
  });

  it('renders no live region of its own', async () => {
    const { el } = await setup(stateOf(suspension()));
    expect(el.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});

describe('the suspension model', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(12_345)).toBe('$123.45');
    expect(formatCents(-5_000)).toBe('-$50.00');
    expect(formatCents(0)).toBe('$0.00');
  });

  it('parses a typed dollar amount without floating-point error', () => {
    expect(parseDollarsToCents('19.99')).toBe(1_999);
    expect(parseDollarsToCents('$1,200.5')).toBe(120_050);
    expect(parseDollarsToCents('0')).toBe(0);
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('1.999')).toBeNull();
    expect(parseDollarsToCents('-1')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('1000001')).toBeNull();
  });

  it('prorates an invoice payment by whole UTC days, as the API does', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2027-01-01T00:00:00.000Z';
    expect(manualGrossCents(365_000, start, end, '2026-11-01T12:00:00.000Z')).toBe(61_000);
    // Suspended before the term began: fully unused, so it all comes back.
    expect(manualGrossCents(365_000, start, end, '2025-06-01T00:00:00.000Z')).toBe(365_000);
    // Suspended after the term ended: nothing unused.
    expect(manualGrossCents(365_000, start, end, '2027-06-01T00:00:00.000Z')).toBe(0);
    expect(manualGrossCents(0, start, end, '2026-11-01T00:00:00.000Z')).toBe(0);
  });

  it("reads Terminate's refusal back from the state, in the API's order", () => {
    expect(terminateBlockedReason(suspension({ can_terminate: true }))).toBeNull();
    expect(
      terminateBlockedReason(suspension({ notice_sent_at: null, window_ends_at: null })),
    ).toContain('has not been confirmed sent');
    expect(terminateBlockedReason(suspension())).toContain('still open');
    expect(
      terminateBlockedReason(suspension({ kind: 'false_claim', can_start_stage_2: true })),
    ).toContain('needs stage 2 first');
    expect(
      terminateBlockedReason(suspension({ kind: 'false_claim', stage_2_finding: 'x' })),
    ).toContain('stage 2 notice has not been confirmed sent');
    expect(
      terminateBlockedReason(
        suspension({
          kind: 'false_claim',
          stage_2_finding: 'x',
          stage_2_notice_sent_at: '2026-11-11T00:00:00.000Z',
        }),
      ),
    ).toContain('stage 2 window');
  });
});
