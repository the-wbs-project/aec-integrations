/**
 * "Pending brand-asset removals" (AECI-1618). What has to hold: every date comes from the
 * API; a hold and a lift each need a reason; a stale list says so; the empty and failed
 * reads read like the rest of the console.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrandAssetRemoval } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { BrandAssetRemovals } from './brand-asset-removals';

const VENDOR = '00000000-0000-4000-8000-000000000010';

function row(over: Partial<BrandAssetRemoval> = {}): BrandAssetRemoval {
  return {
    vendor_id: VENDOR,
    vendor_slug: 'agave',
    company_name: 'Agave',
    claim_ended_at: '2026-11-01T10:00:00.000Z',
    cause: 'last-seat-revoked',
    hold_at: null,
    limit_at: '2026-11-15T16:00:00.000Z',
    next_run_at: '2026-11-02T16:00:00.000Z',
    affected_rows: [
      {
        entity_type: 'vendor',
        id: VENDOR,
        slug: 'agave',
        name: 'Agave',
        logo_url: 'https://example.com/a.png',
        sourced_logo_url: 'https://example.com/b.png',
      },
      {
        entity_type: 'product',
        id: '00000000-0000-4000-8000-000000000011',
        slug: 'agave-sync',
        name: 'Agave Sync',
        logo_url: 'https://example.com/c.png',
        sourced_logo_url: null,
      },
    ],
    skipped_product_ids: ['00000000-0000-4000-8000-000000000012'],
    ...over,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('BrandAssetRemovals', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function mount(rows: BrandAssetRemoval[] | Error) {
    const api = {
      listBrandAssetRemovals: vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { data: rows };
      }),
      holdBrandAssets: vi.fn(async () => ({ vendor_id: VENDOR, hold_at: '2026-11-02T00:00:00Z' })),
      liftBrandAssetHold: vi.fn(async () => ({ vendor_id: VENDOR, hold_at: null })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AdminVendorsApi, useValue: api },
      ],
    });
    const fixture = TestBed.createComponent(BrandAssetRemovals);
    const announced: string[] = [];
    fixture.componentInstance.announce.subscribe((m) => announced.push(m));
    fixture.detectChanges();
    await settle();
    await fixture.whenStable();
    return { fixture, api, announced, el: fixture.nativeElement as HTMLElement };
  }

  async function submitForm(fixture: { whenStable(): Promise<unknown> }, el: HTMLElement) {
    el.querySelector<HTMLFormElement>('[data-testid="brand-asset-hold-form"]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();
    await fixture.whenStable();
  }

  function type(el: HTMLElement, value: string): void {
    const box = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="brand-asset-hold-form"] textarea',
    )!;
    box.value = value;
    box.dispatchEvent(new Event('input'));
  }

  it('lists claim end, cause, rows, next run and the limit from the API', async () => {
    const { el } = await mount([row()]);
    const text = el.querySelector('tbody')!.textContent!;
    expect(text).toContain('Agave');
    expect(text).toContain('Nov 1, 2026');
    expect(text).toContain('Last seat revoked');
    expect(text).toContain('Agave Sync');
    expect(text).toContain('The AECi logo returns');
    expect(text).toContain('The initial tile shows');
    expect(text).toContain('1 co-owned product skipped');
    expect(text).toContain('Nov 2, 2026, 16:00 UTC');
    expect(text).toContain('Nov 15, 2026, 16:00 UTC');
  });

  it('shows an empty line, and a failed read with a retry', async () => {
    const empty = await mount([]);
    expect(empty.el.textContent).toContain('No removals are pending.');
    TestBed.resetTestingModule();
    const failed = await mount(new Error('boom'));
    expect(failed.el.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load the pending removals.",
    );
  });

  it('refuses a hold with no reason and sends nothing', async () => {
    const { fixture, el, api } = await mount([row()]);
    el.querySelector<HTMLButtonElement>('tbody td:last-child button')!.click();
    await fixture.whenStable();
    await submitForm(fixture, el);
    expect(api.holdBrandAssets).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Write a reason first.');
  });

  it('holds with a reason, announces, and reloads the list', async () => {
    const { fixture, el, api, announced } = await mount([row()]);
    el.querySelector<HTMLButtonElement>('tbody td:last-child button')!.click();
    await fixture.whenStable();
    type(el, 'Counsel asked us to wait.');
    await submitForm(fixture, el);
    expect(api.holdBrandAssets).toHaveBeenCalledWith(VENDOR, 'Counsel asked us to wait.', '');
    expect(api.listBrandAssetRemovals).toHaveBeenCalledTimes(2);
    expect(announced).toEqual(['Removal held.']);
    expect(el.querySelector('[data-testid="brand-asset-hold-form"]')).toBeNull();
  });

  it('a held row offers a lift, which also takes a reason', async () => {
    const { fixture, el, api } = await mount([row({ hold_at: '2026-11-01T12:00:00.000Z' })]);
    expect(el.querySelector('tbody')!.textContent).toContain('Held since Nov 1, 2026');
    el.querySelector<HTMLButtonElement>('tbody td:last-child button')!.click();
    await fixture.whenStable();
    type(el, 'Counsel cleared it.');
    await submitForm(fixture, el);
    expect(api.liftBrandAssetHold).toHaveBeenCalledWith(VENDOR, 'Counsel cleared it.', '');
  });

  it('a 409 keeps the form open with its reason', async () => {
    const { fixture, el, api } = await mount([row()]);
    api.holdBrandAssets.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'BRAND_ASSETS_NOT_PENDING' } },
      }),
    );
    el.querySelector<HTMLButtonElement>('tbody td:last-child button')!.click();
    await fixture.whenStable();
    type(el, 'Counsel asked us to wait.');
    await submitForm(fixture, el);
    expect(
      el.querySelector('[data-testid="brand-asset-hold-form"] [role="alert"]')?.textContent,
    ).toContain('no removal pending');
  });
});
