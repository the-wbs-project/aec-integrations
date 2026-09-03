/**
 * AECI-606 — `VendorNotificationsList`: §7.2's in-portal list, rendered on the
 * §6 tab.
 *
 * These rows are a 90-day archive of what was **emailed**, not live state, so
 * the load-bearing assertions are that it stays collapsed and says so, and that
 * the ops-only `aeci-denied` detector can never surface with an empty title.
 *
 * AECI-631 adds the "N new" count (`STAGE_2_REALTIME_SPEC.md` §6.2). Its
 * assertions are mostly about what the count must NOT become: it starts at zero,
 * it is a count on the summary line and not a banner, and it never claims
 * anything about state — only about this session.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorNotification } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_NOTIFICATIONS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

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
      VendorPortalStore,
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

/**
 * AECI-631 / §6.2 — the session-scoped "N new" count.
 *
 * Rule 2 is binding: these rows are historical, so the ONLY honest claim is
 * about this session. Every case below is a way of pinning that boundary.
 */
describe('VendorNotificationsList — "N new" (§6.2)', () => {
  /** A row that did not exist at first load. */
  const arrival = (id: string): VendorNotification => ({
    ...VENDOR_NOTIFICATIONS_FIXTURE[0],
    id,
    created_at: '2026-08-19T08:00:00.000Z',
  });

  const summary = (fixture: ComponentFixture<VendorNotificationsList>) =>
    el(fixture).querySelector('summary')?.textContent ?? '';

  /** What the §4 poll does: refetch the resource behind this section. */
  async function poll(
    fixture: ComponentFixture<VendorNotificationsList>,
    notifications: readonly VendorNotification[],
  ): Promise<void> {
    getNotifications.mockResolvedValue({ notifications });
    await TestBed.inject(VendorPortalStore).revalidate(['notifications']);
    fixture.detectChanges();
  }

  it('starts at zero: a first load is never "new", however much it contains', async () => {
    const fixture = await create();

    expect(summary(fixture)).toContain('(3)');
    expect(summary(fixture)).not.toContain('new');
  });

  it('counts only what arrived after that baseline', async () => {
    const fixture = await create();
    await poll(fixture, [arrival('row-4'), ...VENDOR_NOTIFICATIONS_FIXTURE]);

    expect(summary(fixture)).toContain('(4)');
    expect(summary(fixture)).toContain('1 new');
  });

  it('does not re-baseline on a later poll, so an unread count keeps accumulating', async () => {
    const fixture = await create();
    await poll(fixture, [arrival('row-4'), ...VENDOR_NOTIFICATIONS_FIXTURE]);
    await poll(fixture, [arrival('row-5'), arrival('row-4'), ...VENDOR_NOTIFICATIONS_FIXTURE]);

    expect(summary(fixture)).toContain('2 new');
  });

  it('survives the tab switch that destroys this component', async () => {
    // The disclosure lives inside the Integrations tab, and the shell's @switch
    // destroys it whenever the vendor looks at Products. A baseline captured in
    // the component would re-capture on the way back — from a list that by then
    // already holds the arrival — and the count would silently read zero.
    const first = await create();
    await poll(first, [arrival('row-4'), ...VENDOR_NOTIFICATIONS_FIXTURE]);
    first.destroy();

    const second = await create();
    expect(summary(second)).toContain('1 new');
  });

  it('baselines an empty archive too, so the first ever nudge counts', async () => {
    getNotifications.mockResolvedValue({ notifications: [] });
    const fixture = await create();
    expect(summary(fixture)).not.toContain('new');

    await poll(fixture, [arrival('row-1')]);
    expect(summary(fixture)).toContain('1 new');
  });

  it('is a count on the summary line, never a banner and never an auto-expand', async () => {
    const fixture = await create();
    await poll(fixture, [arrival('row-4'), ...VENDOR_NOTIFICATIONS_FIXTURE]);

    // Nothing outside the collapsed disclosure mentions it, the disclosure does
    // not open itself, and it is not announced: a historical row promoted to an
    // interruption is exactly the self-contradiction §6.2 forbids.
    const details = el(fixture).querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(
      el(fixture).querySelectorAll('[role="status"], [role="alert"], [aria-live]'),
    ).toHaveLength(0);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toBe('');

    const outside = (el(fixture).textContent ?? '').replace(details?.textContent ?? '', '');
    expect(outside).not.toContain('new');
  });

  it('ignores the ops-only detector in the count, as it does in the total', async () => {
    const fixture = await create();
    await poll(fixture, [
      { ...arrival('ops-row'), detector: 'aeci-denied' },
      ...VENDOR_NOTIFICATIONS_FIXTURE,
    ]);

    expect(summary(fixture)).toContain('(3)');
    expect(summary(fixture)).not.toContain('new');
  });
});
