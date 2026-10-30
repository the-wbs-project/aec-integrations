/**
 * AECI-1539 — the private thread on one data row (`STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.11).
 *
 * What these pin: messages oldest first as "{Company} · {date}"; "Message deleted"
 * for a soft-deleted one; "Former member of {Company}" for an erased author; plain
 * text, never HTML; the audience line above the composer; the 2,000-character
 * limit and its count; delete behind an inline confirmation; "Ask AEC
 * Integrations" and its asked state; a closed thread with no composer and one
 * sentence on why; the re-read when `threadsRevision` moves; and the server's
 * `counterparty`, never the page's company, as the named recipient (AECI-1545).
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ThreadCompany,
  VendorThread,
  VendorThreadById,
  VendorThreadMessage,
  VendorThreadSummary,
} from '@aeci/shared';

import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
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
> & {
  /** What the page's summary read would say about this row (AECI-1546). */
  readonly seed: { summary: VendorThreadSummary | null; firstPostTo: ThreadCompany | null };
};

/** The page's summary entry for a thread, as `GET …/integrations/:id/threads` builds it. */
function summaryOf(t: VendorThread, counterparty: ThreadCompany = PROCORE): VendorThreadSummary {
  return {
    id: t.id,
    claim_id: t.claim_id,
    counterparty,
    message_count: t.messages.length,
    latest_message_at: t.messages.at(-1)?.created_at ?? null,
    closed_at: t.closed_at,
    closed_reason: t.closed_reason,
    help_requested_at: t.help_requested_at,
  };
}

function makeApi(
  initial: VendorThread | null,
  counterparty: ThreadCompany | null = PROCORE,
): ThreadApi {
  return {
    getThread: vi.fn().mockResolvedValue({ thread: initial, counterparty }),
    postThreadMessage: vi.fn(),
    deleteThreadMessage: vi.fn(),
    requestThreadHelp: vi.fn(),
    seed: {
      summary: initial && counterparty ? summaryOf(initial, counterparty) : null,
      firstPostTo: initial ? null : counterparty,
    },
  };
}

/** Mounts the row and, unless `open: false`, opens it as a seat would. */
async function mount(
  api: ThreadApi,
  inputs: {
    live?: boolean;
    open?: boolean;
    summary?: VendorThreadSummary | null;
    firstPostTo?: ThreadCompany | null;
  } = {},
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
  fixture.componentRef.setInput(
    'summary',
    inputs.summary !== undefined ? inputs.summary : api.seed.summary,
  );
  fixture.componentRef.setInput(
    'firstPostTo',
    inputs.firstPostTo !== undefined ? inputs.firstPostTo : api.seed.firstPostTo,
  );
  if (inputs.live !== undefined) fixture.componentRef.setInput('live', inputs.live);
  await settle(fixture);
  if (inputs.open !== false) {
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-toggle'))?.click();
    await settle(fixture);
  }
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

  it('names the server’s counterparty, not the page’s company, before the first post', async () => {
    // A co-owned endpoint: the first post stamps Summit BIM, whatever the page lists.
    const summit = { id: uuid(3), name: 'Summit BIM' };
    const { fixture } = await mount(makeApi(null, summit));
    expect(text(fixture)).toContain('Conversation with Summit BIM');
    expect(text(fixture)).toContain('Only Summit BIM and AEC Integrations see this.');
    expect(text(fixture)).toContain('Message to Summit BIM');
    expect(text(fixture)).not.toContain('Procore Technologies');
  });

  it('offers no composer when the row has no thread and no counterparty', async () => {
    const { fixture } = await mount(makeApi(null, null));
    expect(composer(fixture)).toBeNull();
    expect(el(fixture).querySelector(testid('thread-unavailable'))).not.toBeNull();
  });

  it('re-reads after the first post, so the recipient is the stamped one', async () => {
    const api = makeApi(null, { id: uuid(3), name: 'Summit BIM' });
    const posted = thread({ messages: [message(1, { author_vendor: AUTODESK, is_own: true })] });
    api.postThreadMessage.mockResolvedValue({ thread: posted });
    const { fixture } = await mount(api);
    // The post stamped Procore after all: the re-read names the stamped company.
    api.getThread.mockResolvedValue({ thread: posted, counterparty: PROCORE });
    await type(fixture, 'Hello');
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!.click();
    await settle(fixture);
    expect(api.getThread).toHaveBeenCalledTimes(2);
    expect(text(fixture)).toContain('Only Procore Technologies and AEC Integrations see this.');
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
    // The re-read after a first post finds the thread the post created.
    api.getThread.mockResolvedValue({ thread: posted, counterparty: PROCORE });
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
      counterparty: PROCORE,
    });
    await type(fixture, 'Late reply');
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!.click();
    await settle(fixture);
    expect(api.getThread).toHaveBeenCalledTimes(2);
    expect(composer(fixture)).toBeNull();
    expect(text(fixture)).toContain('This conversation closed. It is read-only now.');
  });
});

