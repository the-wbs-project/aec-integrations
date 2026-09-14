/**
 * AECI-946 — `ReindexList` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention). What is covered here is the logic the
 * rendered surface cannot be read for: the server's order is rendered verbatim,
 * Done removes the row and ticks the nav badge down, a 404 removes the row and
 * does NOT, the reason fallback survives a slug this build has never seen, and
 * the empty state says an empty list is the good outcome.
 *
 * ── WHY THE 404 CASE HAS ITS OWN TEST ────────────────────────────────────────
 * Done deletes. Two operators walking the same worklist is the ordinary case, not
 * an edge case, and the second one's `DELETE` 404s. Dropping the row is right;
 * decrementing again is not, because the first operator's own action already did.
 * A double decrement walks the badge below the real backlog and nothing resyncs
 * it until the next full visit to `/admin`.
 *
 * Harness mirrors `request-queue.component.spec.ts`: zoneless + a macrotask
 * `settle()` drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListReindexQueueResponse, ReindexQueueRow } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminReindexApi } from './admin-reindex.api';
import { ReindexList } from './reindex-list';

function makeRow(over: Partial<ReindexQueueRow> & { id: number }): ReindexQueueRow {
  return {
    id: over.id,
    url: over.url ?? `https://www.aecintegrations.com/products/product-${over.id}`,
    priority: over.priority ?? 2,
    reason: over.reason ?? 'product.updated',
    source: over.source ?? 'promote',
    queued_at: over.queued_at ?? new Date(Date.now() - 90 * 60_000).toISOString(),
  };
}

interface ApiMock {
  list: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: ReindexQueueRow[], total = rows.length): ApiMock {
  const page: ListReindexQueueResponse = { data: rows, page: 1, perPage: 25, total };
  return {
    list: vi.fn(async () => structuredClone(page)),
    clear: vi.fn(async () => undefined),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminReindexApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(ReindexList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, store, el: fixture.nativeElement as HTMLElement };
}

function bodyRows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function rowFor(el: HTMLElement, url: string): HTMLTableRowElement {
  const row = bodyRows(el).find((r) => r.querySelector('th')?.textContent?.includes(url));
  if (!row) throw new Error(`No row for "${url}"`);
  return row;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn;
}

describe('ReindexList', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders the worklist in the order the server returned it', async () => {
    // The server orders priority ASC, then oldest first. The screen must not
    // re-sort: the top row IS the next action, and a client-side sort would make
    // that quietly untrue.
    const api = makeApiMock([
      makeRow({ id: 1, url: 'https://www.aecintegrations.com/products/procore', priority: 1 }),
      makeRow({ id: 2, url: 'https://www.aecintegrations.com/products/bluebeam', priority: 2 }),
      makeRow({ id: 3, url: 'https://www.aecintegrations.com/vendors/autodesk', priority: 4 }),
    ]);
    const { el } = await setup(api);
    expect(api.list).toHaveBeenCalledWith({ page: 1, perPage: 25 });
    const urls = bodyRows(el).map((r) => r.querySelector('th span')?.textContent?.trim());
    expect(urls).toEqual([
      'https://www.aecintegrations.com/products/procore',
      'https://www.aecintegrations.com/products/bluebeam',
      'https://www.aecintegrations.com/vendors/autodesk',
    ]);
  });

  it('renders each priority tier as a chip, with tier 1 emphasised', async () => {
    const api = makeApiMock([
      makeRow({ id: 1, priority: 1 }),
      makeRow({ id: 2, priority: 2 }),
      makeRow({ id: 3, priority: 3 }),
      makeRow({ id: 4, priority: 4 }),
    ]);
    const { el } = await setup(api);
    const chips = bodyRows(el).map((r) => r.querySelectorAll('td')[0].querySelector('span')!);
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['1', '2', '3', '4']);
    // Tier 1 carries the warm/emphatic treatment; 2 to 4 carry the neutral one.
    expect(chips[0].className).toContain('bg-(--accent-warm)');
    for (const chip of chips.slice(1)) {
      expect(chip.className).not.toContain('bg-(--accent-warm)');
      expect(chip.className).toContain('border-(--border-default)');
    }
  });

  it('maps a known reason slug to a sentence', async () => {
    const { el } = await setup(makeApiMock([makeRow({ id: 1, reason: 'trade.published' })]));
    expect(el.textContent).toContain('Trade page published');
  });

  // Nothing prunes `gsc_recrawl_queue`, so a row can outlive the code that wrote
  // its reason. An unmapped slug must render as something, never as a blank cell.
  it('humanizes an unknown reason slug rather than rendering nothing', async () => {
    const { el } = await setup(makeApiMock([makeRow({ id: 1, reason: 'data_object.created' })]));
    const cell = rowFor(el, '/products/product-1').querySelectorAll('td')[1];
    expect(cell.textContent?.trim()).toBe('Data object created');
  });

  it('shows how long each URL has been waiting', async () => {
    const { el } = await setup(
      makeApiMock([
        makeRow({ id: 1, queued_at: new Date(Date.now() - 30 * 60_000).toISOString() }),
        makeRow({ id: 2, queued_at: new Date(Date.now() - 5 * 3_600_000).toISOString() }),
        makeRow({ id: 3, queued_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      ]),
    );
    const ages = bodyRows(el).map((r) => r.querySelectorAll('td')[2].textContent?.trim());
    expect(ages).toEqual(['30 min', '5 h', '3 d']);
  });

  it('copies a URL to the clipboard and announces it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { el, fixture } = await setup(
      makeApiMock([makeRow({ id: 1, url: 'https://www.aecintegrations.com/products/procore' })]),
    );
    buttonByText(rowFor(el, '/products/procore'), 'Copy').click();
    await settle();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith('https://www.aecintegrations.com/products/procore');
    expect(el.querySelector('[role="status"]')?.textContent).toContain('/products/procore');
    vi.unstubAllGlobals();
  });

  it('marks a row done: calls DELETE, drops the row and ticks the badge down', async () => {
    const api = makeApiMock([
      makeRow({ id: 1, url: 'https://www.aecintegrations.com/products/procore' }),
      makeRow({ id: 2, url: 'https://www.aecintegrations.com/products/bluebeam' }),
    ]);
    const { el, fixture, store } = await setup(api);
    store.seed({ reindex: 5 });
    buttonByText(rowFor(el, '/products/procore'), 'Done').click();
    await settle();
    fixture.detectChanges();
    expect(api.clear).toHaveBeenCalledWith(1);
    expect(bodyRows(el)).toHaveLength(1);
    expect(el.textContent).toContain('/products/bluebeam');
    expect(store.pendingReindex()).toBe(4);
  });

  it('handles a 404 (already cleared) by dropping the row WITHOUT decrementing', async () => {
    const api = makeApiMock([makeRow({ id: 1 }), makeRow({ id: 2 })]);
    api.clear.mockRejectedValueOnce(new HttpErrorResponse({ status: 404 }));
    const { el, fixture, store } = await setup(api);
    store.seed({ reindex: 5 });
    buttonByText(rowFor(el, '/products/product-1'), 'Done').click();
    await settle();
    fixture.detectChanges();
    expect(bodyRows(el)).toHaveLength(1);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already cleared');
    // Whoever cleared it already decremented. Doing it again walks the badge
    // below the real backlog.
    expect(store.pendingReindex()).toBe(5);
  });

  it('keeps the row and offers a retry on any other failure', async () => {
    const api = makeApiMock([makeRow({ id: 1 })]);
    api.clear.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { el, fixture, store } = await setup(api);
    store.seed({ reindex: 5 });
    buttonByText(rowFor(el, '/products/product-1'), 'Done').click();
    await settle();
    fixture.detectChanges();
    expect(bodyRows(el)).toHaveLength(1);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
    expect(store.pendingReindex()).toBe(5);
  });

  it('says an empty list is the good outcome, and where rows come from', async () => {
    const { el } = await setup(makeApiMock([], 0));
    expect(el.querySelector('tbody')).toBeNull();
    expect(el.textContent).toContain('empty list is the good outcome');
    expect(el.textContent).toContain('changes a public page');
  });

  it('refetches with the priority filter, and returns to page one', async () => {
    const api = makeApiMock([makeRow({ id: 1, priority: 1 })]);
    const { el, fixture } = await setup(api);
    const group = el.querySelector('[aria-labelledby="admin-reindex-priority-label"]')!;
    buttonByText(group as HTMLElement, '1').click();
    await settle();
    fixture.detectChanges();
    expect(api.list).toHaveBeenLastCalledWith({ page: 1, perPage: 25, priority: 1 });
    expect(buttonByText(group as HTMLElement, '1').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a retryable state when the initial load fails, then recovers', async () => {
    const api = makeApiMock([makeRow({ id: 1 })]);
    api.list.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('could not load');
    buttonByText(el, 'Try again').click();
    await settle();
    fixture.detectChanges();
    expect(bodyRows(el)).toHaveLength(1);
  });

  describe('accessibility (structural)', () => {
    it('uses a single h2 and no lower heading (the shell owns the h1)', async () => {
      const { el } = await setup(makeApiMock([makeRow({ id: 1 })]));
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelector('h3, h4, h5, h6')).toBeNull();
    });

    it('names the table and scopes every header cell', async () => {
      const { el } = await setup(makeApiMock([makeRow({ id: 1 }), makeRow({ id: 2 })]));
      expect(el.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      const colHeaders = [...el.querySelectorAll('thead th')];
      expect(colHeaders).toHaveLength(5);
      for (const th of colHeaders) expect(th.getAttribute('scope')).toBe('col');
      // The URL is the row's identity, so it is a row header rather than a cell.
      for (const row of bodyRows(el)) {
        expect(row.querySelector('th')?.getAttribute('scope')).toBe('row');
      }
    });

    it('gives each copy button a row-specific description', async () => {
      const { el } = await setup(makeApiMock([makeRow({ id: 1 }), makeRow({ id: 2 })]));
      // The visible label is the same on every row, so the URL has to reach the
      // accessible description or the buttons are indistinguishable by name.
      const described = bodyRows(el).map((r) =>
        buttonByText(r, 'Copy').getAttribute('aria-describedby'),
      );
      expect(new Set(described).size).toBe(2);
      for (const id of described) expect(el.querySelector(`#${id}`)?.textContent).toContain('http');
    });

    it('gives the priority filter an accessible group name', async () => {
      const { el } = await setup(makeApiMock([makeRow({ id: 1 })]));
      const group = el.querySelector('[role="group"]')!;
      const labelId = group.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(el.querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
    });

    it('exposes one polite live region for action outcomes', async () => {
      const { el } = await setup(makeApiMock([makeRow({ id: 1 })]));
      const live = [...el.querySelectorAll('[role="status"]')];
      expect(live).toHaveLength(1);
      expect(live[0].getAttribute('aria-live')).toBe('polite');
    });
  });
});
