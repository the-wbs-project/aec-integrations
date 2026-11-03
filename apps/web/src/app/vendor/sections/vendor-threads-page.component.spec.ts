/**
 * AECI-1551 — the portal Conversations list (`STAGE_2_ATTESTATIONS_SPEC.md` §15.11):
 * one row per thread with the other company, the data row, the last activity, open
 * or closed and the help ask; each row links to the thread's page; the status
 * filter and Previous / Next behave as on the Changes page; empty and failed states;
 * and a quiet re-read on a `threadsRevision` tick.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ListVendorThreadsResponse, VendorThreadListItem } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { el, settle, text } from '../integration-detail/integration-detail-testing.harness';
import { VENDOR_THREADS_PAGE_SIZE, VendorThreadsPage } from './vendor-threads-page';

afterEach(() => vi.restoreAllMocks());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROCORE = { id: uuid(2), name: 'Procore Technologies' };

function item(n: number, over: Partial<VendorThreadListItem> = {}): VendorThreadListItem {
  return {
    id: uuid(50 + n),
    claim_id: uuid(40 + n),
    counterparty: PROCORE,
    data_object: { slug: 'rfis', name: 'RFIs' },
    message_count: 2,
    last_activity_at: '2026-10-20T10:00:00.000Z',
    closed_at: null,
    closed_reason: null,
    help_requested_at: null,
    ...over,
  };
}

function page(
  items: readonly VendorThreadListItem[],
  total = items.length,
  n = 1,
): ListVendorThreadsResponse {
  return { data: [...items], page: n, perPage: VENDOR_THREADS_PAGE_SIZE, total };
}

async function mount(listThreads: ReturnType<typeof vi.fn>, me = VENDOR_ME_FIXTURE) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'vendor/:vendorSlug',
          children: [{ path: 'threads', component: VendorThreadsPage }],
        },
      ]),
      { provide: VendorApi, useValue: { listThreads } as Partial<VendorApi> },
      VendorPortalStore,
    ],
  });
  const store = TestBed.inject(VendorPortalStore);
  store.seed(me);
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/vendor/summit-bim/threads', VendorThreadsPage);
  const fixture = harness.fixture;
  await settle(fixture);
  return { fixture, store };
}

const rows = (f: Parameters<typeof el>[0]) =>
  Array.from(el(f).querySelectorAll<HTMLElement>('[data-thread-row]'));

describe('VendorThreadsPage (AECI-1551)', () => {
  it('lists each thread with the company, the row, the activity, the state and the help ask', async () => {
    const listThreads = vi.fn().mockResolvedValue(
      page([
        item(1, { help_requested_at: '2026-10-19T10:00:00.000Z', message_count: 1 }),
        item(2, {
          claim_id: null,
          data_object: null,
          closed_at: '2026-10-18T00:00:00.000Z',
          closed_reason: 'claim_removed',
        }),
      ]),
    );
    const { fixture } = await mount(listThreads);
    expect(listThreads).toHaveBeenCalledWith(1, VENDOR_THREADS_PAGE_SIZE, 'all');
    const [open, closed] = rows(fixture);
    expect(open!.textContent).toContain('Conversation with Procore Technologies about RFIs');
    expect(open!.textContent).toContain('Last activity Oct 20, 2026');
    expect(open!.querySelector('[data-thread-state]')?.textContent).toContain('Open');
    expect(open!.textContent).toContain('1 message');
    expect(open!.querySelector('[data-thread-help]')?.textContent).toContain(
      'AEC Integrations was asked to look',
    );
    expect(closed!.textContent).toContain(
      'Conversation with Procore Technologies about a data row',
    );
    expect(closed!.querySelector('[data-thread-state]')?.textContent).toContain('Closed');
    expect(closed!.querySelector('[data-thread-help]')).toBeNull();
  });

  // AECI-1553 (§15.16): a direct visit with the switch off is not found, and reads nothing.
  it('shows not found and never reads when threads_enabled is false', async () => {
    const listThreads = vi.fn().mockResolvedValue(page([item(1)]));
    const { fixture, store } = await mount(listThreads, {
      ...VENDOR_ME_FIXTURE,
      threads_enabled: false,
    });
    expect(el(fixture).querySelector('[data-vendor-threads-off]')?.textContent).toContain(
      'Page not found',
    );
    expect(rows(fixture)).toHaveLength(0);
    await store.revalidate(['threads']);
    await settle(fixture);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it('links each row to the thread’s permanent page', async () => {
    const { fixture } = await mount(vi.fn().mockResolvedValue(page([item(1)])));
    const link = rows(fixture)[0]!.querySelector('a[data-thread-link]');
    expect(link?.getAttribute('href')).toBe(`/vendor/summit-bim/threads/${uuid(51)}`);
  });

  it('filters by status from the chips, back to page 1', async () => {
    const listThreads = vi.fn().mockResolvedValue(page([item(1)]));
    const { fixture } = await mount(listThreads);
    const chip = el(fixture).querySelector<HTMLButtonElement>('[data-status="closed"]')!;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.click();
    await settle(fixture);
    expect(listThreads).toHaveBeenLastCalledWith(1, VENDOR_THREADS_PAGE_SIZE, 'closed');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('pages with Previous and Next', async () => {
    const many = Array.from({ length: VENDOR_THREADS_PAGE_SIZE }, (_, i) => item(i + 1));
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce(page(many, 30))
      .mockResolvedValue(page([item(99)], 30, 2));
    const { fixture } = await mount(listThreads);
    expect(el(fixture).querySelector('[data-threads-page]')?.textContent).toContain('Page 1 of 2');
    const next = Array.from(el(fixture).querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Next',
    )!;
    next.click();
    await settle(fixture);
    expect(listThreads).toHaveBeenLastCalledWith(2, VENDOR_THREADS_PAGE_SIZE, 'all');
    expect(el(fixture).querySelector('[data-threads-page]')?.textContent).toContain('Page 2 of 2');
  });

  it('says so when there is no conversation yet', async () => {
    const { fixture } = await mount(vi.fn().mockResolvedValue(page([])));
    expect(el(fixture).querySelector('[data-threads-empty]')?.textContent).toContain(
      'No conversations yet.',
    );
  });

  it('offers a retry when the first read fails', async () => {
    const listThreads = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page([item(1)]));
    const { fixture } = await mount(listThreads);
    expect(text(fixture)).toContain('Could not load your conversations.');
    Array.from(el(fixture).querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Try again')!
      .click();
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(1);
  });

  it('re-reads the page on screen when threadsRevision moves', async () => {
    const listThreads = vi.fn().mockResolvedValue(page([item(1)]));
    const { fixture, store } = await mount(listThreads);
    expect(listThreads).toHaveBeenCalledTimes(1);
    await store.revalidate(['threads']);
    await settle(fixture);
    expect(listThreads).toHaveBeenCalledTimes(2);
  });
});