describe('read-only by thread id (AECI-1548)', () => {
  const OWN = { id: VENDOR_ME_FIXTURE.vendor.id, name: VENDOR_ME_FIXTURE.vendor.company_name };

  async function mountById(byId: VendorThreadById) {
    const api = { ...makeApi(null), getThreadById: vi.fn().mockResolvedValue({ thread: byId }) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: api as unknown as VendorApi },
        VendorPortalStore,
      ],
    });
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    const fixture = TestBed.createComponent(IntegrationRowThread);
    const loaded = vi.fn();
    fixture.componentInstance.threadLoaded.subscribe(loaded);
    fixture.componentRef.setInput('threadId', byId.id);
    await settle(fixture);
    return { fixture, api, loaded };
  }

  const detached = (over: Partial<VendorThreadById> = {}): VendorThreadById => ({
    ...thread({
      vendor_a: OWN,
      vendor_b: PROCORE,
      closed_at: '2026-10-04T00:00:00.000Z',
      closed_reason: 'claim_removed',
      messages: [
        message(1),
        message(2, { author_vendor: OWN, is_own: true, body: 'Ours, still live' }),
      ],
    }),
    claim_id: null,
    data_object: { slug: 'rfis', name: 'RFIs' },
    ...over,
  });

  it('reads by id, shows the messages and the close sentence, and never a composer', async () => {
    const { fixture, api, loaded } = await mountById(detached());
    expect(api.getThreadById).toHaveBeenCalledWith(uuid(50));
    expect(api.getThread).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Message 1');
    expect(text(fixture)).toContain('closed when this row was removed from the directory');
    expect(text(fixture)).toContain('Conversation with Procore Technologies');
    expect(composer(fixture)).toBeNull();
    expect(el(fixture).querySelector(testid('thread-help'))).toBeNull();
    expect(el(fixture).querySelector('[data-testid^="thread-delete-"]')).toBeNull();
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ claim_id: null }));
    // Under the page's h2, so an h3 (AECI-1548).
    expect(el(fixture).querySelector('h3')?.textContent).toContain('Conversation with');
  });

  it('stays read-only on an open thread reached by id', async () => {
    const { fixture } = await mountById(detached({ closed_at: null, closed_reason: null }));
    expect(composer(fixture)).toBeNull();
    expect(el(fixture).querySelector('[data-testid^="thread-delete-"]')).toBeNull();
  });

  it('names the other stamped company when the caller is vendor_b', async () => {
    const { fixture } = await mountById(detached({ vendor_a: PROCORE, vendor_b: OWN }));
    expect(text(fixture)).toContain('Conversation with Procore Technologies');
  });

  it('is open straight away, with no summary row, and re-reads on a tick (AECI-1546)', async () => {
    const { fixture, api } = await mountById(detached());
    expect(el(fixture).querySelector(testid('thread-toggle'))).toBeNull();
    expect(el(fixture).querySelector(testid('thread-summary'))).toBeNull();
    expect(el(fixture).querySelector(testid('thread-unavailable'))).toBeNull();
    expect(api.getThreadById).toHaveBeenCalledTimes(1);
    await TestBed.inject(VendorPortalStore).revalidate(['threads']);
    await settle(fixture);
    expect(api.getThreadById).toHaveBeenCalledTimes(2);
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
      counterparty: PROCORE,
    });
    await store.revalidate(['threads']);
    await settle(fixture);

    expect(api.getThread).toHaveBeenCalledTimes(2);
    expect(text(fixture)).toContain('Fresh reply');
    expect(composer(fixture)!.value).toBe('Half typed');
  });
});

describe('closed until opened (AECI-1546)', () => {
  it('shows the page’s summary and reads nothing until the seat opens it', async () => {
    const api = makeApi(thread());
    const { fixture } = await mount(api, { open: false });
    expect(api.getThread).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Conversation with Procore Technologies');
    expect(el(fixture).querySelector(testid('thread-summary'))?.textContent).toMatch(
      /2 messages\s*·\s*latest Oct 2, 2026/,
    );
    expect(el(fixture).querySelector('[data-testid^="thread-message-"]')).toBeNull();
    const toggle = el(fixture).querySelector<HTMLButtonElement>(testid('thread-toggle'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent?.trim()).toBe('Show the conversation');

    toggle.click();
    await settle(fixture);
    expect(api.getThread).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('Message 1');
  });

  it('says a closed summary is read-only', async () => {
    const closed = thread({ closed_at: '2026-10-04T00:00:00.000Z', closed_reason: 'retired' });
    const { fixture } = await mount(makeApi(closed), { open: false });
    expect(el(fixture).querySelector(testid('thread-summary'))?.textContent).toContain('Read-only');
  });

  it('offers to write the first message on a row with no thread', async () => {
    const { fixture } = await mount(makeApi(null), { open: false });
    expect(text(fixture)).toContain('No messages yet.');
    expect(el(fixture).querySelector(testid('thread-toggle'))?.textContent?.trim()).toBe(
      'Write a message',
    );
  });

  it('offers nothing to open on a retired row with no thread', async () => {
    const api = makeApi(null);
    const { fixture } = await mount(api, { open: false, live: false });
    expect(el(fixture).querySelector(testid('thread-toggle'))).toBeNull();
    expect(api.getThread).not.toHaveBeenCalled();
  });

  it('does not re-read a closed thread when threadsRevision moves', async () => {
    const api = makeApi(thread());
    const { fixture, store } = await mount(api, { open: false });
    await store.revalidate(['threads']);
    await settle(fixture);
    expect(api.getThread).not.toHaveBeenCalled();
  });

  it('stops re-reading once the seat hides it again', async () => {
    const api = makeApi(thread());
    const { fixture, store } = await mount(api);
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-toggle'))!.click();
    await settle(fixture);
    await store.revalidate(['threads']);
    await settle(fixture);
    expect(api.getThread).toHaveBeenCalledTimes(1);
  });

  it('tells the page its summary is stale after a write', async () => {
    const api = makeApi(thread());
    api.postThreadMessage.mockResolvedValue({ thread: thread() });
    const { fixture } = await mount(api);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await type(fixture, 'Hello');
    el(fixture).querySelector<HTMLButtonElement>(testid('thread-send'))!.click();
    await settle(fixture);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
