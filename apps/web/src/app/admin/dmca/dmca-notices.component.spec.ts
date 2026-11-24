/**
 * `AdminDmcaNotices` (`/admin/dmca`), AECI-1665. Source of truth: `ADMIN_PANEL_SPEC.md` §5.23.
 *
 * What these tests hold in place:
 *
 *  1. **Counter-notices sit under their notice**, in the API's urgency order.
 *  2. **The restore clock reads as a sentence with its dates**, from the API's clock.
 *  3. **The form sends what the API expects.** A new row leaves empty fields out. An edit
 *     sends only what changed, with the row's `updated_at`.
 *  4. **A lost race says so** ("Someone else changed this notice. Reload.") and offers a
 *     reload.
 *  5. **`?account=` filters** and shows that account's counts.
 *  6. **"Counter-notice to" lists every notice**, from its own unfiltered `?kind=notice`
 *     load, so "Open only" or `?account=` never hides the notice being answered.
 *  7. **An incomplete notice is still logged.** Name, contact and material may be blank,
 *     and the list says "Not given". Only a takedown needs the material identified.
 *  8. **Only the latest list load lands.** A slow response to an older filter never
 *     overwrites the newer one.
 *  9. **A pending save locks the form in place.** "Log a notice" and every Edit are
 *     disabled until it completes, and a save never closes a form it did not send.
 * 10. **A failed refresh is visible.** The earlier rows stay, under a banner that says the
 *     list may be out of date and offers "Try again". A successful load clears it.
 * 11. **The console recipe (AECI-2128).** The restore clock is a dense console chip in its
 *     ruled tone. Escape closes the form and returns focus to its opener, does nothing
 *     while a save is in flight, and a refused save moves focus to its message.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DmcaNotice, DmcaNoticesResponse } from '@aeci/shared';

import { AecSelect } from '../../shared/aec-select/aec-select';
import { AdminDmcaApi } from './admin-dmca-api';
import {
  AdminDmcaNotices,
  clockStatusKey,
  createBody,
  draftComplete,
  draftFrom,
  emptyDraft,
  groupNotices,
  updateBody,
} from './dmca-notices';

const ADMIN = '49dd03ee-1111-4000-8000-000000000001';
const ACCOUNT = '49dd03ee-1111-4000-8000-000000000002';

const row = (over: Partial<DmcaNotice> = {}): DmcaNotice => ({
  id: 'n-1',
  kind: 'notice',
  notice_id: null,
  received_at: '2026-11-20T12:00:00.000Z',
  submitter_name: 'Rights Holder LLC',
  submitter_contact: 'legal@rights.test',
  content_identified: 'https://www.aecintegrations.com/vendors/acme',
  work_claimed: 'The logo',
  account_id: ACCOUNT,
  account_name: 'Uploader',
  vendor_id: null,
  vendor_name: null,
  action: 'removed',
  action_at: '2026-11-20T12:00:00.000Z',
  forwarded_at: null,
  court_action_at: null,
  restore_outcome: null,
  restore_outcome_at: null,
  closed_at: null,
  notes: null,
  created_by: ADMIN,
  created_at: '2026-11-20T13:00:00.000Z',
  updated_by: ADMIN,
  updated_at: '2026-11-20T13:00:00.000Z',
  restore_clock: null,
  ...over,
});

const counter = (over: Partial<DmcaNotice> = {}): DmcaNotice =>
  row({
    id: 'c-1',
    kind: 'counter_notice',
    notice_id: 'n-1',
    submitter_name: 'Uploader',
    work_claimed: null,
    action: 'pending',
    action_at: null,
    forwarded_at: '2026-11-20T12:00:00.000Z',
    restore_clock: {
      earliest: '2026-12-07T05:00:00.000Z',
      latest: '2026-12-12T05:00:00.000Z',
      opens_on: '2026-12-07',
      due_on: '2026-12-11',
      state: 'waiting',
    },
    ...over,
  });

const LIST: DmcaNoticesResponse = {
  generated_at: '2026-11-23T12:00:00.000Z',
  // The API's order: the counter-notice is more urgent than the older notice.
  notices: [
    counter(),
    row({ id: 'n-2', submitter_name: 'Other Co', received_at: '2026-11-22T12:00:00.000Z' }),
    row(),
  ],
  account_counts: null,
};

const settle = () => new Promise((r) => setTimeout(r));
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim();

interface Opts {
  data?: DmcaNoticesResponse;
  /** What `?kind=notice` returns. Defaults to the notices in `data`. */
  allNotices?: DmcaNotice[];
  query?: Record<string, string>;
  create?: HttpErrorResponse;
  update?: HttpErrorResponse;
}

