/**
 * AECI-606 — `VendorNotificationsList`: §7.2's in-portal list, rendered on the
 * §6 tab.
 *
 * These rows are a 90-day archive of what was **emailed**, not live state, so
 * the load-bearing assertions are that it stays collapsed and says so, and that
 * the ops-only `aeci-denied` detector can never surface with an empty title.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorNotification } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_NOTIFICATIONS_FIXTURE } from '../vendor-fixtures';

import { VendorNotificationsList } from './vendor-notifications-list';

let getNotifications: ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  getNotifications = vi.fn().mockResolvedValue({ notifications: VENDOR_NOTIFICATIONS_FIXTURE });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: { getNotifications } as Partial<VendorApi> },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function create(): Promise<ComponentFixture<VendorNotificationsList>> {
  const fixture = TestBed.createComponent(VendorNotificationsList);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ComponentFixture<VendorNotificationsList>) =>
  fixture.nativeElement as HTMLElement;
const text = (fixture: ComponentFixture<VendorNotificationsList>) => el(fixture).textContent ?? '';

describe('VendorNotificationsList', () => {
  it('is a collapsed disclosure that frames the rows as historical', async () => {
    const fixture = await create();

    // Rendered prominently, a three-week-old "Vendors disagree" row would sit
    // above a lane whose badge now reads `confirmed`.
    expect(el(fixture).querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(text(fixture)).toContain('last 90 days');
    expect(text(fixture)).toContain('state at the time it was sent');
  });

  it('renders one row per vendor-facing detector, with its title', async () => {
    const body = text(await create());
    expect(body).toContain('Vendors disagree about this flow');
    expect(body).toContain('Waiting on the other vendor');
    expect(body).toContain('Time to re-confirm this flow');
  });

  it('counts only vendor-facing rows in the summary', async () => {
    const fixture = await create();
    expect(el(fixture).querySelector('summary')?.textContent).toContain('(3)');
  });

  it('filters out the ops-only `aeci-denied` detector', async () => {
    // Its ledger rows carry `vendorId: null`, so the endpoint can never return
    // one — but a routing change must not surface an internal correction alert
    // with an empty title.
    const withOps: readonly VendorNotification[] = [
      ...VENDOR_NOTIFICATIONS_FIXTURE,
      { ...VENDOR_NOTIFICATIONS_FIXTURE[0], id: 'ops-row', detector: 'aeci-denied' },
    ];
    getNotifications.mockResolvedValue({ notifications: withOps });

    const fixture = await create();
    expect(el(fixture).querySelectorAll('li')).toHaveLength(3);
    expect(el(fixture).querySelector('summary')?.textContent).toContain('(3)');
  });

  it('renders a row whose snapshot lost its data object and pair path', async () => {
    // The tolerant-mapper case: these rows outlive the code that wrote them.
    const fixture = await create();
    const rows = [...el(fixture).querySelectorAll('li')];
    const degraded = rows[2];
    expect(degraded.textContent).toContain('Time to re-confirm this flow');
    expect(degraded.querySelector('a')).toBeNull();
  });

  it('links a row that has a pair path', async () => {
    const fixture = await create();
    const link = el(fixture).querySelector('a');
    expect(link?.getAttribute('href')).toBe(
      '/products/procore/integrations/summit-model-coordination',
    );
  });

  it('shows an empty state when nothing was sent', async () => {
    getNotifications.mockResolvedValue({ notifications: [] });
    expect(text(await create())).toContain('No notifications in the last 90 days');
  });

  it('offers a retry when the read fails', async () => {
    getNotifications.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();

    expect(text(fixture)).toContain('Could not load your notifications');
    const retry = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Try again'),
    );
    retry!.click();
    await flush();
    fixture.detectChanges();

    expect(el(fixture).querySelectorAll('li').length).toBe(3);
  });
});
