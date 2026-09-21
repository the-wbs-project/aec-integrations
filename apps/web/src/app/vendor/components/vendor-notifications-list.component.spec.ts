/**
 * AECI-606 — `VendorNotificationsList`: §7.2's in-portal list, rendered on the
 * §6 tab.
 *
 * These rows are a 90-day archive of what was **emailed**, not live state, so
 * the load-bearing assertions are that it stays collapsed and says so, and that
 * every detector the endpoint can return has a title.
 *
 * AECI-961 renamed `aeci-denied` to `claim-denied` and gave it a counterparty
 * finding, so it is now a vendor-visible row rather than an ops-only one that had
 * to be filtered out. The filter that remains is on the empty title, not on the
 * detector name.
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

import type { VendorAttestationNotification, VendorNotification } from '@aeci/shared';

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

  it.each([
    ['submitted', 'Another vendor contested a field on your integration'],
    ['withdrawn', 'A contest on your integration was withdrawn'],
    ['accepted', 'Your contest was accepted'],
    ['declined', 'Your contest was declined'],
  ] as const)('renders a contest `%s` row with its own title (AECI-1008)', async (event, title) => {
    const withContest: readonly VendorNotification[] = [
      ...VENDOR_NOTIFICATIONS_FIXTURE,
      {
        kind: 'contest',
        id: '00000000-0000-4000-8000-00000000c0de',
        event,
        contest_id: '00000000-0000-4000-8000-00000000c0df',
        integration_id: '00000000-0000-4000-8000-00000000c0e0',
        integration_name: 'Summit ↔ Procore',
        field: 'docs_url',
        pair_path: '/products/procore/integrations/summit',
        created_at: '2026-09-18T12:00:00.000Z',
      },
    ];
    getNotifications.mockResolvedValue({ notifications: withContest });

    const fixture = await create();
    const items = [...el(fixture).querySelectorAll('li')];
    expect(items).toHaveLength(4);
    const row = items.find((li) => li.textContent?.includes(title));
    expect(row).toBeDefined();
    // The field is named as a vendor reads it, then the integration.
    expect(row!.textContent).toContain('Documentation link');
    expect(row!.textContent).toContain('Summit ↔ Procore');
    expect(row!.querySelector('a')?.getAttribute('href')).toBe(
      '/products/procore/integrations/summit',
    );
    expect(el(fixture).querySelector('summary')?.textContent).toContain('(4)');
  });

  it('renders an integration claim row, naming the owner and the integration (AECI-1005)', async () => {
    const withClaim: readonly VendorNotification[] = [
      ...VENDOR_NOTIFICATIONS_FIXTURE,
      {
        kind: 'integration_claim',
        id: '00000000-0000-4000-8000-00000000c1a1',
        integration_id: '00000000-0000-4000-8000-00000000c1a2',
        integration_name: 'Summit ↔ Procore',
        owner_name: 'Summit Software',
        pair_path: '/products/procore/integrations/summit',
        created_at: '2026-09-21T12:00:00.000Z',
      },
    ];
    getNotifications.mockResolvedValue({ notifications: withClaim });

    const fixture = await create();
    const row = [...el(fixture).querySelectorAll('li')].find((li) =>
      li.textContent?.includes('The owner claimed an integration on your product'),
    );
    expect(row).toBeDefined();
    expect(row!.textContent).toContain('Summit Software');
    expect(row!.textContent).toContain('Summit ↔ Procore');
    expect(row!.querySelector('a')?.getAttribute('href')).toBe(
      '/products/procore/integrations/summit',
    );
    expect(el(fixture).querySelector('summary')?.textContent).toContain('(4)');
  });

  it('renders and counts a `claim-denied` row (AECI-961)', async () => {
    // It used to be filtered out: the detector was ops-only, so a row reaching a
    // vendor would have had no title. It now carries a counterparty finding, and
    // the vendor is the party that most needs to read it.
    const withDenial: readonly VendorAttestationNotification[] = [
      ...VENDOR_NOTIFICATIONS_FIXTURE,
      { ...VENDOR_NOTIFICATIONS_FIXTURE[0], id: 'denied-row', detector: 'claim-denied' },
    ];
    getNotifications.mockResolvedValue({ notifications: withDenial });

    const fixture = await create();
    expect(el(fixture).querySelectorAll('li')).toHaveLength(4);
    expect(el(fixture).textContent).toContain('The other vendor says this flow does not exist');
    expect(el(fixture).querySelector('summary')?.textContent).toContain('(4)');
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
  const arrival = (id: string): VendorAttestationNotification => ({
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

  it('counts an arriving `claim-denied` row like any other (AECI-961)', async () => {
    const fixture = await create();
    await poll(fixture, [
      { ...arrival('denied-row'), detector: 'claim-denied' },
      ...VENDOR_NOTIFICATIONS_FIXTURE,
    ]);

    expect(summary(fixture)).toContain('(4)');
    expect(summary(fixture)).toContain('new');
  });
});
