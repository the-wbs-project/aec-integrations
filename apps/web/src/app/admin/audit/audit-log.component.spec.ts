/**
 * AECI-653 — `/admin/audit`, the global audit log (`ADMIN_PANEL_SPEC.md` §5.18).
 *
 * The page is a filter form over the shared `<aec-audit-trail>`, whose rendering
 * has its own spec. What earns a test here is the wiring:
 *
 *  1. **The URL is the state.** Params seed the form and the first fetch, Apply
 *     and paging write the URL, and a URL change re-fetches. A real router is
 *     used rather than a stub, because the claim is that the page reacts to the
 *     router, not to a value handed to it once.
 *  2. **The window.** The 30-day default applies only with no indexed filter
 *     and no date. The preset row's pressed chip is derived, and presets never
 *     seed the date inputs.
 *  3. **Cursor paging (ADR 0046).** Next / Previous / First write `after` /
 *     `before`, the draft survives a page move, focus lands on the result line,
 *     and the total is counted once per filter set.
 *  4. **The two server refusals are caught in the form**, so the operator reads
 *     the rule instead of a 400.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAuditLogResponse, AdminAuditRow } from '@aeci/shared';

import { AecSelect } from '../../shared/aec-select/aec-select';
import { AdminAuditApi } from './admin-audit-api';
import { AuditLog } from './audit-log';

const VENDOR_ID = '00000000-0000-4000-8000-0000000000c1';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000b1';
const NEXT = '2026-10-20T12:00:00.000Z|00000000-0000-4000-8000-0000000000a9';
const PREV = '2026-10-21T12:00:00.000Z|00000000-0000-4000-8000-0000000000a2';
/** A cursor as the router serialises it: the pipe is escaped, the colons are not. */
const inUrl = (cursor: string) => cursor.replace('|', '%7C');
/** The paging params a first page sends. */
const FIRST_PAGE = { perPage: 25, order: 'desc', count: 1 };

function makeRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    action: 'vendor.updated',
    actor: { id: ACTOR_ID, display_name: null, email: null },
    actor_type: 'admin',
    entity_type: 'vendor',
    entity_id: VENDOR_ID,
    created_at: '2026-10-20T12:00:00.000Z',
    before_state: null,
    after_state: null,
    ...over,
  };
}

function makePage(over: Partial<AdminAuditLogResponse> = {}): AdminAuditLogResponse {
  return {
    data: [makeRow()],
    perPage: 25,
    total: 1,
    has_next: false,
    has_prev: false,
    next_cursor: null,
    prev_cursor: null,
    actor_emails_available: true,
    ...over,
  };
}

interface ApiMock {
  listAudit: ReturnType<typeof vi.fn>;
}

function makeApi(impl?: () => Promise<AdminAuditLogResponse>): ApiMock {
  return { listAudit: vi.fn(impl ?? (async () => makePage())) };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(url: string, api: ApiMock = makeApi()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: 'admin/audit', component: AuditLog }]),
      { provide: AdminAuditApi, useValue: api },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await drain(harness);
  return { harness, api, el: harness.routeNativeElement as HTMLElement };
}