async function setup(opts: Opts = {}) {
  const data = structuredClone(opts.data ?? LIST);
  const api = {
    list: vi.fn(async (query: { kind?: string } = {}) =>
      query.kind === 'notice'
        ? {
            ...structuredClone(data),
            notices: structuredClone(
              opts.allNotices ?? data.notices.filter((n) => n.kind === 'notice'),
            ),
            account_counts: null,
          }
        : structuredClone(data),
    ),
    create: vi.fn(async () => {
      if (opts.create) throw opts.create;
      return { notice: row() };
    }),
    update: vi.fn(async () => {
      if (opts.update) throw opts.update;
      return { notice: row(), changed: true };
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminDmcaApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(opts.query ?? {}) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(AdminDmcaNotices);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rerender = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, api, el, rerender };
}

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('groupNotices', () => {
  it('nests counter-notices under their notice, where the most urgent row sat', () => {
    const groups = groupNotices(LIST.notices);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([['n-1', 'c-1'], ['n-2']]);
  });

  it('keeps a counter-notice whose notice is filtered out as its own group', () => {
    expect(groupNotices([counter()]).map((g) => g.rows.map((r) => r.id))).toEqual([['c-1']]);
  });
});

describe('the request bodies', () => {
  it('a new notice leaves empty fields out and sends noon UTC dates', () => {
    const d = {
      ...emptyDraft('notice', '2026-11-20'),
      submitter_name: ' Rights ',
      submitter_contact: 'a@b.test',
      content_identified: 'x',
    };
    expect(createBody(d)).toEqual({
      kind: 'notice',
      received_at: '2026-11-20T12:00:00.000Z',
      submitter_name: 'Rights',
      submitter_contact: 'a@b.test',
      content_identified: 'x',
      action: 'pending',
    });
  });

  it('an edit sends only the changed fields and the race sentinel', () => {
    const original = draftFrom(counter());
    const edited = { ...original, restore_outcome: 'restored' as const, notes: 'Put back.' };
    expect(updateBody(original, edited, 'stamp')).toEqual({
      expected_updated_at: 'stamp',
      restore_outcome: 'restored',
      notes: 'Put back.',
    });
  });

  it('an incomplete notice sends only what it has', () => {
    expect(createBody(emptyDraft('notice', '2026-11-20'))).toEqual({
      kind: 'notice',
      received_at: '2026-11-20T12:00:00.000Z',
      action: 'pending',
    });
  });

  it('a draft is complete without name, contact or material, unless it is a takedown', () => {
    const blank = emptyDraft('notice', '2026-11-20');
    expect(draftComplete(blank)).toBe(true);
    expect(draftComplete({ ...blank, action: 'no_action' })).toBe(true);
    expect(draftComplete({ ...blank, action: 'removed' })).toBe(false);
    expect(draftComplete({ ...blank, action: 'disabled', content_identified: '  ' })).toBe(false);
    expect(draftComplete({ ...blank, action: 'disabled', content_identified: 'x' })).toBe(true);
    expect(draftComplete({ ...blank, received_on: '' })).toBe(false);
  });

  it('a row with no name, contact or material opens as blank fields', () => {
    const d = draftFrom(
      row({ submitter_name: null, submitter_contact: null, content_identified: null }),
    );
    expect([d.submitter_name, d.submitter_contact, d.content_identified]).toEqual(['', '', '']);
  });

  it('clearing a field sends null', () => {
    const original = draftFrom(row({ notes: 'old' }));
    expect(updateBody(original, { ...original, notes: '' }, 's')).toEqual({
      expected_updated_at: 's',
      notes: null,
    });
  });
});

describe('AdminDmcaNotices', () => {
  it('renders one h2, the rows nested, and the restore clock with its dates', async () => {
    const { el } = await setup();
    expect(el.querySelectorAll('h2')).toHaveLength(1);
    const rows = [...el.querySelectorAll('[data-testid="dmca-row"]')];
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['n-1', 'c-1', 'n-2']);
    const clock = el.querySelector('[data-testid="dmca-clock"]');
    expect(clock?.getAttribute('data-state')).toBe('waiting');
    expect(text(clock)).toBe('Restore window opens 7 Dec 2026');
    expect(text(rows[1])).toContain('Window 7 Dec 2026 to 11 Dec 2026');
  });

  it('says overdue in words', async () => {
    const overdue = counter({
      restore_clock: { ...counter().restore_clock!, state: 'overdue' },
    });
    const { el } = await setup({ data: { ...LIST, notices: [overdue, row()] } });
    expect(text(el.querySelector('[data-testid="dmca-clock"]'))).toBe(
      'Overdue. Restore was due by 11 Dec 2026',
    );
  });

  it('filters by ?account= and shows its counts', async () => {
    const { el, api } = await setup({
      query: { account: ACCOUNT, open: 'true' },
      data: { ...LIST, account_counts: { dmca_takedowns: 2, dmca_counter_notices: 1 } },
    });
    expect(api.list).toHaveBeenCalledWith({ account_id: ACCOUNT, open: 'true' });
    const counts = el.querySelector('[data-testid="dmca-account-counts"]')!;
    expect([...counts.querySelectorAll('dd')].map((d) => text(d))).toEqual(['2', '1']);
    expect(text(counts)).toContain('Counter-notices filed');
    expect(el.querySelector<HTMLInputElement>('[data-testid="dmca-open-only"]')?.checked).toBe(
      true,
    );
  });

  it('logs a new notice, then reloads the list', async () => {
    const { el, api, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    const save = el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!;
    type(el, '#admin-dmca-name', 'Rights Holder LLC');
    type(el, '#admin-dmca-contact', 'legal@rights.test');
    type(el, '#admin-dmca-content', 'https://www.aecintegrations.com/vendors/acme');
    await rerender();
    expect(save.disabled).toBe(false);
    save.click();
    await rerender();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'notice',
        submitter_name: 'Rights Holder LLC',
        action: 'pending',
      }),
    );
    // The page load, the select's `?kind=notice` load, then the reload after the save.
    expect(api.list.mock.calls.map((c) => c[0])).toEqual([{}, { kind: 'notice' }, {}]);
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
    // "Log a notice" was disabled during the save. It is enabled again in time to take focus.
    expect(document.activeElement?.id).toBe('admin-dmca-new');
  });

  it('logs an incomplete notice: Save needs no name, contact or material', async () => {
    const { el, api, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    const save = el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!;
    expect(save.disabled).toBe(false);
    expect(el.querySelector('#admin-dmca-name')?.hasAttribute('aria-required')).toBe(false);
    save.click();
    await rerender();
    // Exactly these keys: no name, no contact, no material.
    expect(api.create).toHaveBeenCalledWith({
      kind: 'notice',
      received_at: expect.stringMatching(/T12:00:00\.000Z$/),
      action: 'pending',
    });
  });

  it('a takedown cannot be saved until the material is identified', async () => {
    const { fixture, el, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    const action = fixture.debugElement
      .queryAll(By.directive(AecSelect))
      .map((d) => d.componentInstance as AecSelect)
      .find((c) => c.idPrefix() === 'admin-dmca-action')!;
    action.changed.emit('removed');
    await rerender();
    const save = el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!;
    expect(save.disabled).toBe(true);
    expect(el.textContent).toContain('A removed or disabled notice needs the material identified.');
    expect(el.querySelector('#admin-dmca-content')?.getAttribute('aria-required')).toBe('true');
    type(el, '#admin-dmca-content', 'https://www.aecintegrations.com/vendors/acme');
    await rerender();
    expect(save.disabled).toBe(false);
  });

  it('shows "Not given" for a notice with no name', async () => {
    const { el } = await setup({
      data: { ...LIST, notices: [row({ submitter_name: null, submitter_contact: null })] },
    });
    const cell = el.querySelector('[data-testid="dmca-row"] [data-testid="dmca-not-given"]');
    expect(text(cell)).toBe('Not given');
    expect(text(el.querySelector('[data-testid="dmca-row"] button'))).toContain(
      'the row from Not given',
    );
  });

  it('a slow response to an older filter does not overwrite the newer one', async () => {
    const { el, api, rerender } = await setup();
    const pending: Array<(d: DmcaNoticesResponse) => void> = [];
    api.list.mockImplementation(
      () => new Promise<DmcaNoticesResponse>((resolve) => pending.push(resolve)),
    );
    const openOnly = el.querySelector<HTMLInputElement>('[data-testid="dmca-open-only"]')!;
    openOnly.click(); // load 1: open only
    openOnly.click(); // load 2: everything, the latest
    expect(api.list.mock.calls.slice(-2).map((c) => c[0])).toEqual([{ open: 'true' }, {}]);
    const older = { ...LIST, notices: [row({ id: 'older', submitter_name: 'Older' })] };
    const newer = { ...LIST, notices: [row({ id: 'newer', submitter_name: 'Newer' })] };
    pending[1]!(newer);
    await rerender();
    pending[0]!(older);
    await rerender();
    const ids = [...el.querySelectorAll('[data-testid="dmca-row"]')].map((r) =>
      r.getAttribute('data-id'),
    );
    expect(ids).toEqual(['newer']);
    expect(el.textContent).not.toContain('Loading the log');
  });

  it('a counter-notice cannot be saved until it names its notice', async () => {
    const { el, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    el.querySelector<HTMLInputElement>('#admin-dmca-kind-counter')!.click();
    await rerender();
    type(el, '#admin-dmca-name', 'Uploader');
    type(el, '#admin-dmca-contact', 'me@example.test');
    type(el, '#admin-dmca-content', 'x');
    await rerender();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.disabled).toBe(true);
    expect(el.textContent).toContain('pick the notice this answers');
    // The notice-only field is gone and the counter-notice fields are there.
    expect(el.querySelector('#admin-dmca-work')).toBeNull();
    expect(el.querySelector('#admin-dmca-court')).not.toBeNull();
  });

  it('"Counter-notice to" lists every notice, even one the list filter hides', async () => {
    // "Open only" is on: the list holds only the open counter-notice, and its closed
    // notice is not on screen. The select still offers it, from its own unfiltered load.
    const closed = row({
      id: 'n-closed',
      submitter_name: 'Closed Co',
      closed_at: '2026-11-21T12:00:00.000Z',
    });
    const { fixture, el, api, rerender } = await setup({
      query: { open: 'true' },
      data: { ...LIST, notices: [counter({ notice_id: 'n-closed' })] },
      allNotices: [closed, row()],
    });
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    el.querySelector<HTMLInputElement>('#admin-dmca-kind-counter')!.click();
    await rerender();
    expect(api.list).toHaveBeenCalledWith({ kind: 'notice' });
    const select = fixture.debugElement
      .queryAll(By.directive(AecSelect))
      .map((d) => d.componentInstance as AecSelect)
      .find((c) => c.idPrefix() === 'admin-dmca-notice-id')!;
    expect(select.options().map((o) => o.value)).toEqual(['n-closed', 'n-1']);
    expect(select.options()[0]!.label).toBe('Closed Co, received 20 Nov 2026');
  });

  it('focuses the form heading on open and returns focus to Edit on cancel', async () => {
    const { el, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-id="c-1"] button')!.click();
    await rerender();
    expect(document.activeElement?.id).toBe('admin-dmca-form-heading');
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => text(b) === 'Cancel')!
      .click();
    await rerender();
    expect(document.activeElement?.id).toBe('admin-dmca-edit-c-1');
  });

  it('disables "Log a notice" and every Edit while a save is pending', async () => {
    const { el, api, rerender } = await setup();
    let finish!: () => void;
    api.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ notice: row(), changed: true });
        }),
    );
    const newButton = () => el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!;
    const edits = () => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="dmca-edit"]')];
    edits()[0]!.click();
    await rerender();
    type(el, '#admin-dmca-notes', 'New note');
    await rerender();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.click();
    await rerender();
    expect(newButton().disabled).toBe(true);
    expect(edits().length).toBe(3);
    expect(edits().every((b) => b.disabled)).toBe(true);
    finish();
    await rerender();
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
    expect(newButton().disabled).toBe(false);
    expect(edits().every((b) => !b.disabled)).toBe(true);
  });

  it('a save that completes after its form was replaced leaves the newer form open', async () => {
    // The buttons are disabled while saving. This holds the second line: a completion only
    // closes the form that sent it.
    const { fixture, el, api, rerender } = await setup();
    let finish!: () => void;
    api.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ notice: row(), changed: true });
        }),
    );
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-edit"]')!.click();
    await rerender();
    type(el, '#admin-dmca-notes', 'New note');
    await rerender();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.click();
    await rerender();
    (fixture.componentInstance as unknown as { openCreate(): void }).openCreate();
    await rerender();
    type(el, '#admin-dmca-name', 'Newer draft');
    finish();
    await rerender();
    const form = el.querySelector('[data-testid="dmca-form"]');
    expect(text(form?.querySelector('h3'))).toBe('Log a notice or counter-notice');
    expect(el.querySelector<HTMLInputElement>('#admin-dmca-name')!.value).toBe('Newer draft');
    expect(el.querySelector('[data-testid="dmca-form-error"]')).toBeNull();
    // The earlier write landed, so the list still reloaded.
    expect(api.list.mock.calls.filter((c) => !c[0]?.kind)).toHaveLength(2);
  });

  it('a failed refresh keeps the rows under a visible banner until a load succeeds', async () => {
    const { el, api, rerender } = await setup();
    api.list.mockRejectedValueOnce(new Error('offline'));
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => text(b) === 'Refresh')!
      .click();
    await rerender();
    const banner = el.querySelector('[data-testid="dmca-refresh-error"]');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.classList.contains('sr-only')).toBe(false);
    expect(text(banner)).toContain('The list could not be refreshed and may be out of date.');
    expect(text(banner)).toContain('It shows the log as of 23 Nov 2026 12:00 UTC.');
    // The rows and their deadlines stay readable.
    expect(el.querySelectorAll('[data-testid="dmca-row"]')).toHaveLength(3);
    expect(el.querySelector('[data-testid="dmca-clock"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-refresh-retry"]')!.click();
    await rerender();
    expect(el.querySelector('[data-testid="dmca-refresh-error"]')).toBeNull();
    expect(el.querySelectorAll('[data-testid="dmca-row"]')).toHaveLength(3);
  });

  it('a 409 says someone else changed the notice, and offers a reload', async () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'DMCA_NOTICE_CHANGED', message: 'changed' } },
    });
    const { el, api, rerender } = await setup({ update: conflict });
    const edit = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="dmca-row"] button')][0]!;
    edit.click();
    await rerender();
    type(el, '#admin-dmca-notes', 'New note');
    await rerender();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.click();
    await rerender();
    expect(api.update).toHaveBeenCalledWith('n-1', {
      expected_updated_at: '2026-11-20T13:00:00.000Z',
      notes: 'New note',
    });
    const alert = el.querySelector('[data-testid="dmca-form-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(text(alert)).toContain('Someone else changed this notice. Reload.');
    const reload = [...alert!.querySelectorAll('button')].find((b) => text(b) === 'Reload')!;
    reload.click();
    await rerender();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
  });
});

