/**
 * `ReindexHistory`, the submission history on `/admin/reindex` (AECI-1188).
 * Source of truth: `ADMIN_PANEL_SPEC.md` §5.11.
 *
 * What these tests hold in place:
 *
 *  1. **Each filter reaches the request, and a refilter goes back to page 1.**
 *  2. **The vendor filter is set from a row** and removed by its chip or by
 *     Clear filters.
 *  3. **From after To is refused without a request.**
 *  4. **Empty and "no matches" are different sentences.**
 *  5. **Each cause renders** its source, its audit action label, its product, and
 *     a link to `/admin/vendors/:id`. Nothing links to an audit-by-id page.
 *  6. **No copy says "indexed"** beyond the one sentence that says we do not know.
 *
 * Harness mirrors `email-activity.component.spec.ts`: zoneless, plus a macrotask
 * `settle()` to drain `afterNextRender`'s async load.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListReindexSubmissionsResponse, ReindexSubmissionRow } from '@aeci/shared';

import { AdminReindexApi } from './admin-reindex.api';
import { ReindexHistory } from './reindex-history';

const AUTODESK = '00000000-0000-4000-8000-000000000001';
const BENTLEY = '00000000-0000-4000-8000-000000000002';
const PAIR_URL =
  'https://www.aecintegrations.com/products/autodesk-build/integrations/microstation';

function makeRow(over: Partial<ReindexSubmissionRow> = {}): ReindexSubmissionRow {
  return {
    id: 7,
    url: PAIR_URL,
    channel: 'indexnow',
    outcome: 'accepted',
    http_status: 200,
    priority: 1,
    submitted_at: '2026-10-04T00:05:00.000Z',
    causes: [
      {
        source: 'vendor',
        audit_log_id: 'audit-a',
        action: 'product.updated',
        vendor: { id: AUTODESK, slug: 'autodesk', name: 'Autodesk' },
        product: { id: 'p1', slug: 'autodesk-build', name: 'Autodesk Build' },
        promote_job_id: null,
        queued_at: '2026-10-03T12:00:00.000Z',
      },
      {
        source: 'vendor',
        audit_log_id: 'audit-b',
        action: 'integration.updated',
        vendor: { id: BENTLEY, slug: 'bentley', name: 'Bentley' },
        product: { id: 'p2', slug: 'microstation', name: 'MicroStation' },
        promote_job_id: null,
        queued_at: '2026-10-03T13:00:00.000Z',
      },
    ],
    ...over,
  };
}

function page(over: Partial<ListReindexSubmissionsResponse> = {}): ListReindexSubmissionsResponse {
  return { data: [makeRow()], page: 1, perPage: 25, total: 1, ...over };
}

interface ApiMock {
  submissions: ReturnType<typeof vi.fn>;
}

function makeApi(answer: ListReindexSubmissionsResponse | HttpErrorResponse = page()): ApiMock {
  return {
    submissions: vi.fn(async () => {
      if (answer instanceof HttpErrorResponse) throw answer;
      return structuredClone(answer);
    }),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApi()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminReindexApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ReindexHistory);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rerender = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmp = fixture.componentInstance as any;
  return { fixture, api, el, rerender, cmp };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`No button "${text}"`);
  return btn;
}

const lastQuery = (api: ApiMock) => api.submissions.mock.calls.at(-1)![0];

async function setDate(
  el: HTMLElement,
  rerender: () => Promise<void>,
  id: 'from' | 'to',
  value: string,
) {
  const input = el.querySelector<HTMLInputElement>(`#admin-reindex-history-${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event('change'));
  await rerender();
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

describe('ReindexHistory', () => {
  it('loads page 1 at 25 a page with no filter set', async () => {
    const { api } = await setup();
    expect(api.submissions).toHaveBeenCalledTimes(1);
    expect(lastQuery(api)).toEqual({
      page: 1,
      perPage: 25,
      vendorId: undefined,
      channel: undefined,
      outcome: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it('renders one row per submission with every cause', async () => {
    const { el } = await setup();
    const rows = el.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.querySelector('th')?.textContent).toContain(PAIR_URL);
    expect(row.textContent).toContain('IndexNow (Bing, Yandex)');
    expect(row.textContent).toContain('Accepted');
    expect(row.textContent).toContain('HTTP');
    expect(row.textContent).toContain('200');
    const causes = row.querySelectorAll('li');
    expect(causes).toHaveLength(2);
    expect(causes[0]!.textContent).toContain('Vendor edit');
    expect(causes[0]!.textContent).toContain('Autodesk Build');
    expect(causes[1]!.textContent).toContain('MicroStation');
    expect(el.textContent).toContain('1 submission matches.');
  });

  it('labels the audit action with the shared audit vocabulary', async () => {
    const { el } = await setup();
    const first = el.querySelector('li')!.textContent!;
    // The label map, not the raw slug.
    expect(first).not.toContain('product.updated');
    expect(first).toMatch(/·\s*\S/);
  });

  it('links each vendor cause to its admin page, and nothing to an audit page', async () => {
    const { el } = await setup();
    const link = el.querySelector<HTMLAnchorElement>(`a[href="/admin/vendors/${AUTODESK}"]`);
    expect(link?.textContent?.trim()).toBe('Autodesk');
    expect(el.querySelector(`a[href="/admin/vendors/${BENTLEY}"]`)).not.toBeNull();
    expect(el.querySelector('a[href*="/admin/audit"]')).toBeNull();
    for (const a of el.querySelectorAll('a')) {
      expect(a.getAttribute('href')?.startsWith('#')).toBe(false);
    }
  });

  it('renders a promote cause, a deleted vendor and a submission with no cause', async () => {
    const { el } = await setup(
      makeApi(
        page({
          total: 2,
          data: [
            makeRow({
              id: 1,
              channel: 'gsc_manual',
              outcome: 'requested',
              http_status: null,
              causes: [
                {
                  source: 'promote',
                  audit_log_id: null,
                  action: null,
                  vendor: null,
                  product: null,
                  promote_job_id: 'job-123',
                  queued_at: '2026-10-03T12:00:00.000Z',
                },
                {
                  source: 'vendor',
                  audit_log_id: 'x',
                  action: null,
                  vendor: { id: 'gone', slug: null, name: null },
                  product: null,
                  promote_job_id: null,
                  queued_at: '2026-10-03T12:00:00.000Z',
                },
              ],
            }),
            makeRow({ id: 2, outcome: 'refused', http_status: 429, causes: [] }),
          ],
        }),
      ),
    );
    const [first, second] = [...el.querySelectorAll('tbody tr')];
    expect(first!.textContent).toContain('Search Console, by hand');
    expect(first!.textContent).toContain('Requested');
    expect(first!.textContent).not.toContain('HTTP');
    expect(first!.textContent).toContain('Promote');
    expect(first!.textContent).toContain('job-123');
    expect(first!.textContent).toContain('Deleted vendor');
    expect(second!.textContent).toContain('Refused');
    expect(second!.textContent).toContain('429');
    expect(second!.textContent).toContain('Not recorded');
  });

  it('sends channel and outcome filters and resets to page 1', async () => {
    const { api, cmp, rerender } = await setup(makeApi(page({ total: 80 })));
    cmp.goToPage(3);
    await rerender();
    expect(lastQuery(api).page).toBe(3);

    cmp.onChannel('gsc_manual');
    await rerender();
    expect(lastQuery(api)).toMatchObject({ page: 1, channel: 'gsc_manual' });

    cmp.onOutcome('requested');
    await rerender();
    expect(lastQuery(api)).toMatchObject({ page: 1, channel: 'gsc_manual', outcome: 'requested' });
  });

  it('sends the date range', async () => {
    const { api, el, rerender } = await setup();
    await setDate(el, rerender, 'from', '2026-10-01');
    await setDate(el, rerender, 'to', '2026-10-04');
    expect(lastQuery(api)).toMatchObject({ page: 1, from: '2026-10-01', to: '2026-10-04' });
  });

  it('refuses From after To without a request', async () => {
    const { api, el, rerender } = await setup();
    await setDate(el, rerender, 'to', '2026-10-01');
    const calls = api.submissions.mock.calls.length;
    await setDate(el, rerender, 'from', '2026-10-05');
    expect(api.submissions.mock.calls.length).toBe(calls);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('From date is not after');
  });

  it('sets the vendor filter from a row, shows a chip, and removes it', async () => {
    const { api, el, rerender } = await setup();
    expect(el.textContent).toContain('select Only this vendor');

    buttonByText(el.querySelector('li')!, 'Only this vendor').click();
    await rerender();
    expect(lastQuery(api)).toMatchObject({ page: 1, vendorId: AUTODESK });
    expect(el.textContent).not.toContain('select Only this vendor');
    // The chip names the vendor; the filtered vendor's own row loses its button.
    const chipRemove = buttonByText(el, 'Remove');
    expect(chipRemove.parentElement?.textContent).toContain('Autodesk');
    const autodeskCause = el.querySelectorAll('li')[0]!;
    expect([...autodeskCause.querySelectorAll('button')]).toHaveLength(0);

    chipRemove.click();
    await rerender();
    expect(lastQuery(api).vendorId).toBeUndefined();
  });

  it('moves focus to the chip, then to the heading, as the pressed buttons vanish', async () => {
    const { el, rerender } = await setup();
    document.body.appendChild(el);
    buttonByText(el.querySelector('li')!, 'Only this vendor').click();
    await rerender();
    expect(document.activeElement?.textContent).toContain('Remove');

    (document.activeElement as HTMLButtonElement).click();
    await rerender();
    expect(document.activeElement?.id).toBe('admin-reindex-history-heading');
    el.remove();
  });

  it('Clear filters drops every filter, the vendor included', async () => {
    const { api, el, cmp, rerender } = await setup();
    buttonByText(el.querySelector('li')!, 'Only this vendor').click();
    cmp.onOutcome('failed');
    await rerender();
    expect(lastQuery(api)).toMatchObject({ vendorId: AUTODESK, outcome: 'failed' });

    buttonByText(el, 'Clear filters').click();
    await rerender();
    expect(lastQuery(api)).toMatchObject({
      page: 1,
      vendorId: undefined,
      channel: undefined,
      outcome: undefined,
      from: undefined,
      to: undefined,
    });
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Clear filters')),
    ).toBe(false);
  });

  it('says nothing was submitted when empty, and "no matches" under a filter', async () => {
    const api = makeApi(page({ data: [], total: 0 }));
    const { el, cmp, rerender } = await setup(api);
    expect(el.textContent).toContain('Nothing has been submitted yet.');
    expect(el.textContent).not.toContain('No submissions match');

    cmp.onChannel('indexnow');
    await rerender();
    expect(el.textContent).toContain('No submissions match these filters.');
    expect(el.textContent).not.toContain('Nothing has been submitted yet.');
  });

  it('announces the count after a refilter, not on first load, and owns no live region', async () => {
    const { cmp, el, rerender } = await setup();
    const heard: string[] = [];
    cmp.announce.subscribe((m: string) => heard.push(m));
    expect(el.querySelector('[role="status"], [aria-live]')).toBeNull();
    cmp.onChannel('indexnow');
    await rerender();
    expect(heard).toEqual(['Matching submissions: 1.']);
  });

  it('keeps the table mounted and marks it busy while a refilter runs', async () => {
    let release!: (v: ListReindexSubmissionsResponse) => void;
    const api = makeApi();
    const { el, cmp, fixture } = await setup(api);
    api.submissions.mockImplementationOnce(
      () => new Promise<ListReindexSubmissionsResponse>((r) => (release = r)),
    );
    cmp.onOutcome('accepted');
    fixture.detectChanges();
    expect(el.querySelector('table')).not.toBeNull();
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.textContent).toContain('Updating');
    release(page());
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('blames the session only on 401/403, and offers a retry', async () => {
    const server = await setup(makeApi(new HttpErrorResponse({ status: 500 })));
    expect(server.el.textContent).toContain("We couldn't load the submission history.");
    expect(server.el.textContent).not.toContain('Your session may have expired.');
    server.api.submissions.mockImplementation(async () => page());
    buttonByText(server.el, 'Try again').click();
    await server.rerender();
    expect(server.el.querySelectorAll('tbody tr')).toHaveLength(1);

    const auth = await setup(makeApi(new HttpErrorResponse({ status: 403 })));
    expect(auth.el.textContent).toContain('Your session may have expired.');
  });

  it('never says a page was indexed, except to say we do not know', async () => {
    const { el } = await setup();
    const text = el.textContent!.replace(/\s+/g, ' ');
    const mentions = text.match(/indexed/gi) ?? [];
    expect(mentions).toHaveLength(1);
    expect(text).toContain('It does not say whether a search engine indexed the page.');
  });

  describe('accessibility (structural)', () => {
    it('names the table, scopes every header, and labels the date inputs', async () => {
      const { el } = await setup();
      expect(el.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      const cols = [...el.querySelectorAll('thead th')];
      expect(cols).toHaveLength(5);
      for (const th of cols) expect(th.getAttribute('scope')).toBe('col');
      for (const id of ['admin-reindex-history-from', 'admin-reindex-history-to']) {
        expect(el.querySelector(`label[for="${id}"]`)).not.toBeNull();
      }
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelector('h1, h3, h4, h5, h6')).toBeNull();
    });

    it('gives each "Only this vendor" button the vendor name for a screen reader', async () => {
      const { el } = await setup();
      const btn = buttonByText(el.querySelectorAll('li')[1]!, 'Only this vendor');
      expect(btn.querySelector('.sr-only')?.textContent).toContain('Bentley');
    });
  });
});
