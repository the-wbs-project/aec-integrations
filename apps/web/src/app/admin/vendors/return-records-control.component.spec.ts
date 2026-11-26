/**
 * `ReturnRecordsControl`: "Return records to AECi" on `/admin/vendors/:id`
 * (AECI-1415, ADR 0042).
 *
 * Pinned here:
 *  1. an AECi-owned vendor gets a sentence and no button;
 *  2. an owned vendor with seats left gets a disabled button that says why;
 *  3. the confirm step requires a reason before it calls the API;
 *  4. a success emits the result and announces through the host;
 *  5. a `VENDOR_HAS_SEATS` refusal is shown in its own words;
 *  6. the confirm step names the open product proposals the return discards (AECI-1416);
 *  7. open, Cancel and a refusal each move focus on purpose (AECI-1994);
 *  8. the return sits on the console's danger form (AECI-2124): a secondary opener, no
 *     box of its own, a danger confirm, Escape as Cancel except while it runs.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AdminReturnRecordsResponse } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { ReturnRecordsControl } from './return-records-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

const RESULT: AdminReturnRecordsResponse = {
  vendor_id: VENDOR_ID,
  owned_at: null,
  product_ids: ['p1'],
  integration_ids: [],
  evidenced_pair_ids: [],
  contests_rerouted: 0,
  discarded_proposal_ids: [],
};

@Component({
  selector: 'aec-test-host',
  imports: [ReturnRecordsControl],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-return-records-control
      [vendorId]="vendorId()"
      [ownedAt]="ownedAt()"
      [hasSeats]="hasSeats()"
      [openProposalCount]="openProposalCount()"
      idPrefix="host"
      (returned)="results.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = signal(VENDOR_ID);
  readonly ownedAt = signal<string | null>('2026-10-01T00:00:00.000Z');
  readonly hasSeats = signal<boolean | null>(false);
  readonly openProposalCount = signal(0);
  readonly announced = signal('');
  readonly results: AdminReturnRecordsResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(
  returnRecords: ReturnType<typeof vi.fn>,
  state: { ownedAt?: string | null; hasSeats?: boolean | null; openProposalCount?: number } = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminVendorsApi, useValue: { returnRecords } },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  if (state.ownedAt !== undefined) fixture.componentInstance.ownedAt.set(state.ownedAt);
  if (state.hasSeats !== undefined) fixture.componentInstance.hasSeats.set(state.hasSeats);
  if (state.openProposalCount !== undefined) {
    fixture.componentInstance.openProposalCount.set(state.openProposalCount);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  /** The danger form's reason: its id is the form's own, so find it by its label. */
  const reasonField = () => {
    const label = [...el.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'Reason (required)',
    );
    const id = label?.getAttribute('for');
    return id ? el.querySelector<HTMLTextAreaElement>(`[id="${id}"]`) : null;
  };
  const formOpen = () => {
    const form = el.querySelector('form');
    return !!form && !form.hidden;
  };
  const typeReason = (value: string) => {
    const reason = reasonField()!;
    reason.value = value;
    reason.dispatchEvent(new Event('input'));
  };
  return { fixture, el, refresh, button, reasonField, formOpen, typeReason };
}

