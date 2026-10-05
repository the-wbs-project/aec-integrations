/**
 * AECI-1160 — the portal Changes page (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.19):
 * one row per actor kind, the AECi reason only when present, the filter refetch,
 * the empty state and the CSV link.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorHistoryItem } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_HISTORY_FIXTURE, historyKindKeeps } from '../vendor-history-fixtures';

import { VENDOR_HISTORY_PAGE_SIZE, VendorHistoryPage } from './vendor-history-page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

function page(items: readonly VendorHistoryItem[], total = items.length) {
  return { data: [...items], page: 1, perPage: VENDOR_HISTORY_PAGE_SIZE, total };
}

const byActor = (kind: VendorHistoryItem['actor_kind']) =>
  VENDOR_HISTORY_FIXTURE.find((r) => r.actor_kind === kind)!;
const AECI_WITH_REASON = VENDOR_HISTORY_FIXTURE.find((r) => r.actor_kind === 'aeci' && r.reason)!;
const AECI_NO_REASON = VENDOR_HISTORY_FIXTURE.find((r) => r.actor_kind === 'aeci' && !r.reason)!;

let api: { listHistory: ReturnType<typeof vi.fn> };

beforeEach(() => {
  TestBed.resetTestingModule();
  api = { listHistory: vi.fn().mockResolvedValue(page(VENDOR_HISTORY_FIXTURE)) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(): Promise<ComponentFixture<VendorHistoryPage>> {
  const fixture = TestBed.createComponent(VendorHistoryPage);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const row = (fixture: ComponentFixture<unknown>, item: VendorHistoryItem) =>
  el(fixture).querySelector<HTMLElement>(`[data-history-row="${item.id}"]`)!;
const text = (scope: HTMLElement, selector: string) =>
  scope.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

describe('VendorHistoryPage — rows', () => {
  it('reads page one of every change', async () => {
    await create();
    expect(api.listHistory).toHaveBeenCalledWith(1, VENDOR_HISTORY_PAGE_SIZE, { kind: 'all' });
  });

  it('names who made each change, per actor kind', async () => {
    const fixture = await create();
    expect(text(row(fixture, byActor('your_team')), '[data-history-actor]')).toBe('Your team');
    expect(text(row(fixture, byActor('aeci')), '[data-history-actor]')).toBe('AECi');
    expect(text(row(fixture, byActor('system')), '[data-history-actor]')).toBe('System');
  });

  it('says what happened in plain words, with the entity and the humanized fields', async () => {
    const fixture = await create();
    const r = row(fixture, byActor('your_team'));
    expect(text(r, '[data-history-action]')).toBe('Product listing updated');
    expect(text(r, '[data-history-entity]')).toBe('Summit Model Coordination');
    expect(text(r, '[data-history-fields]')).toContain('Description, Website URL, Logo URL');
    expect(text(r, '[data-history-plan]')).toContain('Managed');
    expect(r.querySelector('time')?.getAttribute('datetime')).toBe(byActor('your_team').at);
  });

  it('omits the plan when the row has no snapshot', async () => {
    const fixture = await create();
    const noPlan = VENDOR_HISTORY_FIXTURE.find((r) => r.plan === null)!;
    expect(row(fixture, noPlan).querySelector('[data-history-plan]')).toBeNull();
  });

  it('shows the reason from AECi only when the row carries one', async () => {
    const fixture = await create();
    const withReason = row(fixture, AECI_WITH_REASON);
    expect(text(withReason, '[data-history-reason]')).toContain('Reason from AECi');
    expect(text(withReason, '[data-history-reason]')).toContain(AECI_WITH_REASON.reason!);
    expect(row(fixture, AECI_NO_REASON).querySelector('[data-history-reason]')).toBeNull();
    expect(row(fixture, byActor('your_team')).querySelector('[data-history-reason]')).toBeNull();
  });

  it('keeps an empty follow-up slot on every row until AECI-1187', async () => {
    const fixture = await create();
    const slots = el(fixture).querySelectorAll('[data-history-follow-up]');
    expect(slots).toHaveLength(VENDOR_HISTORY_FIXTURE.length);
    expect([...slots].every((s) => s.textContent?.trim() === '')).toBe(true);
  });

  it('carries the banner, and never claims indexing or ranking', async () => {
    const fixture = await create();
    const banner = text(el(fixture), '[data-history-banner]')!;
    expect(banner).toContain('when change history began');
    expect(banner).toContain('Search engines decide');
    const all = el(fixture).textContent!.toLowerCase();
    expect(all).not.toContain('indexed');
    expect(all).not.toContain('ranked');
  });
});

describe('VendorHistoryPage — filter, CSV, empty', () => {
  it('refetches page one when the filter changes, and the CSV link follows it', async () => {
    const fixture = await create();
    expect(el(fixture).querySelector('[data-history-csv]')?.getAttribute('href')).toBe(
      '/api/vendor/history.csv',
    );

    api.listHistory.mockResolvedValue(page([byActor('aeci')]));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);

    expect(api.listHistory).toHaveBeenLastCalledWith(1, VENDOR_HISTORY_PAGE_SIZE, {
      kind: 'aeci',
    });
    expect(el(fixture).querySelector('[data-kind="aeci"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(el(fixture).querySelector('[data-history-csv]')?.getAttribute('href')).toBe(
      '/api/vendor/history.csv?kind=aeci',
    );

    el(fixture).querySelector<HTMLButtonElement>('[data-kind="vendor"]')!.click();
    await settle(fixture);
    expect(api.listHistory).toHaveBeenLastCalledWith(1, VENDOR_HISTORY_PAGE_SIZE, {
      kind: 'vendor',
    });
  });

  it('shows the empty state when there is no history', async () => {
    api.listHistory.mockResolvedValue(page([]));
    const fixture = await create();
    expect(text(el(fixture), '[data-history-empty]')).toContain('No changes yet');
    expect(el(fixture).querySelector('[data-history-row]')).toBeNull();
  });

  it('says a filtered empty list is the filter', async () => {
    const fixture = await create();
    api.listHistory.mockResolvedValue(page([]));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="vendor"]')!.click();
    await settle(fixture);
    expect(text(el(fixture), '[data-history-empty]')).toContain('No change matches');
  });

  it('pages forward', async () => {
    api.listHistory.mockResolvedValue(page(VENDOR_HISTORY_FIXTURE, 60));
    const fixture = await create();
    expect(text(el(fixture), '[data-history-page]')).toBe('Page 1 of 3');
    const next = [...el(fixture).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Next',
    )!;
    next.click();
    await settle(fixture);
    expect(api.listHistory).toHaveBeenLastCalledWith(2, VENDOR_HISTORY_PAGE_SIZE, {
      kind: 'all',
    });
  });

  it('offers a retry when the first read fails', async () => {
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    const fixture = await create();
    expect(el(fixture).querySelector('[data-history-failed]')).not.toBeNull();
  });
});

const pressed = (fixture: ComponentFixture<unknown>) =>
  el(fixture).querySelector('[aria-pressed="true"]')?.getAttribute('data-kind') ?? null;
const button = (fixture: ComponentFixture<unknown>, label: string) =>
  [...el(fixture).querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('VendorHistoryPage — screen readers', () => {
  it('announces the first-load failure as an alert', async () => {
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    const fixture = await create();
    const alert = el(fixture).querySelector('[data-history-failed] [role="alert"]');
    expect(alert?.textContent).toContain('Could not load your change history.');
  });

  it('announces a failed refresh as an alert', async () => {
    const fixture = await create();
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);
    const alert = el(fixture).querySelector('[data-history-refresh-failed] [role="alert"]');
    expect(alert?.textContent).toContain('Could not refresh the list.');
  });

  it('announces a finished filter change and page change politely', async () => {
    api.listHistory.mockResolvedValue(page(VENDOR_HISTORY_FIXTURE, 60));
    const fixture = await create();
    const announcer = TestBed.inject(VendorPortalAnnouncer);
    expect(announcer.message()).toBe('');

    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);
    expect(announcer.message().trim()).toBe('AECi changes, page 1 of 3.');

    button(fixture, 'Next').click();
    await settle(fixture);
    expect(announcer.message().trim()).toBe('AECi changes, page 2 of 3.');
  });

  it('announces an empty filter result', async () => {
    const fixture = await create();
    api.listHistory.mockResolvedValue(page([]));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="vendor"]')!.click();
    await settle(fixture);
    expect(TestBed.inject(VendorPortalAnnouncer).message().trim()).toBe(
      "Your team's edits: no changes to show.",
    );
  });
});

describe('VendorHistoryPage — a failed refresh keeps the controls honest', () => {
  it('keeps the old chip pressed and the old CSV filter when a filter read fails', async () => {
    const fixture = await create();
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);

    expect(el(fixture).querySelector('[data-history-refresh-failed]')).not.toBeNull();
    expect(pressed(fixture)).toBe('all');
    expect(el(fixture).querySelector('[data-history-csv]')?.getAttribute('href')).toBe(
      '/api/vendor/history.csv',
    );
    expect(el(fixture).querySelectorAll('[data-history-row]')).toHaveLength(
      VENDOR_HISTORY_FIXTURE.length,
    );
  });

  it('keeps the old page label when a page read fails', async () => {
    api.listHistory.mockResolvedValue(page(VENDOR_HISTORY_FIXTURE, 60));
    const fixture = await create();
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    button(fixture, 'Next').click();
    await settle(fixture);

    expect(text(el(fixture), '[data-history-page]')).toBe('Page 1 of 3');
    expect(button(fixture, 'Previous').disabled).toBe(true);
  });

  it('retries the read that failed, then moves the chip with the rows', async () => {
    const fixture = await create();
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);
    expect(pressed(fixture)).toBe('all');

    api.listHistory.mockResolvedValue(page([byActor('aeci')]));
    button(fixture, 'Try again').click();
    await settle(fixture);
    expect(api.listHistory).toHaveBeenLastCalledWith(1, VENDOR_HISTORY_PAGE_SIZE, {
      kind: 'aeci',
    });
    expect(pressed(fixture)).toBe('aeci');
    expect(el(fixture).querySelector('[data-history-refresh-failed]')).toBeNull();
  });

  it('lets the same chip be pressed again after its read failed', async () => {
    const fixture = await create();
    api.listHistory.mockRejectedValueOnce(new Error('boom'));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);

    api.listHistory.mockResolvedValue(page([byActor('aeci')]));
    el(fixture).querySelector<HTMLButtonElement>('[data-kind="aeci"]')!.click();
    await settle(fixture);
    expect(pressed(fixture)).toBe('aeci');
  });
});

describe('historyKindKeeps — the preview filter mirrors the API (AECI-1194)', () => {
  const keep = (kind: 'all' | 'vendor' | 'aeci') =>
    VENDOR_HISTORY_FIXTURE.filter((r) => historyKindKeeps(kind, r));

  it('filters by who acted, never by the action', () => {
    expect(keep('vendor').every((r) => r.actor_kind === 'your_team')).toBe(true);
    expect(keep('aeci').every((r) => r.actor_kind === 'aeci')).toBe(true);
    expect(keep('all')).toHaveLength(VENDOR_HISTORY_FIXTURE.length);
  });

  it("puts AECi's integration.retired row under AECi changes, not your team's", () => {
    const retired = VENDOR_HISTORY_FIXTURE.find((r) => r.action === 'integration.retired')!;
    expect(retired.actor_kind).toBe('aeci');
    expect(keep('aeci')).toContain(retired);
    expect(keep('vendor')).not.toContain(retired);
  });

  it('shows system rows under All only', () => {
    const system = VENDOR_HISTORY_FIXTURE.filter((r) => r.actor_kind === 'system');
    expect(system.length).toBeGreaterThan(0);
    for (const r of system) {
      expect(keep('vendor')).not.toContain(r);
      expect(keep('aeci')).not.toContain(r);
      expect(keep('all')).toContain(r);
    }
  });
});
