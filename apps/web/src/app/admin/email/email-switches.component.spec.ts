/**
 * `EmailSwitches` (the sending switches on `/admin/email`) — AECI-1224. Source of truth:
 * `ADMIN_PANEL_SPEC.md` §5.14 "Sending switches".
 *
 * What these tests hold in place:
 *
 *  1. **Only pausable templates get a control.** Always-on ones are listed with none.
 *  2. **A change goes through the confirmation**, and only the confirm calls the API.
 *  3. **The support copy has no control when EMAIL_BCC is unset** on this tier.
 *  4. **A 409 says someone else moved it, and reloads**, so the operator sees the truth.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminEmailSwitch, AdminEmailSwitchesResponse } from '@aeci/shared';

import { expectTitleFirstDialog } from '../../core/testing/title-first-dialog.harness';
import { AdminEmailApi } from './admin-email-api';
import { EmailSwitches } from './email-switches';

const sw = (key: string, over: Partial<AdminEmailSwitch> = {}): AdminEmailSwitch => ({
  key,
  kind: 'notification',
  summary: `Summary of ${key}.`,
  audience: 'operator',
  pausable: true,
  enabled: true,
  updated_at: null,
  updated_by: null,
  ...over,
});

function makeData(over: Partial<AdminEmailSwitchesResponse> = {}): AdminEmailSwitchesResponse {
  return {
    generated_at: '2026-10-02T12:00:00.000Z',
    environment: 'staging',
    support_copy_configured: true,
    switches: [
      sw('support-copy', { kind: 'support_copy', summary: null, audience: null }),
      sw('landing-feedback'),
      sw('digest-analytics', {
        enabled: false,
        updated_at: '2026-10-01T08:00:00.000Z',
        updated_by: '49dd03ee-1111-4000-8000-000000000001',
      }),
      sw('vendor-seat-invite', { pausable: false, audience: 'external' }),
      sw('claim-approved', { pausable: false, audience: 'external' }),
    ],
    ...over,
  };
}

interface Instance {
  pending: () => { target: AdminEmailSwitch; enabled: boolean } | null;
  reason: { set: (v: string) => void };
  failedMessage: () => string;
  confirmChange: () => Promise<void>;
}

const settle = () => new Promise((r) => setTimeout(r));

async function setup(
  opts: { data?: AdminEmailSwitchesResponse; load?: HttpErrorResponse; set?: unknown } = {},
) {
  const api = {
    switches: vi.fn(async () => {
      if (opts.load) throw opts.load;
      return structuredClone(opts.data ?? makeData());
    }),
    setSwitch: vi.fn(async (key: string, body: { enabled: boolean }) => {
      if (opts.set instanceof HttpErrorResponse) throw opts.set;
      if (opts.set instanceof Promise) await opts.set;
      return {
        switch: sw(key, {
          enabled: body.enabled,
          updated_at: '2026-10-02T12:01:00.000Z',
          updated_by: '49dd03ee-1111-4000-8000-000000000001',
        }),
        changed: true,
      };
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminEmailApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(EmailSwitches);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
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
  const instance = fixture.componentInstance as unknown as Instance;
  return { fixture, api, el, rerender, instance, announced };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.replace(/\s+/g, ' ').includes(text),
  );

/** Spartan closes after its 100 ms `closeDelay`. */
const closeDelay = () => new Promise((r) => setTimeout(r, 150));
const dialogEl = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialogButton = (text: string) => (dialogEl() ? button(dialogEl()!, text) : undefined);

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.replaceChildren());
});

describe('EmailSwitches on the console recipe (AECI-2128)', () => {
  it('shows each switch state as a console chip: Sending positive, Paused attention', async () => {
    const { el } = await setup();
    const [sending, paused] = [...el.querySelectorAll('tbody tr')];
    const chip = (row: Element) => row.querySelector('.aec-chip')!;
    expect(chip(sending!).textContent?.trim()).toBe('Sending');
    expect(chip(sending!).getAttribute('data-tone')).toBe('positive');
    expect(chip(paused!).textContent?.trim()).toBe('Paused');
    expect(chip(paused!).getAttribute('data-tone')).toBe('attention');
  });

  it('the row control is a compact secondary aecButton, the dialog confirm primary', async () => {
    const { el, rerender } = await setup();
    const pause = button(el, 'Pause landing-feedback')!;
    expect(pause.classList).toContain('aec-btn-secondary');
    pause.click();
    await rerender();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (b) => b.textContent?.includes('Pause sending'),
    )!;
    // Primary, not danger: Resume puts the switch back exactly (AECI-2128 severity rule).
    expect(confirm.classList).toContain('aec-btn');
    expect(confirm.classList).toContain('bg-(--accent-primary)');
    expect(confirm.classList).not.toContain('bg-(--status-error)');
  });
});