describe('ReturnRecordsControl', () => {
  it('shows no button when AECi owns the records', async () => {
    const { el, button } = await setup(vi.fn(), { ownedAt: null });
    expect(el.textContent).toContain("AECi owns this vendor's records");
    expect(button('Return records to AECi')).toBeUndefined();
  });

  it('blocks the opener while any seat remains, and says why', async () => {
    const { el, refresh, button, formOpen } = await setup(vi.fn(), { hasSeats: true });
    const open = button('Return records to AECi')!;
    // AECI-2124: the danger form's blocked opener. It stays focusable, so the reason is heard.
    expect(open.getAttribute('aria-disabled')).toBe('true');
    const hint = el.querySelector('#host-return-blocked')!;
    expect(hint.textContent).toContain('revoke every seat first');
    expect(open.getAttribute('aria-describedby')).toBe('host-return-blocked');
    open.click();
    await refresh();
    expect(formOpen()).toBe(false);
  });

  it('requires a reason before it calls the API', async () => {
    const returnRecords = vi.fn(async () => RESULT);
    const { el, refresh, button, reasonField } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    expect(el.querySelector('form')?.textContent).toContain('approved by mistake');

    button('Return the records')!.click();
    await refresh();
    expect(returnRecords).not.toHaveBeenCalled();
    expect(reasonField()!.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Write a reason before returning the records.');
  });

  it('returns the records, emits the result and announces through the host', async () => {
    const returnRecords = vi.fn(async () => RESULT);
    const { fixture, el, refresh, button, formOpen, typeReason } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Approved by mistake');
    button('Return the records')!.click();
    await refresh();

    expect(returnRecords).toHaveBeenCalledWith(VENDOR_ID, 'Approved by mistake', '');
    expect(fixture.componentInstance.results).toEqual([RESULT]);
    expect(el.querySelector('[role="status"][aria-live]')?.textContent).toContain(
      'Records returned to AECi.',
    );
    // The confirm step closes, and focus is back on the opener.
    expect(formOpen()).toBe(false);
    expect(document.activeElement).toBe(button('Return records to AECi'));
  });

  it('sends the internal note as typed', async () => {
    const returnRecords = vi.fn(async () => RESULT);
    const { el, refresh, button, typeReason, reasonField } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Approved by mistake');
    const label = [...el.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'Internal note (optional)',
    )!;
    const note = el.querySelector<HTMLTextAreaElement>(`[id="${label.getAttribute('for')}"]`)!;
    expect(note.getAttribute('maxlength')).toBe('1000');
    // The reason keeps AdminReasonSchema's cap as a native limit, as on main.
    expect(reasonField()!.getAttribute('maxlength')).toBe('1000');
    note.value = 'Ticket 42';
    note.dispatchEvent(new Event('input'));
    button('Return the records')!.click();
    await refresh();
    expect(returnRecords).toHaveBeenCalledWith(VENDOR_ID, 'Approved by mistake', 'Ticket 42');
  });

  it('is the console danger form: secondary opener, no box of its own, danger confirm (AECI-2124)', async () => {
    const { el, refresh, button } = await setup(vi.fn());
    const root = el.querySelector('[data-testid="return-records"]')!;
    expect(root.className).not.toContain('border');
    expect(root.className).not.toContain('rounded');
    expect(button('Return records to AECi')!.className).toContain('aec-btn-secondary');
    button('Return records to AECi')!.click();
    await refresh();
    expect(button('Return the records')!.className).toContain('bg-(--status-error)');
    expect(button('Cancel')!.className).toContain('bg-transparent');
  });

  it('closes on Escape and returns focus to the opener, but not while it runs', async () => {
    let resolve!: (r: AdminReturnRecordsResponse) => void;
    const returnRecords = vi.fn(
      () => new Promise<AdminReturnRecordsResponse>((done) => (resolve = done)),
    );
    const { refresh, button, reasonField, formOpen, typeReason } = await setup(returnRecords);
    const escape = () =>
      reasonField()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    button('Return records to AECi')!.click();
    await refresh();
    escape();
    await refresh();
    expect(formOpen()).toBe(false);
    expect(document.activeElement).toBe(button('Return records to AECi'));

    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Approved by mistake');
    button('Return the records')!.click();
    await refresh();
    escape();
    await refresh();
    expect(formOpen()).toBe(true);
    resolve(RESULT);
    await refresh();
    expect(formOpen()).toBe(false);
  });

  it('shows the seat refusal in its own words', async () => {
    const returnRecords = vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'VENDOR_HAS_SEATS', message: 'x' } },
      });
    });
    const { el, refresh, button, typeReason } = await setup(returnRecords, { hasSeats: null });
    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Approved by mistake');
    button('Return the records')!.click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This vendor still has a seat.',
    );
    // AECI-1994: the disabled confirm dropped focus, so the refusal takes it.
    expect(document.activeElement?.getAttribute('role')).toBe('alert');
    expect(document.activeElement?.textContent).toContain('This vendor still has a seat.');
  });

  it('focuses the reason on open, and Cancel returns focus to the button (AECI-1994)', async () => {
    const { refresh, button, reasonField, formOpen } = await setup(vi.fn());
    button('Return records to AECi')!.click();
    await refresh();
    expect(document.activeElement).toBe(reasonField());

    button('Cancel')!.click();
    await refresh();
    expect(formOpen()).toBe(false);
    expect(document.activeElement).toBe(button('Return records to AECi'));
  });

  it('names the open product proposals the return discards (AECI-1416)', async () => {
    const { el, refresh, button } = await setup(vi.fn(), { openProposalCount: 3 });
    button('Return records to AECi')!.click();
    await refresh();
    expect(el.querySelector('#host-return-proposals')?.textContent?.trim()).toBe(
      '3 open product proposals will be discarded.',
    );
  });

  it('uses the singular for one proposal, and says nothing when there are none', async () => {
    const one = await setup(vi.fn(), { openProposalCount: 1 });
    one.button('Return records to AECi')!.click();
    await one.refresh();
    expect(one.el.querySelector('#host-return-proposals')?.textContent?.trim()).toBe(
      '1 open product proposal will be discarded.',
    );

    const none = await setup(vi.fn());
    none.button('Return records to AECi')!.click();
    await none.refresh();
    expect(none.el.querySelector('#host-return-proposals')).toBeNull();
  });

  it('shows the proposal race in its own words', async () => {
    const returnRecords = vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'VENDOR_PROPOSALS_CHANGED', message: 'x' } },
      });
    });
    const { el, refresh, button, typeReason } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Approved by mistake');
    button('Return the records')!.click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'A new product proposal for this vendor arrived',
    );
  });
});

