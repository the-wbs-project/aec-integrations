/**
 * AECI-2046 — the Sync Service facts form on the Products tab of `/admin/vendors/:id`.
 * Three inputs, then an explicit Save, over `PATCH /api/admin/products/:id/sync-facts`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncFacts } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { SyncFactsControl } from './sync-facts-control';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000031';
const EMPTY: SyncFacts = {
  sync_frequency: null,
  sync_support: null,
  sync_setup: null,
  source_url: null,
  recorded_at: null,
};

let api: { setSyncFacts: ReturnType<typeof vi.fn> };

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    setSyncFacts: vi.fn(async (id: string, facts: Omit<SyncFacts, 'recorded_at'>) => ({
      id,
      ...facts,
      recorded_at: '2026-11-24T00:00:00.000Z',
      changed: true,
    })),
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminVendorsApi, useValue: api }],
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(facts: SyncFacts = EMPTY) {
  const fixture = TestBed.createComponent(SyncFactsControl);
  fixture.componentRef.setInput('productId', PRODUCT_ID);
  fixture.componentRef.setInput('productName', 'Rivets Sync');
  fixture.componentRef.setInput('facts', facts);
  const saved = vi.fn();
  const announce = vi.fn();
  fixture.componentInstance.saved.subscribe(saved);
  fixture.componentInstance.announce.subscribe(announce);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const input = (key: Exclude<keyof SyncFacts, 'recorded_at'>) =>
    el.querySelector<HTMLInputElement>(`#sync-facts-${key}-${PRODUCT_ID}`)!;
  const type = (key: Exclude<keyof SyncFacts, 'recorded_at'>, value: string) => {
    input(key).value = value;
    input(key).dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const saveButton = () => el.querySelector<HTMLButtonElement>('button')!;
  return { fixture, el, input, type, saveButton, saved, announce };
}

describe('SyncFactsControl', () => {
  it('labels each input, shows the stored values and keeps Save off until one changes', async () => {
    const { el, input, saveButton } = await setup({
      ...EMPTY,
      sync_frequency: 'Every 15 minutes',
    });
    expect(el.querySelector('legend')!.textContent).toContain('Sync Service facts');
    for (const label of [
      'How often it syncs',
      'Who supports it',
      'How setup works',
      'Source link (https)',
    ]) {
      const node = [...el.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!;
      expect(node, label).toBeTruthy();
      expect(el.querySelector(`#${node.getAttribute('for')}`)).toBeTruthy();
    }
    expect(input('sync_frequency').value).toBe('Every 15 minutes');
    expect(input('sync_setup').getAttribute('maxlength')).toBe('280');
    expect(saveButton().disabled).toBe(true);
  });

  it('saves the trimmed set, blanks as null, announces it and tells the host', async () => {
    const { fixture, type, saveButton, saved, announce } = await setup();
    type('sync_frequency', '  Hourly  ');
    type('sync_support', '   ');
    type('source_url', ' https://example.com/sync ');
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    await fixture.whenStable();
    expect(api.setSyncFacts).toHaveBeenCalledWith(PRODUCT_ID, {
      sync_frequency: 'Hourly',
      sync_support: null,
      sync_setup: null,
      source_url: 'https://example.com/sync',
    });
    expect(saved).toHaveBeenCalledWith({
      sync_frequency: 'Hourly',
      sync_support: null,
      sync_setup: null,
      source_url: 'https://example.com/sync',
      recorded_at: '2026-11-24T00:00:00.000Z',
    });
    expect(announce).toHaveBeenCalledWith('Sync Service facts for Rivets Sync saved.');
  });

  it('keeps Save off when only spaces were added around a stored value', async () => {
    const { type, saveButton } = await setup({ ...EMPTY, sync_setup: 'A call' });
    type('sync_setup', '  A call ');
    expect(saveButton().disabled).toBe(true);
  });

  it('says the product is no longer a Sync Service on a 409', async () => {
    api.setSyncFacts.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'SYNC_FACTS_NOT_SYNC_SERVICE' } },
      }),
    );
    const { fixture, el, type, saveButton, saved } = await setup();
    type('sync_frequency', 'Daily');
    saveButton().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('no longer a Sync Service');
    expect(saved).not.toHaveBeenCalled();
  });
});
