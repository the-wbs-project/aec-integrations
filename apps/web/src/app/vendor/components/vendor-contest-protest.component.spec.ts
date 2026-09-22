/**
 * AECI-1009 — protests to AECi in the Messages contests block
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12.12), driven through the list that
 * mounts `VendorContestProtest`: the submitter's request form, the not-yet line,
 * a refused request, the withdraw confirmation, the owner's one reply, and the
 * decided record with its cooldown.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListVendorContestsResponse, VendorContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_CONTESTS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorContestsList } from './vendor-contests-list';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const PROTESTABLE = VENDOR_CONTESTS_FIXTURE.submitted.find(
  (c) => c.protest_opens_at !== null && c.protest === null,
)!;
const REJECTED = VENDOR_CONTESTS_FIXTURE.submitted.find((c) => c.protest?.status === 'rejected')!;
const RECEIVED_OPEN = VENDOR_CONTESTS_FIXTURE.received.find((c) => c.protest?.status === 'open')!;

let api: {
  getContests: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  fileContestProtest: ReturnType<typeof vi.fn>;
  replyContestProtest: ReturnType<typeof vi.fn>;
  withdrawContestProtest: ReturnType<typeof vi.fn>;
};

function withContests(over: Partial<ListVendorContestsResponse>): ListVendorContestsResponse {
  return { ...VENDOR_CONTESTS_FIXTURE, ...over };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getContests: vi.fn().mockResolvedValue(VENDOR_CONTESTS_FIXTURE),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
    fileContestProtest: vi.fn().mockResolvedValue({ contest: PROTESTABLE }),
    replyContestProtest: vi.fn().mockResolvedValue({ contest: RECEIVED_OPEN }),
    withdrawContestProtest: vi.fn().mockResolvedValue({ contest: PROTESTABLE }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
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
const type = (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event('input'));
};
const submit = (scope: HTMLElement) =>
  scope.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

describe('VendorContestProtest — the submitter', () => {
  it('opens the request form, refuses an empty reason, then sends reason and links', async () => {
    const fixture = await create();
    const r = row(fixture, PROTESTABLE.id);
    const start = button(r, 'Ask AEC Integrations to review');
    expect(start).toBeTruthy();
    start.click();
    await settle(fixture);

    expect(r.textContent).toContain('Its view is advice');
    expect(r.textContent).toContain('Nothing about a review is public');
    expect(r.textContent).toContain('The owner declined this contest.');

    submit(r);
    await settle(fixture);
    expect(api.fileContestProtest).not.toHaveBeenCalled();
    expect(r.querySelector('[role="alert"]')?.textContent).toContain('Say why');

    type(r.querySelector('textarea')!, '  The guide moved in August.  ');
    button(r, 'Add a link').click();
    await settle(fixture);
    type(r.querySelector<HTMLInputElement>('input[type="url"]')!, 'https://example.test/notes');
    submit(r);
    await settle(fixture);

    expect(api.fileContestProtest).toHaveBeenCalledWith(PROTESTABLE.id, {
      reason: 'The guide moved in August.',
      evidence_urls: ['https://example.test/notes'],
    });
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain(
      'Sent to AEC Integrations for review',
    );
    expect(api.getContests).toHaveBeenCalledTimes(2);
  });

  it('refuses a link that is not a web address before sending', async () => {
    const fixture = await create();
    const r = row(fixture, PROTESTABLE.id);
    button(r, 'Ask AEC Integrations to review').click();
    await settle(fixture);
    type(r.querySelector('textarea')!, 'Reason');
    button(r, 'Add a link').click();
    await settle(fixture);
    type(r.querySelector<HTMLInputElement>('input[type="url"]')!, 'not a link');
    submit(r);
    await settle(fixture);
    expect(api.fileContestProtest).not.toHaveBeenCalled();
    expect(r.querySelector('[role="alert"]')?.textContent).toContain('full web address');
  });

  it('says plainly when the window has closed, and reloads', async () => {
    api.fileContestProtest.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'PROTEST_NOT_AVAILABLE',
            message: 'x',
            details: { reason: 'window_closed' },
          },
        },
      }),
    );
    const fixture = await create();
    const r = row(fixture, PROTESTABLE.id);
    button(r, 'Ask AEC Integrations to review').click();
    await settle(fixture);
    type(r.querySelector('textarea')!, 'Reason');
    submit(r);
    await settle(fixture);
    expect(row(fixture, PROTESTABLE.id).textContent).toContain('30 days to ask for a review');
    expect(api.getContests).toHaveBeenCalledTimes(2);
  });

  it('explains an open contest on the same field blocks the request (ruling 8)', async () => {
    api.fileContestProtest.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'PROTEST_NOT_AVAILABLE',
            message: 'x',
            details: { reason: 'contest_open' },
          },
        },
      }),
    );
    const fixture = await create();
    const r = row(fixture, PROTESTABLE.id);
    button(r, 'Ask AEC Integrations to review').click();
    await settle(fixture);
    type(r.querySelector('textarea')!, 'Reason');
    submit(r);
    await settle(fixture);
    expect(row(fixture, PROTESTABLE.id).textContent).toContain(
      'You have an open contest on this field',
    );
  });

  it('shows the deadline with its time, not just the day', async () => {
    const fixture = await create();
    const r = row(fixture, PROTESTABLE.id);
    button(r, 'Ask AEC Integrations to review').click();
    await settle(fixture);
    // Angular's `medium` format carries the time of day ("…, 4:14:30 PM").
    expect(r.textContent).toMatch(/You can ask until .+\d{1,2}:\d{2}:\d{2}/);
  });

  it('says when an unanswered contest can be protested', async () => {
    const early: VendorContest = {
      ...PROTESTABLE,
      status: 'open',
      decided_at: null,
      decision_note: null,
      protest_basis: 'silence',
      protest_opens_at: days(10),
      protest_closes_at: days(40),
    };
    api.getContests.mockResolvedValue(withContests({ submitted: [early], received: [] }));
    const fixture = await create();
    const r = row(fixture, early.id);
    expect(r.textContent).toContain('You can ask AEC Integrations to review this from');
    expect(button(r, 'Ask AEC Integrations to review')).toBeUndefined();
  });

  it('withdraws an open request after an inline confirmation', async () => {
    const open: VendorContest = {
      ...PROTESTABLE,
      protest_opens_at: null,
      protest_closes_at: null,
      protest_basis: null,
      protest: {
        status: 'open',
        basis: 'declined',
        reason: 'Because.',
        evidence_urls: [],
        protested_at: days(-1),
        reply_due_at: days(13),
        reply: null,
        reply_evidence_urls: [],
        replied_at: null,
        decision_note: null,
        decided_at: null,
      },
    };
    api.getContests.mockResolvedValue(withContests({ submitted: [open], received: [] }));
    const fixture = await create();
    const r = row(fixture, open.id);
    expect(r.textContent).toContain('With AEC Integrations');
    button(r, 'Withdraw review request').click();
    await settle(fixture);
    expect(r.textContent).toContain('You cannot ask again for this contest');
    expect(document.activeElement?.id).toBe(`vendor-protest-withdraw-${open.id}`);
    button(r, 'Withdraw request').click();
    await settle(fixture);
    expect(api.withdrawContestProtest).toHaveBeenCalledWith(open.id);
  });

  it('shows a decided request with its meaning and the cooldown', async () => {
    const fixture = await create();
    const r = row(fixture, REJECTED.id);
    expect(r.textContent).toContain('AEC Integrations agreed with the owner');
    expect(r.textContent).toContain(REJECTED.protest!.decision_note!);
    expect(r.textContent).toContain(REJECTED.protest!.reply!);
    expect(r.textContent).toContain("You can't contest this field again until");
  });
});

describe('VendorContestProtest — the owner', () => {
  it('shows the whole request and takes one reply', async () => {
    const fixture = await create();
    const r = row(fixture, RECEIVED_OPEN.id);
    expect(r.textContent).toContain(RECEIVED_OPEN.protest!.reason);
    expect(r.textContent).toContain(RECEIVED_OPEN.protest!.evidence_urls[0]!);
    expect(r.textContent).toContain('You can reply once');

    type(
      r.querySelector<HTMLTextAreaElement>(`#vendor-protest-reply-${RECEIVED_OPEN.id}`)!,
      'Our brand name.',
    );
    submit(r.querySelector<HTMLElement>(`[data-protest="${RECEIVED_OPEN.id}"]`)!);
    await settle(fixture);
    expect(api.replyContestProtest).toHaveBeenCalledWith(RECEIVED_OPEN.id, {
      reply: 'Our brand name.',
      evidence_urls: [],
    });
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Reply sent');
  });

  it('offers no reply form after the due date', async () => {
    const late: VendorContest = {
      ...RECEIVED_OPEN,
      protest: { ...RECEIVED_OPEN.protest!, reply_due_at: days(-1) },
    };
    api.getContests.mockResolvedValue(withContests({ received: [late], submitted: [] }));
    const fixture = await create();
    const r = row(fixture, late.id);
    expect(r.querySelector(`#vendor-protest-reply-${late.id}`)).toBeNull();
    expect(r.textContent).toContain('No reply');
  });

  it('links an upheld request to the owner edit', async () => {
    const upheld: VendorContest = {
      ...RECEIVED_OPEN,
      protest: {
        ...RECEIVED_OPEN.protest!,
        status: 'upheld',
        decision_note: 'The listing uses the longer name.',
        decided_at: days(0),
      },
    };
    api.getContests.mockResolvedValue(withContests({ received: [upheld], submitted: [] }));
    const fixture = await create();
    const r = row(fixture, upheld.id);
    expect(r.textContent).toContain(
      'This is advice. The value on record stays unless you change it.',
    );
    expect(r.querySelector('a[href*="integrations"]')?.textContent).toContain(
      'Edit the integration under',
    );
  });
});
