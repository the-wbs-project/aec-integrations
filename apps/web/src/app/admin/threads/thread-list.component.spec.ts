/**
 * `ThreadList` (`/admin/threads`) and `ThreadDetail` (`/admin/threads/:id`),
 * AECI-1539, `ADMIN_PANEL_SPEC.md` §5.19.
 *
 * What these pin: the list names each thread by its data row and its two
 * companies, marks a help request, and pages and filters like every admin list
 * (a filter change returns to page 1). The detail shows every message, the text
 * of a deleted one included, says it was deleted, renders text as text, and
 * offers no write.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminThreadDetail, AdminThreadRow, AdminThreadsResponse } from '@aeci/shared';

import { AdminThreadsApi } from './admin-threads-api';
import { ThreadDetail } from './thread-detail';
import { ThreadList } from './thread-list';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(over: Partial<AdminThreadRow> = {}): AdminThreadRow {
  return {
    id: uuid(50),
    claim_id: uuid(40),
    data_object: { slug: 'rfis', name: 'RFIs' },
    vendor_a: { id: uuid(1), slug: 'autodesk', name: 'Autodesk' },
    vendor_b: { id: uuid(2), slug: 'procore', name: 'Procore Technologies' },
    message_count: 3,
    last_message_at: '2026-10-06T10:00:00.000Z',
    help_requested_at: null,
    closed_at: null,
    closed_reason: null,
    created_at: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

function page(over: Partial<AdminThreadsResponse> = {}): AdminThreadsResponse {
  return { data: [row()], page: 1, perPage: 24, total: 1, ...over };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

async function setupList(response: AdminThreadsResponse = page()) {
  const api = { listThreads: vi.fn(async () => structuredClone(response)), getThread: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminThreadsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ThreadList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

describe('ThreadList', () => {
  it('names each thread by its data row and its two companies, linking the detail', async () => {
    const { el } = await setupList();
    const first = el.querySelector('tbody tr')!;
    expect(first.textContent).toContain('RFIs');
    expect(first.textContent).toContain('Autodesk and Procore Technologies');
    expect(first.textContent).toContain('Oct 6, 2026');
    expect(first.textContent).toContain('Not asked');
    expect(first.textContent).toContain('Open');
    expect(first.querySelector('a')?.getAttribute('href')).toBe(`/admin/threads/${uuid(50)}`);
  });

  it('marks a help request and a closed thread', async () => {
    const { el } = await setupList(
      page({
        data: [
          row({
            help_requested_at: '2026-10-03T10:00:00.000Z',
            closed_at: '2026-10-04T00:00:00.000Z',
            closed_reason: 'claim_removed',
            claim_id: null,
          }),
        ],
      }),
    );
    expect(el.textContent).toContain('Help requested');
    expect(el.textContent).toContain('Oct 3, 2026');
    expect(el.textContent).toContain('Closed: row removed');
  });

  it('asks for every thread on first load, leaving `help` to the server default', async () => {
    const { api } = await setupList();
    expect(api.listThreads).toHaveBeenCalledWith({ page: 1, perPage: 24 });
  });

  it('sends the Help requested filter and returns to page one', async () => {
    const { api, fixture } = await setupList(page({ total: 60 }));
    const list = fixture.componentInstance as unknown as {
      goToPage(n: number): void;
      onHelpChange(v: string): void;
    };
    list.goToPage(2);
    await settle();
    expect(api.listThreads).toHaveBeenLastCalledWith({ page: 2, perPage: 24 });
    list.onHelpChange('requested');
    await settle();
    expect(api.listThreads).toHaveBeenLastCalledWith({ page: 1, perPage: 24, help: 'requested' });
  });

  it('says nobody asked for help when the filter matches nothing', async () => {
    const { fixture, el } = await setupList(page({ data: [], total: 0 }));
    expect(el.textContent).toContain('No company has started a thread yet.');
    (fixture.componentInstance as unknown as { onHelpChange(v: string): void }).onHelpChange(
      'requested',
    );
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('No company has asked AEC Integrations to look at a thread.');
  });

  it('offers no write control: it is a list, not a queue', async () => {
    const { el } = await setupList();
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons.every((label) => !/delete|close|hide|reply/i.test(label ?? ''))).toBe(true);
  });
});

// ─── Detail ──────────────────────────────────────────────────────────────────

function detail(over: Partial<AdminThreadDetail> = {}): AdminThreadDetail {
  return {
    ...row(),
    messages: [
      {
        id: uuid(61),
        author_vendor: { id: uuid(1), slug: 'autodesk', name: 'Autodesk' },
        author_profile_id: uuid(100),
        body: '<b>Due dates</b> https://example.test',
        created_at: '2026-10-01T10:00:00.000Z',
        deleted_at: null,
      },
      {
        id: uuid(62),
        author_vendor: { id: uuid(2), slug: 'procore', name: 'Procore Technologies' },
        author_profile_id: null,
        body: 'Withdrawn text',
        created_at: '2026-10-06T10:00:00.000Z',
        deleted_at: '2026-10-06T11:00:00.000Z',
      },
    ],
    ...over,
  };
}

async function setupDetail(result: AdminThreadDetail | Error = detail()) {
  const api = {
    listThreads: vi.fn(),
    getThread: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return { thread: structuredClone(result) };
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminThreadsApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: new Map([['id', uuid(50)]]) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ThreadDetail);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

describe('ThreadDetail', () => {
  it('heads the page with the data row and its two companies', async () => {
    const { el, api } = await setupDetail();
    expect(api.getThread).toHaveBeenCalledWith(uuid(50));
    expect(el.querySelector('h2')?.textContent).toContain(
      'RFIs between Autodesk and Procore Technologies',
    );
  });

  it('shows the text of a deleted message and says the companies no longer see it', async () => {
    const { el } = await setupDetail();
    const deleted = el.querySelector(`[data-testid="admin-thread-message-${uuid(62)}"]`)!;
    expect(deleted.textContent).toContain('Withdrawn text');
    expect(deleted.textContent).toContain('Deleted by its author on');
    expect(deleted.textContent).toContain('The two companies see "Message deleted".');
    expect(deleted.textContent).toContain("Author's account was erased");
  });

  it('renders message text as text, never as markup or a link', async () => {
    const { el } = await setupDetail();
    const first = el.querySelector(`[data-testid="admin-thread-message-${uuid(61)}"]`)!;
    expect(first.querySelector('b')).toBeNull();
    expect(first.textContent).toContain('<b>Due dates</b> https://example.test');
    // The one link is the author's account, never anything in the body.
    const links = [...first.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([`/admin/users/${uuid(100)}`]);
  });

  it('says so when the thread is gone', async () => {
    const { el } = await setupDetail(Object.assign(new Error('nf'), { status: 404 }));
    expect(el.textContent).toContain('No thread with that id.');
  });
});