describe('EmailSwitches', () => {
  it('gives a control to pausable templates only', async () => {
    const { el } = await setup();
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual([
      expect.stringContaining('landing-feedback'),
      expect.stringContaining('digest-analytics'),
    ]);
    for (const row of rows) expect(row.querySelector('button')).not.toBeNull();
    // Always-on templates are listed, with no button anywhere near them.
    const details = el.querySelector('details')!;
    expect(details.textContent).toContain('vendor-seat-invite');
    expect(details.textContent).toContain('claim-approved');
    expect(details.textContent).toContain('(2)');
    expect(details.querySelector('button')).toBeNull();
  });

  it('shows each status, with when and by whom for a paused one', async () => {
    const { el } = await setup();
    const [sending, paused] = [...el.querySelectorAll('tbody tr')];
    expect(sending!.textContent).toContain('Sending');
    expect(paused!.textContent).toContain('Paused');
    const who = paused!.querySelector('a')!;
    expect(who.getAttribute('href')).toBe('/admin/users/49dd03ee-1111-4000-8000-000000000001');
    expect(who.textContent).toContain('49dd03ee');
  });

  it('names the template in each button for a screen reader', async () => {
    const { el } = await setup();
    const btn = el.querySelector('tbody tr button')!;
    expect(btn.querySelector('.sr-only')?.textContent).toContain('landing-feedback');
  });

  it('a Pause click opens the confirmation and calls nothing yet', async () => {
    const { el, api, instance } = await setup();
    button(el, 'Pause landing-feedback')!.click();
    expect(instance.pending()).toEqual(
      expect.objectContaining({
        enabled: false,
        target: expect.objectContaining({ key: 'landing-feedback' }),
      }),
    );
    expect(api.setSwitch).not.toHaveBeenCalled();
  });

  it('opens the confirmation as an alert dialog with focus on its title (AECI-1861)', async () => {
    const { el, rerender } = await setup();
    button(el, 'Pause landing-feedback')!.click();
    await rerender();
    await settle();
    expectTitleFirstDialog('Pause landing-feedback?');
  });

  it('confirming pauses it, with the reason, updates the row and announces', async () => {
    const { el, api, instance, rerender, announced } = await setup();
    button(el, 'Pause landing-feedback')!.click();
    instance.reason.set('  Spam wave  ');
    await instance.confirmChange();
    await rerender();
    await closeDelay();
    await rerender();

    expect(api.setSwitch).toHaveBeenCalledWith('landing-feedback', {
      enabled: false,
      reason: 'Spam wave',
    });
    expect(instance.pending()).toBeNull();
    expect(el.querySelector('tbody tr')!.textContent).toContain('Paused');
    expect(announced).toEqual(['landing-feedback is paused.']);
  });

  it('a Resume click on a paused template confirms a resume', async () => {
    const { el, api, instance } = await setup();
    button(el, 'Resume digest-analytics')!.click();
    expect(instance.pending()?.enabled).toBe(true);
    await instance.confirmChange();
    expect(api.setSwitch).toHaveBeenCalledWith('digest-analytics', { enabled: true });
  });

  it('offers the support copy switch when EMAIL_BCC is set', async () => {
    const { el, instance } = await setup();
    button(el, 'Pause the copy')!.click();
    expect(instance.pending()?.target.kind).toBe('support_copy');
  });

  it('shows no support copy control when EMAIL_BCC is unset on this tier', async () => {
    const { el } = await setup({ data: makeData({ support_copy_configured: false }) });
    expect(el.textContent).toContain('No support copy is set up on this tier');
    expect(button(el, 'Pause the copy')).toBeUndefined();
  });

  it('a 409 says someone else moved it, keeps the dialog open and reloads', async () => {
    const { el, api, instance, rerender } = await setup({
      set: new HttpErrorResponse({ status: 409 }),
    });
    button(el, 'Pause landing-feedback')!.click();
    await instance.confirmChange();
    await rerender();
    expect(instance.failedMessage()).toContain('Someone changed this switch');
    expect(instance.pending()).not.toBeNull();
    expect(api.switches).toHaveBeenCalledTimes(2);
  });

  it('cannot be closed while the save is in flight (AECI-2130)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { el, rerender, announced } = await setup({ set: gate });
    button(el, 'Pause landing-feedback')!.click();
    await rerender();
    dialogButton('Pause sending')!.click();
    await rerender();
    expect(dialogEl()!.textContent).toContain('Saving…');

    expect(dialogButton('Cancel')!.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialogEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    await closeDelay();
    await rerender();
    expect(dialogEl()).not.toBeNull();
    expect(announced).toEqual([]);

    release();
    await rerender();
    await closeDelay();
    await rerender();
    expect(dialogEl()).toBeNull();
    expect(announced).toEqual(['landing-feedback is paused.']);
  });

  it('a refused save keeps the dialog open and moves focus to its alert (AECI-2130)', async () => {
    const { el, rerender } = await setup({ set: new HttpErrorResponse({ status: 429 }) });
    button(el, 'Pause landing-feedback')!.click();
    await rerender();
    dialogButton('Pause sending')!.click();
    await rerender();
    await rerender();
    const alert = document.getElementById('admin-email-switch-failed');
    expect(alert?.textContent).toContain('Too many changes in a minute');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(alert);
    expect(dialogEl()).not.toBeNull();
  });

  it('a failed load shows its own alert with Try again', async () => {
    const { el, api, rerender } = await setup({ load: new HttpErrorResponse({ status: 500 }) });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load the sending switches.",
    );
    button(el, 'Try again')!.click();
    await rerender();
    expect(api.switches).toHaveBeenCalledTimes(2);
  });
});
