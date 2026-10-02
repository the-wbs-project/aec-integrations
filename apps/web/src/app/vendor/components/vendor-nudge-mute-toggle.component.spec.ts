/**
 * `VendorNudgeMuteToggle` (AECI-1204) — the per-seat switch for the daily reminder
 * email on the Messages page. Pinned: the switch semantics (ON means "email me"),
 * its accessible name and description, the optimistic flip, the visible rollback
 * on a failed save, and that nothing is fetched or written before the first render.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationPreferencesResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorNudgeMuteToggle } from './vendor-nudge-mute-toggle';

const UNMUTED: NotificationPreferencesResponse = { nudges_muted: false, nudges_muted_at: null };
const MUTED: NotificationPreferencesResponse = {
  nudges_muted: true,
  nudges_muted_at: '2026-09-30T10:00:00.000Z',
};

/** Macrotask boundary: drains the awaited API promises. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

let api: {
  getNotificationPreferences: ReturnType<typeof vi.fn>;
  updateNotificationPreferences: ReturnType<typeof vi.fn>;
};
let announce: ReturnType<typeof vi.fn>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getNotificationPreferences: vi.fn().mockResolvedValue(UNMUTED),
    updateNotificationPreferences: vi.fn(),
  };
  announce = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: api },
      { provide: VendorPortalAnnouncer, useValue: { announce } },
    ],
  });
});

async function create(): Promise<ComponentFixture<VendorNudgeMuteToggle>> {
  const fixture = TestBed.createComponent(VendorNudgeMuteToggle);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const sw = (f: ComponentFixture<unknown>) =>
  el(f).querySelector<HTMLButtonElement>('[data-testid="nudge-mute-switch"]')!;
const status = (f: ComponentFixture<unknown>) =>
  el(f)
    .querySelector('[data-testid="nudge-mute-status"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();

describe('VendorNudgeMuteToggle', () => {
  it('is a named, described switch that reads ON (email me) when not muted', async () => {
    const fixture = await create();
    const button = sw(fixture);

    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(status(fixture)).toBe('On');

    const label = el(fixture).querySelector(`#${button.getAttribute('aria-labelledby')}`);
    expect(label?.textContent?.trim()).toBe('Daily reminder email');
    const description = el(fixture).querySelector(`#${button.getAttribute('aria-describedby')}`);
    // The scope the switch promises: this seat only, nudges only.
    expect(description?.textContent).toContain('your seat only');
    expect(description?.textContent).toContain('still arrive');
  });

  it('reads OFF with the mute date when the seat is muted', async () => {
    api.getNotificationPreferences.mockResolvedValue(MUTED);
    const fixture = await create();

    expect(sw(fixture).getAttribute('aria-checked')).toBe('false');
    expect(status(fixture)).toMatch(/^Off since Sep 30, 2026$/);
  });

  it('shows no switch until the saved state is known, only a placeholder', () => {
    api.getNotificationPreferences.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(VendorNudgeMuteToggle);
    fixture.detectChanges();
    expect(sw(fixture)).toBeNull();
    expect(el(fixture).querySelector('[data-testid="nudge-mute-placeholder"]')).not.toBeNull();
  });

  it('flips at once, saves the mute, and announces it', async () => {
    let resolve!: (v: NotificationPreferencesResponse) => void;
    api.updateNotificationPreferences.mockReturnValue(new Promise((r) => (resolve = r)));
    const fixture = await create();

    sw(fixture).click();
    fixture.detectChanges();
    // Optimistic: the switch is already OFF while the PUT is in flight.
    expect(sw(fixture).getAttribute('aria-checked')).toBe('false');
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith(true);

    resolve(MUTED);
    await settle();
    fixture.detectChanges();
    expect(sw(fixture).getAttribute('aria-checked')).toBe('false');
    expect(announce).toHaveBeenCalledWith('Daily reminder email muted for your seat.');
  });

  it('ignores a second click while a save is in flight', async () => {
    api.updateNotificationPreferences.mockReturnValue(new Promise(() => undefined));
    const fixture = await create();

    sw(fixture).click();
    sw(fixture).click();
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);
  });

  it('rolls back with a visible error when the save fails', async () => {
    api.updateNotificationPreferences.mockRejectedValue(new Error('500'));
    const fixture = await create();

    sw(fixture).click();
    await settle();
    fixture.detectChanges();

    expect(sw(fixture).getAttribute('aria-checked')).toBe('true');
    const error = el(fixture).querySelector('[data-testid="nudge-mute-error"]');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('Your setting has not changed');
    expect(announce).not.toHaveBeenCalled();
  });

  it('turns the email back on', async () => {
    api.getNotificationPreferences.mockResolvedValue(MUTED);
    api.updateNotificationPreferences.mockResolvedValue(UNMUTED);
    const fixture = await create();

    sw(fixture).click();
    await settle();
    fixture.detectChanges();

    expect(api.updateNotificationPreferences).toHaveBeenCalledWith(false);
    expect(sw(fixture).getAttribute('aria-checked')).toBe('true');
    expect(announce).toHaveBeenCalledWith('Daily reminder email turned on for your seat.');
  });

  it('shows no switch and offers a retry when the read fails', async () => {
    api.getNotificationPreferences.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();

    expect(sw(fixture)).toBeNull();
    const retry = [...el(fixture).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Try again',
    )!;
    retry.click();
    await settle();
    fixture.detectChanges();
    expect(sw(fixture)).not.toBeNull();
    expect(api.getNotificationPreferences).toHaveBeenCalledTimes(2);
  });
});
