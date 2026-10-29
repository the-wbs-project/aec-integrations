/**
 * AECI-1539 — the private thread on one data row (`STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.11).
 *
 * What these pin: messages oldest first as "{Company} · {date}"; "Message deleted"
 * for a soft-deleted one; "Former member of {Company}" for an erased author; plain
 * text, never HTML; the audience line above the composer; the 2,000-character
 * limit and its count; delete behind an inline confirmation; "Ask AEC
 * Integrations" and its asked state; a closed thread with no composer and one
 * sentence on why; and the re-read when `threadsRevision` moves.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VendorThread, VendorThreadMessage } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { apiError, buttonNamed, el, settle, text } from './integration-detail-testing.harness';
import { IntegrationRowThread } from './integration-row-thread';

afterEach(() => vi.restoreAllMocks());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLAIM = uuid(40);
const AUTODESK = { id: uuid(1), name: 'Autodesk' };
const PROCORE = { id: uuid(2), name: 'Procore Technologies' };

function message(n: number, over: Partial<VendorThreadMessage> = {}): VendorThreadMessage {
  return {
    id: uuid(60 + n),
    author_vendor: PROCORE,
    author_removed: false,
    is_own: false,
    body: `Message ${n}`,
    created_at: `2026-10-0${n}T10:00:00.000Z`,
    deleted_at: null,
    ...over,
  };
}

function thread(over: Partial<VendorThread> = {}): VendorThread {
  return {
    id: uuid(50),
    claim_id: CLAIM,
    vendor_a: AUTODESK,
    vendor_b: PROCORE,
    closed_at: null,
    closed_reason: null,
    help_requested_at: null,
    created_at: '2026-10-01T10:00:00.000Z',
    messages: [
      message(1),
      message(2, { author_vendor: AUTODESK, is_own: true, body: 'Ours, still live' }),
    ],
    ...over,
  };
}

type ThreadApi = Record<
  'getThread' | 'postThreadMessage' | 'deleteThreadMessage' | 'requestThreadHelp',
  ReturnType<typeof vi.fn>
>;

function makeApi(initial: VendorThread | null): ThreadApi {
  return {
    getThread: vi.fn().mockResolvedValue({ thread: initial }),
    postThreadMessage: vi.fn(),
    deleteThreadMessage: vi.fn(),
    requestThreadHelp: vi.fn(),
  };
}

async function mount(
  api: ThreadApi,
  inputs: { live?: boolean } = {},
): Promise<{ fixture: ComponentFixture<IntegrationRowThread>; store: VendorPortalStore }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  const store = TestBed.inject(VendorPortalStore);
  const fixture = TestBed.createComponent(IntegrationRowThread);
  fixture.componentRef.setInput('claimId', CLAIM);
  fixture.componentRef.setInput('company', 'Procore Technologies');
  if (inputs.live !== undefined) fixture.componentRef.setInput('live', inputs.live);
  await settle(fixture);
  return { fixture, store };
}

const testid = (id: string) => `[data-testid="${id}"]`;
const composer = (f: ComponentFixture<unknown>) =>
  el(f).querySelector<HTMLTextAreaElement>(testid('thread-composer'));

async function type(f: ComponentFixture<unknown>, value: string): Promise<void> {
  const box = composer(f)!;
  box.value = value;
  box.dispatchEvent(new Event('input'));
  await settle(f);
}

describe('the message list', () => {
  it('reads oldest first as "{Company} · {date}"', async () => {
    const { fixture } = await mount(makeApi(thread()));
    const items = [...el(fixture).querySelectorAll('li[data-testid^="thread-message-"]')];
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('Procore Technologies · Oct 1, 2026 Message 1'),
      expect.stringContaining('Autodesk · Oct 2, 2026 Ours, still live'),
    ]);
    expect(text(fixture)).toContain('Conversation with Procore Technologies');
  });

  it('shows "Message deleted" in place of a soft-deleted message', async () => {
    const deleted = message(1, { body: null, deleted_at: '2026-10-01T11:00:00.000Z' });
    const { fixture } = await mount(makeApi(thread({ messages: [deleted] })));
    expect(text(fixture)).toContain('Message deleted');
    expect(text(fixture)).not.toContain('Message 1');
  });

  it('names an erased author as a former member of their company', async () => {
    const former = message(1, { author_removed: true });
    const { fixture } = await mount(makeApi(thread({ messages: [former] })));
    expect(text(fixture)).toContain('Former member of Procore Technologies · Oct 1, 2026');
  });

  it('renders message text as plain text, never as markup or a link', async () => {
    const body = '<b>bold</b> see https://example.test';
    const { fixture } = await mount(makeApi(thread({ messages: [message(1, { body })] })));
    const item = el(fixture).querySelector(testid(`thread-message-${uuid(61)}`))!;
    expect(item.querySelector('b')).toBeNull();
    expect(item.querySelector('a')).toBeNull();
    expect(item.textContent).toContain(body);
  });

  it('shows no list before the first message, and still offers the composer', async () => {
    const { fixture } = await mount(makeApi(null));
    expect(el(fixture).querySelector('ol')).toBeNull();
    expect(composer(fixture)).not.toBeNull();
    // A help ask before the first message is a 404 (§15.6), so it is not offered.
    expect(el(fixture).querySelector(testid('thread-help'))).toBeNull();
  });
});

describe('the composer', () => {
  it('carries the audience line and describes the textarea with it', async () => {
    const { fixture } = await mount(makeApi(thread()));
    expect(text(fixture)).toContain('Only Procore Technologies and AEC Integrations see this.');
    const ids = composer(fixture)!.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((id) => el(fixture).querySelector(`#${id}`)?.textContent?.trim())).toEqual([
      'Only Procore Technologies and AEC Integrations see this.',
      '0 of 2000 characters',
    ]);
  });

  it('caps the text at 2,000 characters, counts it, and only sends 1 to 2,000 after trim', async () => {
    const { fixture } = await mount(makeApi(thread()));
    const send = () => el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!;
    expect(composer(fixture)!.getAttribute('maxlength')).toBe('2000');
    expect(send().disabled).toBe(true);
    await type(fixture, '   ');
    expect(send().disabled).toBe(true);
    await type(fixture, 'Hello');
    expect(text(fixture)).toContain('5 of 2000 characters');
    expect(send().disabled).toBe(false);
  });

  it('posts the trimmed text, shows the answered thread and clears the draft', async () => {
    const api = makeApi(null);
    const posted = thread({
      messages: [message(1, { author_vendor: AUTODESK, is_own: true, body: 'Hello' })],
    });
    api.postThreadMessage.mockResolvedValue({ thread: posted });
    const { fixture } = await mount(api);
    await type(fixture, '  Hello  ');
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!.click();
    await settle(fixture);
    expect(api.postThreadMessage).toHaveBeenCalledWith(CLAIM, 'Hello');
    expect(text(fixture)).toContain('Autodesk · Oct 1, 2026');
    expect(composer(fixture)!.value).toBe('');
  });

  it('offers no composer on a retired row', async () => {
    const { fixture } = await mount(makeApi(thread()), { live: false });
    expect(composer(fixture)).toBeNull();
  });
});

describe('deleting a message', () => {
  it('offers Delete on the caller’s own live messages only', async () => {
    const { fixture } = await mount(makeApi(thread()));
    expect(el(fixture).querySelector(testid(`thread-delete-${uuid(61)}`))).toBeNull();
    expect(el(fixture).querySelector(testid(`thread-delete-${uuid(62)}`))).not.toBeNull();
  });

  it('asks inline before it deletes, never through a browser dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const api = makeApi(thread());
    const after = thread({
      messages: [
        message(1),
        message(2, {
          author_vendor: AUTODESK,
          is_own: true,
          body: null,
          deleted_at: '2026-10-02T11:00:00.000Z',
        }),
      ],
    });
    api.deleteThreadMessage.mockResolvedValue({ thread: after });
    const { fixture } = await mount(api);

    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`thread-delete-${uuid(62)}`))!
      .click();
    await settle(fixture);
    expect(text(fixture)).toContain('Delete this message?');
    expect(api.deleteThreadMessage).not.toHaveBeenCalled();

    // "Keep it" backs out and sends nothing.
    buttonNamed(fixture, 'Keep it')!.click();
    await settle(fixture);
    expect(text(fixture)).not.toContain('Delete this message?');
    expect(api.deleteThreadMessage).not.toHaveBeenCalled();

    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`thread-delete-${uuid(62)}`))!
      .click();
    await settle(fixture);
    buttonNamed(fixture, 'Yes, delete it')!.click();
    await settle(fixture);
    expect(api.deleteThreadMessage).toHaveBeenCalledWith(CLAIM, uuid(62));
    expect(text(fixture)).toContain('Message deleted');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('Ask AEC Integrations', () => {
  it('asks once, then shows the asked state instead of the button', async () => {
    const api = makeApi(thread());
    api.requestThreadHelp.mockResolvedValue({
      thread: thread({ help_requested_at: '2026-10-03T10:00:00.000Z' }),
    });
    const { fixture } = await mount(api);
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-help'))!.click();
    await settle(fixture);
    expect(api.requestThreadHelp).toHaveBeenCalledWith(CLAIM);
    expect(el(fixture).querySelector(testid('thread-help'))).toBeNull();
    expect(text(fixture)).toContain(
      'AEC Integrations was asked to look at this conversation on Oct 3, 2026.',
    );
  });

  it('shows the asked state the other company set, too (§15.3)', async () => {
    const { fixture } = await mount(
      makeApi(thread({ help_requested_at: '2026-10-03T10:00:00.000Z' })),
    );
    expect(el(fixture).querySelector(testid('thread-help-asked'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('thread-help'))).toBeNull();
  });
});

describe('a closed thread', () => {
  it.each([
    ['retired', 'closed when the integration was retired'],
    ['withdrawn', 'closed when the company that added this row withdrew it'],
    ['claim_removed', 'closed when this row was removed from the directory'],
    ['not_attestable', 'closed when the integration moved to a connector service'],
  ] as const)('keeps its messages, drops the composer, and says why: %s', async (reason, why) => {
    const closed = thread({ closed_at: '2026-10-04T00:00:00.000Z', closed_reason: reason });
    const { fixture } = await mount(makeApi(closed));
    expect(text(fixture)).toContain('Message 1');
    expect(text(fixture)).toContain(why);
    expect(composer(fixture)).toBeNull();
    expect(el(fixture).querySelector(testid('thread-help'))).toBeNull();
    expect(el(fixture).querySelector('[data-testid^="thread-delete-"]')).toBeNull();
  });

  it('re-reads and says so when a write meets a thread that just closed', async () => {
    const api = makeApi(thread());
    api.postThreadMessage.mockRejectedValue(apiError(409, 'THREAD_CLOSED'));
    const { fixture } = await mount(api);
    api.getThread.mockResolvedValue({
      thread: thread({ closed_at: '2026-10-04T00:00:00.000Z', closed_reason: 'retired' }),
    });
    await type(fixture, 'Late reply');
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!.click();
    await settle(fixture);
    expect(api.getThread).toHaveBeenCalledTimes(2);
    expect(composer(fixture)).toBeNull();
    expect(text(fixture)).toContain('This conversation closed. It is read-only now.');
  });
});

describe('live updates', () => {
  it('re-reads the thread when threadsRevision moves, and keeps the draft', async () => {
    const api = makeApi(thread());
    const { fixture, store } = await mount(api);
    expect(api.getThread).toHaveBeenCalledTimes(1);
    await type(fixture, 'Half typed');

    api.getThread.mockResolvedValue({
      thread: thread({ messages: [...thread().messages, message(3, { body: 'Fresh reply' })] }),
    });
    await store.revalidate(['threads']);
    await settle(fixture);

    expect(api.getThread).toHaveBeenCalledTimes(2);
    expect(text(fixture)).toContain('Fresh reply');
    expect(composer(fixture)!.value).toBe('Half typed');
  });
});
