/**
 * AECI-1008 — the Messages contests block (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b /
 * §6.5): the owner inbox with Accept / Decline, the submitted list with
 * Withdraw, the `409 CONTEST_NOT_OPEN` race, and both empty states.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_CONTESTS_EMPTY_FIXTURE, VENDOR_CONTESTS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorContestsList } from './vendor-contests-list';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const RECEIVED = VENDOR_CONTESTS_FIXTURE.received[0]!;
const OPEN_SUBMITTED = VENDOR_CONTESTS_FIXTURE.submitted.find((c) => c.status === 'open')!;

let api: {
  getContests: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  decideContest: ReturnType<typeof vi.fn>;
  withdrawContest: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getContests: vi.fn().mockResolvedValue(VENDOR_CONTESTS_FIXTURE),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
    decideContest: vi.fn().mockResolvedValue({ contest: RECEIVED }),
    withdrawContest: vi.fn().mockResolvedValue({ contest: OPEN_SUBMITTED }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(): Promise<ComponentFixture<VendorContestsList>> {
  const fixture = TestBed.createComponent(VendorContestsList);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const row = (fixture: ComponentFixture<unknown>, id: string) =>
  el(fixture).querySelector<HTMLElement>(`[data-contest="${id}"]`)!;
const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!;

describe('VendorContestsList — rendering', () => {
  it('renders the received and submitted rows with readable values', async () => {
    const fixture = await create();
    const received = row(fixture, RECEIVED.id);
    expect(received.textContent).toContain('Documentation link on Autodesk Build');
    expect(received.textContent).toContain('Not on record');
    expect(received.textContent).toContain(RECEIVED.proposed_value!);
    expect(received.textContent).toContain('From Autodesk');

    const declined = VENDOR_CONTESTS_FIXTURE.submitted.find((c) => c.status === 'declined')!;
    const declinedRow = row(fixture, declined.id);
    // `owner` values are vendor ids; the row shows the names.
    expect(declinedRow.textContent).toContain('Procore Technologies');
    expect(declinedRow.textContent).toContain('Summit BIM');
    expect(declinedRow.textContent).toContain('Declined');
    expect(declinedRow.textContent).toContain(declined.decision_note!);

    expect(row(fixture, OPEN_SUBMITTED.id).textContent).toContain('With AEC Integrations');
  });

  it('explains both empty states', async () => {
    api.getContests.mockResolvedValue(VENDOR_CONTESTS_EMPTY_FIXTURE);
    const fixture = await create();
    expect(el(fixture).textContent).toContain('Nothing to decide');
    expect(el(fixture).textContent).toContain('Once you claim an integration');
    expect(el(fixture).textContent).toContain('You have not contested anything');
  });

  it('offers a retry when the read fails', async () => {
    api.getContests.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();
    expect(el(fixture).textContent).toContain('Could not load your contests');

    button(el(fixture), 'Try again').click();
    await settle(fixture);
    expect(row(fixture, RECEIVED.id)).not.toBeNull();
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Contests updated');
  });
});

describe('VendorContestsList — deciding', () => {
  it('accepts with the note, announces, and revalidates contests AND integrations', async () => {
    const fixture = await create();
    const scope = row(fixture, RECEIVED.id);
    const note = scope.querySelector('textarea')!;
    note.value = '  Thanks, fixed.  ';
    note.dispatchEvent(new Event('input'));
    api.getContests.mockClear();

    button(scope, 'Accept').click();
    await settle(fixture);

    expect(api.decideContest).toHaveBeenCalledWith(RECEIVED.id, {
      decision: 'accept',
      note: 'Thanks, fixed.',
    });
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Accepted');
    expect(api.getContests).toHaveBeenCalledTimes(1);
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
  });

  it('declines with no note as `null`, and leaves integrations alone', async () => {
    const fixture = await create();
    button(row(fixture, RECEIVED.id), 'Decline').click();
    await settle(fixture);

    expect(api.decideContest).toHaveBeenCalledWith(RECEIVED.id, {
      decision: 'decline',
      note: null,
    });
    expect(api.getIntegrations).not.toHaveBeenCalled();
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Declined');
  });

  it('says "already decided" on a lost race and reloads the list', async () => {
    api.decideContest.mockRejectedValue(
      new HttpErrorResponse({ status: 409, error: { error: { code: 'CONTEST_NOT_OPEN' } } }),
    );
    const fixture = await create();
    api.getContests.mockClear();
    button(row(fixture, RECEIVED.id), 'Accept').click();
    await settle(fixture);

    const alert = row(fixture, RECEIVED.id).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('already decided or withdrawn');
    expect(api.getContests).toHaveBeenCalledTimes(1);
  });

  it('keeps a generic failure on the row, without reloading', async () => {
    api.decideContest.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const fixture = await create();
    api.getContests.mockClear();
    button(row(fixture, RECEIVED.id), 'Decline').click();
    await settle(fixture);

    expect(row(fixture, RECEIVED.id).querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save your decision',
    );
    expect(api.getContests).not.toHaveBeenCalled();
  });
});

describe('VendorContestsList — withdrawing', () => {
  it('confirms inline before withdrawing, and "Keep it" cancels', async () => {
    const fixture = await create();
    button(row(fixture, OPEN_SUBMITTED.id), 'Withdraw').click();
    await settle(fixture);
    expect(row(fixture, OPEN_SUBMITTED.id).textContent).toContain('cannot be reopened');
    expect(api.withdrawContest).not.toHaveBeenCalled();

    button(row(fixture, OPEN_SUBMITTED.id), 'Keep it').click();
    await settle(fixture);
    expect(row(fixture, OPEN_SUBMITTED.id).textContent).not.toContain('cannot be reopened');
    expect(api.withdrawContest).not.toHaveBeenCalled();
  });

  it('withdraws on confirm, announces, and revalidates', async () => {
    const fixture = await create();
    button(row(fixture, OPEN_SUBMITTED.id), 'Withdraw').click();
    await settle(fixture);
    api.getContests.mockClear();
    button(row(fixture, OPEN_SUBMITTED.id), 'Withdraw').click();
    await settle(fixture);

    expect(api.withdrawContest).toHaveBeenCalledWith(OPEN_SUBMITTED.id);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Withdrawn');
    expect(api.getContests).toHaveBeenCalledTimes(1);
  });

  it('offers no Withdraw on a closed contest', async () => {
    const fixture = await create();
    const closed = VENDOR_CONTESTS_FIXTURE.submitted.find((c) => c.status !== 'open')!;
    expect(button(row(fixture, closed.id), 'Withdraw')).toBeUndefined();
  });
});
