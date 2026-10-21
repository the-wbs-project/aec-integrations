/**
 * `ReturnRecordsControl`: "Return records to AECi" on `/admin/vendors/:id`
 * (AECI-1415, ADR 0042).
 *
 * Pinned here:
 *  1. an AECi-owned vendor gets a sentence and no button;
 *  2. an owned vendor with seats left gets a disabled button that says why;
 *  3. the confirm step requires a reason before it calls the API;
 *  4. a success emits the result and announces through the host;
 *  5. a `VENDOR_HAS_SEATS` refusal is shown in its own words.
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
};

@Component({
  selector: 'aec-test-host',
  imports: [ReturnRecordsControl],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-return-records-control
      [vendorId]="vendorId"
      [ownedAt]="ownedAt()"
      [hasSeats]="hasSeats()"
      idPrefix="host"
      (returned)="results.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly ownedAt = signal<string | null>('2026-10-01T00:00:00.000Z');
  readonly hasSeats = signal<boolean | null>(false);
  readonly announced = signal('');
  readonly results: AdminReturnRecordsResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(
  returnRecords: ReturnType<typeof vi.fn>,
  state: { ownedAt?: string | null; hasSeats?: boolean | null } = {},
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
  return { fixture, el, refresh, button };
}

describe('ReturnRecordsControl', () => {
  it('shows no button when AECi owns the records', async () => {
    const { el, button } = await setup(vi.fn(), { ownedAt: null });
    expect(el.textContent).toContain("AECi owns this vendor's records");
    expect(button('Return records to AECi')).toBeUndefined();
  });

  it('disables the button while any seat remains, and says why', async () => {
    const { el, button } = await setup(vi.fn(), { hasSeats: true });
    const open = button('Return records to AECi')!;
    expect(open.disabled).toBe(true);
    const hint = el.querySelector('#host-return-blocked')!;
    expect(hint.textContent).toContain('revoke every seat first');
    expect(open.getAttribute('aria-describedby')).toBe('host-return-blocked');
  });

  it('requires a reason before it calls the API', async () => {
    const returnRecords = vi.fn(async () => RESULT);
    const { el, refresh, button } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    expect(el.querySelector('[role="note"]')?.textContent).toContain('approved by mistake');

    button('Return the records')!.click();
    await refresh();
    expect(returnRecords).not.toHaveBeenCalled();
    const reason = el.querySelector<HTMLTextAreaElement>('#host-return-reason')!;
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Write a reason before returning the records.');
  });

  it('returns the records, emits the result and announces through the host', async () => {
    const returnRecords = vi.fn(async () => RESULT);
    const { fixture, el, refresh, button } = await setup(returnRecords);
    button('Return records to AECi')!.click();
    await refresh();
    const reason = el.querySelector<HTMLTextAreaElement>('#host-return-reason')!;
    reason.value = 'Approved by mistake';
    reason.dispatchEvent(new Event('input'));
    button('Return the records')!.click();
    await refresh();

    expect(returnRecords).toHaveBeenCalledWith(VENDOR_ID, 'Approved by mistake', '');
    expect(fixture.componentInstance.results).toEqual([RESULT]);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Records returned to AECi.');
    // The confirm step closes. The control renders no live region of its own.
    expect(el.querySelector('#host-return-reason')).toBeNull();
    expect(el.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('shows the seat refusal in its own words', async () => {
    const returnRecords = vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'VENDOR_HAS_SEATS', message: 'x' } },
      });
    });
    const { el, refresh, button } = await setup(returnRecords, { hasSeats: null });
    button('Return records to AECi')!.click();
    await refresh();
    const reason = el.querySelector<HTMLTextAreaElement>('#host-return-reason')!;
    reason.value = 'Approved by mistake';
    reason.dispatchEvent(new Event('input'));
    button('Return the records')!.click();
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This vendor still has a seat.',
    );
  });
});