async function drain(harness: RouterTestingHarness): Promise<void> {
  await harness.fixture.whenStable();
  await settle();
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

function lastQuery(api: ApiMock): Record<string, unknown> {
  return api.listAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function input(el: HTMLElement, id: string): HTMLInputElement {
  return el.querySelector(`#${id}`) as HTMLInputElement;
}

function type(el: HTMLElement, id: string, value: string): void {
  const field = input(el, id);
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement;
}

function submit(el: HTMLElement): void {
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

/** The label of the pressed preset chip, or `null` when none is pressed. */
function pressedChip(el: HTMLElement): string | null {
  const pressed = el.querySelector('[role="group"] button[aria-pressed="true"]');
  return pressed?.textContent?.trim() ?? null;
}

function alerts(el: HTMLElement): string[] {
  return [...el.querySelectorAll('form [role="alert"]')].map((a) => a.textContent?.trim() ?? '');
}

describe('AuditLog', () => {
  beforeEach(() => {
    // Only the clock is faked: the default window is "today (UTC) minus 29 days",
    // and the router and the fetch still need real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T09:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the URL is the state', () => {
    it('seeds the form and the first fetch from the query params', async () => {
      const { api, el } = await setup(
        `/admin/audit?entity_type=vendor&entity_id=${VENDOR_ID}&action=vendor.updated&actor_id=${ACTOR_ID}&actor_type=admin&from=2026-10-01&to=2026-10-10&after=${encodeURIComponent(NEXT)}&order=asc&perPage=50`,
      );
      expect(api.listAudit).toHaveBeenCalledTimes(1);
      expect(lastQuery(api)).toEqual({
        entity_type: 'vendor',
        entity_id: VENDOR_ID,
        action: 'vendor.updated',
        actor_id: ACTOR_ID,
        actor_type: 'admin',
        from: '2026-10-01',
        to: '2026-10-10',
        after: NEXT,
        order: 'asc',
        perPage: 50,
        count: 1,
      });
      expect(input(el, 'admin-audit-log-entity-type').value).toBe('vendor');
      expect(input(el, 'admin-audit-log-entity-id').value).toBe(VENDOR_ID);
      expect(input(el, 'admin-audit-log-action').value).toBe('vendor.updated');
      expect(input(el, 'admin-audit-log-actor-id').value).toBe(ACTOR_ID);
      expect(input(el, 'admin-audit-log-from').value).toBe('2026-10-01');
      expect(input(el, 'admin-audit-log-to').value).toBe('2026-10-10');
    });

    it('drops params the server would refuse instead of sending them', async () => {
      const { api } = await setup(
        `/admin/audit?entity_id=${VENDOR_ID}&actor_id=someone@acme.com&actor_type=robot&action=vendor.updated&from=2026-10-10&to=2026-10-01&perPage=30&order=up&range=forever&after=junk`,
      );
      // No type, so the id goes. Not a uuid, not a known type, from after to, not
      // an offered size, not an order, not a preset, not a cursor.
      expect(lastQuery(api)).toEqual({ action: 'vendor.updated', ...FIRST_PAGE });
    });

    it('drops both cursors when both decode', async () => {
      const { api } = await setup(
        `/admin/audit?action=vendor.updated&after=${encodeURIComponent(NEXT)}&before=${encodeURIComponent(PREV)}`,
      );
      expect(lastQuery(api)).toEqual({ action: 'vendor.updated', ...FIRST_PAGE });
    });

    it('Apply writes the filters to the URL, dropping blanks and the cursor', async () => {
      const { harness, el } = await setup(
        `/admin/audit?entity_type=vendor&after=${encodeURIComponent(NEXT)}`,
      );
      type(el, 'admin-audit-log-entity-id', VENDOR_ID);
      type(el, 'admin-audit-log-action', 'vendor.updated');
      submit(el);
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe(
        `/admin/audit?entity_type=vendor&entity_id=${VENDOR_ID}&action=vendor.updated`,
      );
    });

    it('sends the actor type picked in the select', async () => {
      const { harness, api, el } = await setup('/admin/audit?action=vendor.updated');
      const select = harness.fixture.debugElement.query(By.directive(AecSelect));
      select.componentInstance.changed.emit('system');
      harness.detectChanges();
      submit(el);
      await drain(harness);
      expect(lastQuery(api)).toMatchObject({ action: 'vendor.updated', actor_type: 'system' });
    });

    it('re-fetches when the query params change, reusing the same instance', async () => {
      const { harness, api, el } = await setup('/admin/audit?action=vendor.updated');
      const before = harness.routeDebugElement?.componentInstance;
      await harness.navigateByUrl(`/admin/audit?entity_type=vendor&entity_id=${VENDOR_ID}`);
      await drain(harness);
      expect(harness.routeDebugElement?.componentInstance).toBe(before);
      expect(api.listAudit).toHaveBeenCalledTimes(2);
      expect(lastQuery(api)).toEqual({
        entity_type: 'vendor',
        entity_id: VENDOR_ID,
        ...FIRST_PAGE,
      });
      // The form follows the URL, so it never shows filters other than the ones applied.
      expect(input(el, 'admin-audit-log-action').value).toBe('');
      expect(input(el, 'admin-audit-log-entity-type').value).toBe('vendor');
    });

    it('links each row to that entity in the same log, with an absolute href', async () => {
      const { el } = await setup('/admin/audit?action=vendor.updated');
      const link = el.querySelector('tbody td:nth-of-type(3) a') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(
        `/admin/audit?entity_type=vendor&entity_id=${VENDOR_ID}`,
      );
    });
  });

  describe('the window and the preset row', () => {
    it('applies 30 days to a bare URL without seeding the date inputs', async () => {
      const { api, el } = await setup('/admin/audit');
      expect(lastQuery(api)).toEqual({ from: '2026-09-24', to: '2026-10-23', ...FIRST_PAGE });
      expect(input(el, 'admin-audit-log-from').value).toBe('');
      expect(input(el, 'admin-audit-log-to').value).toBe('');
      expect(pressedChip(el)).toBe('30 days');
      expect(el.textContent).toContain('the log shows the last 30 days unless you pick another');
    });

    it('derives the chip: explicit range, typed dates, filter, and bare', async () => {
      // Explicit range: that chip, and the range resolves to dates for the fetch.
      const ranged = await setup('/admin/audit?range=7d');
      expect(pressedChip(ranged.el)).toBe('7 days');
      expect(lastQuery(ranged.api)).toMatchObject({ from: '2026-10-17', to: '2026-10-23' });
      // Typed dates: Custom, no chip pressed.
      const typed = await setup('/admin/audit?from=2026-10-01&to=2026-10-02');
      expect(pressedChip(typed.el)).toBeNull();
      expect(typed.el.textContent).toContain('Custom dates');
      // An indexed filter and no range: All time.
      const filtered = await setup('/admin/audit?action=vendor.updated');
      expect(pressedChip(filtered.el)).toBe('All time');
      // Bare: the 30-day default.
      expect(pressedChip((await setup('/admin/audit')).el)).toBe('30 days');
    });

    it('a chip clears typed dates and Apply writes the range; typing a date clears it', async () => {
      const { harness, api, el } = await setup('/admin/audit?from=2026-10-01&to=2026-10-02');
      buttonByText(el, '90 days').click();
      harness.detectChanges();
      expect(input(el, 'admin-audit-log-from').value).toBe('');
      expect(pressedChip(el)).toBe('90 days');
      submit(el);
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?range=90d');
      expect(lastQuery(api)).toMatchObject({ from: '2026-07-26', to: '2026-10-23' });
      type(el, 'admin-audit-log-from', '2026-10-05');
      harness.detectChanges();
      expect(pressedChip(el)).toBeNull();
    });

    it('All time sends no dates', async () => {
      const { api } = await setup('/admin/audit?action=vendor.updated&range=all');
      expect(lastQuery(api)).toEqual({ action: 'vendor.updated', ...FIRST_PAGE });
    });

    it('an entity type plus Apply reads the full history, not the default window', async () => {
      const { harness, api, el } = await setup('/admin/audit');
      type(el, 'admin-audit-log-entity-type', 'vendor');
      harness.detectChanges();
      expect(pressedChip(el)).toBe('All time');
      submit(el);
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?entity_type=vendor');
      expect(lastQuery(api)).toEqual({ entity_type: 'vendor', ...FIRST_PAGE });
    });

    it('says so when the link carried dates out of order', async () => {
      const { el } = await setup(
        '/admin/audit?action=vendor.updated&from=2026-10-10&to=2026-10-01',
      );
      expect(el.querySelector('[data-testid="audit-log-url-notice"]')?.textContent).toContain(
        'The dates in the link were out of order and were ignored.',
      );
      const clean = await setup('/admin/audit?action=vendor.updated');
      expect(clean.el.querySelector('[data-testid="audit-log-url-notice"]')).toBeNull();
    });

    it('also applies when actor type is the only filter, so that URL is not a 400', async () => {
      const { api } = await setup('/admin/audit?actor_type=system');
      expect(lastQuery(api)).toMatchObject({
        actor_type: 'system',
        from: '2026-09-24',
        to: '2026-10-23',
      });
    });

    it('does not apply to a deep link: an entity gets its full history', async () => {
      const { api, el } = await setup(`/admin/audit?entity_type=vendor&entity_id=${VENDOR_ID}`);
      expect(lastQuery(api)).toEqual({
        entity_type: 'vendor',
        entity_id: VENDOR_ID,
        ...FIRST_PAGE,
      });
      expect(input(el, 'admin-audit-log-from').value).toBe('');
      expect(el.textContent).not.toContain('the log shows the last 30 days');
    });

    it('Clear filters returns to the bare URL, which is the window', async () => {
      const { harness, api, el } = await setup('/admin/audit?action=vendor.updated');
      buttonByText(el, 'Clear filters').click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit');
      expect(lastQuery(api)).toEqual({ from: '2026-09-24', to: '2026-10-23', ...FIRST_PAGE });
    });

    it('Clear filters resets an unapplied draft when the URL is already bare', async () => {
      const { harness, el } = await setup('/admin/audit');
      type(el, 'admin-audit-log-action', 'vendor.updated');
      buttonByText(el, '90 days').click();
      harness.detectChanges();
      buttonByText(el, 'Clear filters').click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit');
      expect(input(el, 'admin-audit-log-action').value).toBe('');
      expect(pressedChip(el)).toBe('30 days');
    });
  });

  describe('cursor paging (ADR 0046)', () => {
    const paged = () =>
      makeApi(async () =>
        makePage({
          total: 60,
          has_next: true,
          has_prev: true,
          next_cursor: NEXT,
          prev_cursor: PREV,
        }),
      );

    it('Next writes after, keeping the filters, and reuses the total with count=0', async () => {
      const api = paged();
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', api);
      expect(lastQuery(api)).toMatchObject({ count: 1 });
      buttonByText(el, 'Next').click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe(
        `/admin/audit?action=vendor.updated&after=${inUrl(NEXT)}`,
      );
      expect(lastQuery(api)).toEqual({
        action: 'vendor.updated',
        after: NEXT,
        perPage: 25,
        order: 'desc',
        count: 0,
      });
    });

    it('keeps showing the remembered total when a later page returns total null', async () => {
      let calls = 0;
      const api = makeApi(async () =>
        makePage({
          total: calls++ === 0 ? 60 : null,
          has_next: true,
          next_cursor: NEXT,
        }),
      );
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', api);
      buttonByText(el, 'Next').click();
      await drain(harness);
      expect(el.querySelector('#audit-trail-result')?.textContent).toContain('60 entries');
    });

    it('a cursored deep link has no total, so it counts', async () => {
      const { api } = await setup(
        `/admin/audit?action=vendor.updated&before=${encodeURIComponent(PREV)}`,
      );
      expect(lastQuery(api)).toMatchObject({ before: PREV, count: 1 });
    });

    it('Previous writes before and nulls after; First page nulls both', async () => {
      const api = paged();
      const { harness, el } = await setup(
        `/admin/audit?action=vendor.updated&after=${encodeURIComponent(NEXT)}`,
        api,
      );
      buttonByText(el, 'Previous').click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe(
        `/admin/audit?action=vendor.updated&before=${inUrl(PREV)}`,
      );
      buttonByText(el, 'First page').click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?action=vendor.updated');
    });

    it('the draft survives a page move', async () => {
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', paged());
      type(el, 'admin-audit-log-entity-type', 'vendor_request');
      buttonByText(el, 'Next').click();
      await drain(harness);
      expect(input(el, 'admin-audit-log-entity-type').value).toBe('vendor_request');
    });

    it('moves focus to the result line after Next, and announces the move', async () => {
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', paged());
      buttonByText(el, 'Next').click();
      await drain(harness);
      expect(document.activeElement?.id).toBe('audit-trail-result');
      expect(el.querySelector('[role="status"]')?.textContent).toContain(
        'Showing 1 entry, newest first',
      );
    });

    it('does not move focus on the first load or on Apply', async () => {
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', paged());
      expect(document.activeElement?.id).not.toBe('audit-trail-result');
      submit(el);
      await drain(harness);
      expect(document.activeElement?.id).not.toBe('audit-trail-result');
    });

    it('the sort header writes order and drops the cursor', async () => {
      const api = paged();
      const { harness, el } = await setup(
        `/admin/audit?action=vendor.updated&after=${encodeURIComponent(NEXT)}`,
        api,
      );
      (el.querySelector('thead th[aria-sort] button') as HTMLButtonElement).click();
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?action=vendor.updated&order=asc');
      expect(lastQuery(api)).toMatchObject({ order: 'asc', count: 0 });
      expect(lastQuery(api)).not.toHaveProperty('after');
    });

    it('a page size writes perPage and drops the cursor', async () => {
      const { harness, el } = await setup(
        `/admin/audit?action=vendor.updated&after=${encodeURIComponent(NEXT)}`,
        paged(),
      );
      const select = el.querySelector(
        'aec-admin-cursor-paginator select',
      ) as unknown as HTMLSelectElement;
      select.value = '100';
      select.dispatchEvent(new Event('change'));
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?action=vendor.updated&perPage=100');
    });

    it('an empty page reached by a cursor says so and still offers First page', async () => {
      const api = makeApi(async () =>
        makePage({ data: [], total: null, has_next: false, has_prev: true }),
      );
      const { el } = await setup(
        `/admin/audit?action=vendor.updated&after=${encodeURIComponent(NEXT)}`,
        api,
      );
      expect(el.textContent).toContain('No entries on this page.');
      expect(buttonByText(el, 'First page')).toBeDefined();
      // The flag says rows exist that way, but there is no cursor to send.
      expect(buttonByText(el, 'Previous').disabled).toBe(true);
    });
  });

  describe('filter hints', () => {
    it('explains a value the suggestions do not know, without blocking Apply', async () => {
      const { harness, el } = await setup('/admin/audit?action=vendor.updated');
      expect(el.querySelector('#admin-audit-log-action-hint')).toBeNull();
      type(el, 'admin-audit-log-action', 'vendor.updatd');
      type(el, 'admin-audit-log-entity-type', 'vendr');
      harness.detectChanges();
      expect(el.querySelector('#admin-audit-log-action-hint')?.textContent).toContain(
        'Not a value this list knows. Apply still searches for it exactly.',
      );
      expect(input(el, 'admin-audit-log-action').getAttribute('aria-describedby')).toBe(
        'admin-audit-log-action-hint',
      );
      expect(el.querySelector('#admin-audit-log-entity-type-hint')).not.toBeNull();
      submit(el);
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe(
        '/admin/audit?entity_type=vendr&action=vendor.updatd',
      );
    });
  });

  describe('client validation mirrors the server', () => {
    it('blocks an entity id with no entity type', async () => {
      const { harness, api, el } = await setup(`/admin/audit?entity_type=vendor`);
      type(el, 'admin-audit-log-entity-id', VENDOR_ID);
      type(el, 'admin-audit-log-entity-type', '');
      harness.detectChanges();
      // Still editable while it holds a value, so the operator can clear it.
      expect(input(el, 'admin-audit-log-entity-id').disabled).toBe(false);
      submit(el);
      await drain(harness);
      expect(api.listAudit).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(Router).url).toBe('/admin/audit?entity_type=vendor');
      expect(alerts(el)).toEqual([
        'An entity id needs an entity type. Add the type, or clear the id.',
      ]);
      const field = input(el, 'admin-audit-log-entity-id');
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toContain('admin-audit-log-entity-id-error');
    });

    it('disables the entity id until there is an entity type', async () => {
      const { harness, el } = await setup('/admin/audit');
      expect(input(el, 'admin-audit-log-entity-id').disabled).toBe(true);
      type(el, 'admin-audit-log-entity-type', 'vendor');
      harness.detectChanges();
      expect(input(el, 'admin-audit-log-entity-id').disabled).toBe(false);
    });

    it('blocks actor type as the only constraint, which All time makes it', async () => {
      const { harness, api, el } = await setup('/admin/audit');
      // With the 30-day default the window is a date range, so it is allowed.
      buttonByText(el, 'All time').click();
      harness.fixture.debugElement
        .query(By.directive(AecSelect))
        .componentInstance.changed.emit('system');
      harness.detectChanges();
      submit(el);
      await drain(harness);
      expect(api.listAudit).toHaveBeenCalledTimes(1);
      expect(alerts(el)).toEqual([
        'Actor type needs another filter or a date range. On its own it would count the whole ledger.',
      ]);
    });

    it('blocks a start date after the end date, and an email as the actor id', async () => {
      const { harness, el } = await setup('/admin/audit');
      type(el, 'admin-audit-log-from', '2026-10-20');
      type(el, 'admin-audit-log-to', '2026-10-01');
      type(el, 'admin-audit-log-actor-id', 'ada@aecintegrations.com');
      submit(el);
      await drain(harness);
      expect(TestBed.inject(Router).url).toBe('/admin/audit');
      expect(alerts(el)).toEqual([
        'Enter the account id. It is a UUID, never an email address.',
        'The start date is after the end date.',
      ]);
    });
  });

  describe('failure states', () => {
    it('shows the error with a retry, and the retry re-fetches', async () => {
      let fail = true;
      const api = makeApi(async () => {
        if (fail) throw { status: 500 };
        return makePage();
      });
      const { harness, el } = await setup('/admin/audit?action=vendor.updated', api);
      expect(el.textContent).toContain("We couldn't load the audit trail.");
      fail = false;
      buttonByText(el, 'Try again').click();
      await drain(harness);
      expect(api.listAudit).toHaveBeenCalledTimes(2);
      expect(el.querySelectorAll('tbody tr').length).toBe(1);
    });

    it('renders a readable message for a 400, not a pointless retry', async () => {
      const api = makeApi(async () => {
        throw { status: 400 };
      });
      const { el } = await setup('/admin/audit?action=vendor.updated', api);
      expect(el.textContent).toContain('The audit log could not use these filters.');
      expect(buttonByText(el, 'Try again')).toBeUndefined();
    });

    it('says "unavailable" when the email lookup failed', async () => {
      const api = makeApi(async () => makePage({ actor_emails_available: false }));
      const { el } = await setup('/admin/audit?action=vendor.updated', api);
      expect(el.textContent).toContain('Account details unavailable');
    });

    it('uses the filter-aware empty line', async () => {
      const api = makeApi(async () => makePage({ data: [], total: 0 }));
      const { el } = await setup('/admin/audit?action=vendor.updated', api);
      expect(el.textContent).toContain('No entries match these filters.');
      expect(el.textContent).not.toContain('Nothing recorded for this scope.');
    });
  });
});