describe('ReturnRecordsControl: a refusal belongs to its attempt (AECI-2124 review)', () => {
  const seatsRefusal = () =>
    vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'VENDOR_HAS_SEATS', message: 'x' } },
      });
    });

  async function refused() {
    const ctx = await setup(seatsRefusal(), { hasSeats: null });
    ctx.button('Return records to AECi')!.click();
    await ctx.refresh();
    ctx.typeReason('Approved by mistake');
    ctx.button('Return the records')!.click();
    await ctx.refresh();
    expect(ctx.el.querySelector('[role="alert"]')?.textContent).toContain(
      'This vendor still has a seat.',
    );
    return ctx;
  }

  async function reopenShowsNoRefusal(ctx: Awaited<ReturnType<typeof refused>>) {
    expect(ctx.formOpen()).toBe(false);
    ctx.button('Return records to AECi')!.click();
    await ctx.refresh();
    expect(ctx.formOpen()).toBe(true);
    expect(ctx.el.querySelector('[role="alert"]')).toBeNull();
    expect(ctx.reasonField()!.getAttribute('aria-invalid')).toBeNull();
  }

  it('Cancel, then reopen: no old refusal', async () => {
    const ctx = await refused();
    ctx.button('Cancel')!.click();
    await ctx.refresh();
    await reopenShowsNoRefusal(ctx);
  });

  it('Escape, then reopen: no old refusal', async () => {
    const ctx = await refused();
    ctx
      .reasonField()!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ctx.refresh();
    await reopenShowsNoRefusal(ctx);
  });

  it('a close by the opener, then reopen: the draft is kept, the refusal is not', async () => {
    const ctx = await refused();
    ctx.button('Return records to AECi')!.click();
    await ctx.refresh();
    await reopenShowsNoRefusal(ctx);
    expect(ctx.reasonField()!.value).toBe('Approved by mistake');
  });
});

describe('ReturnRecordsControl reused for another vendor (AECI-2124 review)', () => {
  it('drops the reason, the note and an open form when the vendor id changes', async () => {
    const { fixture, refresh, button, reasonField, formOpen, typeReason } = await setup(vi.fn());
    button('Return records to AECi')!.click();
    await refresh();
    typeReason('Typed for the first vendor');
    // A close by the opener keeps the draft for the same vendor...
    button('Return records to AECi')!.click();
    await refresh();

    fixture.componentInstance.vendorId.set('00000000-0000-4000-8000-000000000003');
    await refresh();
    expect(formOpen()).toBe(false);
    button('Return records to AECi')!.click();
    await refresh();
    // ...but never for another vendor.
    expect(reasonField()!.value).toBe('');
  });
});