describe('AdminDmcaNotices on the console recipe (AECI-2128)', () => {
  const escape = (target: EventTarget) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  it('maps every clock state to its ruled console status', () => {
    expect(clockStatusKey('awaiting_forward')).toBe('waitingToForward');
    expect(clockStatusKey('waiting')).toBe('restoreWindowOpens');
    expect(clockStatusKey('restore_window_open')).toBe('restoreBy');
    expect(clockStatusKey('overdue')).toBe('overdue');
    expect(clockStatusKey('court_action')).toBe('courtActionReported');
    expect(clockStatusKey('restored')).toBe('restored');
    expect(clockStatusKey('not_restored')).toBe('notRestored');
  });

  it('draws the restore clock as a dense chip in the waiting tone', async () => {
    const { el } = await setup();
    const chip = el.querySelector('[data-testid="dmca-clock"] .aec-chip');
    expect(chip?.getAttribute('data-density')).toBe('dense');
    expect(chip?.getAttribute('data-tone')).toBe('waiting');
  });

  it('puts the log in a labelled console table region', async () => {
    const { el } = await setup();
    const region = el.querySelector('[role="region"]');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(region?.getAttribute('aria-labelledby')).toBe('admin-dmca-caption');
    expect(region?.querySelector('caption')?.id).toBe('admin-dmca-caption');
  });

  it('Escape closes a new-notice form and returns focus to "Log a notice"', async () => {
    const { el, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-new"]')!.click();
    await rerender();
    escape(el.querySelector('#admin-dmca-name')!);
    await rerender();
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
    expect(document.activeElement?.id).toBe('admin-dmca-new');
  });

  it("Escape closes an edit and returns focus to that row's Edit", async () => {
    const { el, rerender } = await setup();
    el.querySelector<HTMLButtonElement>('[data-id="c-1"] button')!.click();
    await rerender();
    escape(el.querySelector('#admin-dmca-notes')!);
    await rerender();
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
    expect(document.activeElement?.id).toBe('admin-dmca-edit-c-1');
  });

  it('Escape does nothing while a save is in flight', async () => {
    const { el, api, rerender } = await setup();
    let finish!: () => void;
    api.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ notice: row(), changed: true });
        }),
    );
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-edit"]')!.click();
    await rerender();
    type(el, '#admin-dmca-notes', 'New note');
    await rerender();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.click();
    await rerender();
    escape(el.querySelector('#admin-dmca-notes')!);
    await rerender();
    expect(el.querySelector('[data-testid="dmca-form"]')).not.toBeNull();
    finish();
    await rerender();
    expect(el.querySelector('[data-testid="dmca-form"]')).toBeNull();
  });

  it('a refused save moves focus to its message', async () => {
    const refused = new HttpErrorResponse({
      status: 400,
      error: { error: { code: 'VALIDATION_FAILED', field: 'account_id', message: 'x' } },
    });
    const { el, rerender } = await setup({ update: refused });
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-edit"]')!.click();
    await rerender();
    type(el, '#admin-dmca-notes', 'New note');
    await rerender();
    el.querySelector<HTMLButtonElement>('[data-testid="dmca-save"]')!.click();
    await rerender();
    expect(document.activeElement?.id).toBe('admin-dmca-form-error');
    expect(text(document.activeElement)).toBe('No account has that id.');
  });
});
