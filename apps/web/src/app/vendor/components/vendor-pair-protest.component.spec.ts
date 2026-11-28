/**
 * AECI-2110 — the protest on a Sync Service data flow report
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.5), mounted directly: the submitter's own reason
 * and links, the refusals before anything is sent, the withdraw confirmation, the
 * owner's one reply, and the cooldown line.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PairContest } from '@aeci/shared';

import { PREVIEW_RECEIVED_FLOW_REPORT } from '../../preview/vendor-dashboard/preview-sync-fixtures';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';

import { VendorPairProtest } from './vendor-pair-protest';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const DECLINED: PairContest = {
  ...PREVIEW_RECEIVED_FLOW_REPORT,
  status: 'declined',
  decided_at: days(-2),
  protest_closes_at: days(28),
};
const PROTESTED: PairContest = {
  ...DECLINED,
  protest_closes_at: null,
  protest: {
    status: 'open',
    basis: 'declined',
    reason: 'Their help page says otherwise.',
    evidence_urls: ['https://example.test/help'],
    protested_at: days(-1),
    reply_due_at: days(13),
    reply: null,
    reply_evidence_urls: [],
    replied_at: null,
    decision_note: null,
    decided_at: null,
  },
};

let api: {
  protestPairContest: ReturnType<typeof vi.fn>;
  replyPairProtest: ReturnType<typeof vi.fn>;
  withdrawPairProtest: ReturnType<typeof vi.fn>;
};
let announce: ReturnType<typeof vi.fn>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    protestPairContest: vi.fn().mockResolvedValue({ contest: PROTESTED }),
    replyPairProtest: vi.fn().mockResolvedValue({ contest: PROTESTED }),
    withdrawPairProtest: vi.fn().mockResolvedValue({ contest: PROTESTED }),
  };
  announce = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      { provide: VendorPortalAnnouncer, useValue: { announce } },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function create(
  report: PairContest,
  side: 'submitted' | 'received',
): Promise<ComponentFixture<VendorPairProtest>> {
  const fixture = TestBed.createComponent(VendorPairProtest);
  fixture.componentRef.setInput('report', report);
  fixture.componentRef.setInput('side', side);
  await settle(fixture);
  return fixture;
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!;
const type = (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event('input'));
};
const submit = (scope: HTMLElement) =>
  scope.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

describe('VendorPairProtest — the submitter', () => {
  it('sends the vendor’s own reason and links, and tells the list to re-read', async () => {
    const fixture = await create(DECLINED, 'submitted');
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    button(el(fixture), 'Ask AEC Integrations to review it').click();
    await settle(fixture);
    type(el(fixture).querySelector('textarea')!, '  Their help page lists no RFI sync.  ');
    button(el(fixture), 'Add a link').click();
    await settle(fixture);
    type(el(fixture).querySelector('input[type="url"]')!, 'https://example.test/help');
    submit(el(fixture));
    await settle(fixture);
    expect(api.protestPairContest).toHaveBeenCalledWith(DECLINED.id, {
      reason: 'Their help page lists no RFI sync.',
      evidence_urls: ['https://example.test/help'],
    });
    expect(announce).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it('refuses an empty reason and a link that is not a web address, sending nothing', async () => {
    const fixture = await create(DECLINED, 'submitted');
    button(el(fixture), 'Ask AEC Integrations to review it').click();
    await settle(fixture);
    submit(el(fixture));
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'Say why the data flow should change.',
    );
    type(el(fixture).querySelector('textarea')!, 'A reason.');
    button(el(fixture), 'Add a link').click();
    await settle(fixture);
    type(el(fixture).querySelector('input[type="url"]')!, 'not a link');
    submit(el(fixture));
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('full web address');
    expect(api.protestPairContest).not.toHaveBeenCalled();
  });

  it('offers no request once the window is gone', async () => {
    const fixture = await create({ ...DECLINED, protest_closes_at: null }, 'submitted');
    expect(button(el(fixture), 'Ask AEC Integrations to review it')).toBeUndefined();
  });

  it('withdraws an open request behind an inline confirmation', async () => {
    const fixture = await create(PROTESTED, 'submitted');
    button(el(fixture), 'Withdraw review request').click();
    await settle(fixture);
    expect(el(fixture).textContent).toContain('You cannot ask again for this report.');
    button(el(fixture), 'Withdraw request').click();
    await settle(fixture);
    expect(api.withdrawPairProtest).toHaveBeenCalledWith(PROTESTED.id);
  });

  it('says until when the flow cannot be reported again', async () => {
    const fixture = await create(
      {
        ...PROTESTED,
        protest: { ...PROTESTED.protest!, status: 'rejected', decision_note: 'Owner is right.' },
        cooldown_until: days(80),
      },
      'submitted',
    );
    expect(el(fixture).textContent).toContain("You can't report this data flow again until");
    expect(el(fixture).textContent).toContain('AEC Integrations agrees with the Sync Service.');
  });
});

describe('VendorPairProtest — the owner', () => {
  it('shows the whole protest and replies once', async () => {
    const fixture = await create(PROTESTED, 'received');
    expect(el(fixture).textContent).toContain('Their help page says otherwise.');
    expect(el(fixture).querySelector('a[href="https://example.test/help"]')).toBeTruthy();
    type(el(fixture).querySelector('textarea')!, 'Our release notes list RFIs.');
    submit(el(fixture));
    await settle(fixture);
    expect(api.replyPairProtest).toHaveBeenCalledWith(PROTESTED.id, {
      reply: 'Our release notes list RFIs.',
      evidence_urls: [],
    });
  });

  it('has no reply form past the due date, or once a reply is on file', async () => {
    const late = await create(
      { ...PROTESTED, protest: { ...PROTESTED.protest!, reply_due_at: days(-1) } },
      'received',
    );
    expect(el(late).querySelector('form')).toBeNull();
    expect(el(late).textContent).toContain('No reply');
    const replied = await create(
      { ...PROTESTED, protest: { ...PROTESTED.protest!, reply: 'We do.', replied_at: days(0) } },
      'received',
    );
    expect(el(replied).querySelector('form')).toBeNull();
    expect(el(replied).textContent).toContain('We do.');
  });

  it('maps a refusal to plain copy', async () => {
    api.replyPairProtest.mockRejectedValueOnce({
      error: { error: { code: 'PROTEST_REPLY_CLOSED' } },
    });
    const fixture = await create(PROTESTED, 'received');
    type(el(fixture).querySelector('textarea')!, 'Late.');
    submit(el(fixture));
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'The time to reply has passed.',
    );
  });
});
