/**
 * AECI-822. `SeoQueuePanel`, Panel 1 of `/admin/seo` (`ADMIN_PANEL_SPEC.md`
 * §5.24.5 and §5.24.11).
 *
 * Covers what the rendered surface cannot be read for: the lane order, the
 * re-index link and its "None", the toggle refetching page 1 for its engine,
 * the copy control and its announcement, paging and where focus lands after it,
 * "Never recorded" and "Not dated", a single empty lane, every lane empty, no
 * public site address, and a failed load with its retry.
 *
 * Harness mirrors `reindex-list.component.spec.ts`: zoneless plus a macrotask
 * `settle()` that drains `afterNextRender`'s async load.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SeoQueueItem, SeoQueueLane, SeoQueueQuery, SeoQueueResponse } from '@aeci/shared';

import { AdminSeoApi } from './admin-seo.api';
import { SeoQueuePanel } from './seo-queue-panel';

const GENERATED = '2027-01-12T09:00:00.000Z';

function lanes(reindex: number, google: number, bing: number, oldest: number | null = 3.2) {
  const out: SeoQueueLane[] = [
    {
      lane: 'reindex',
      engine: 'google',
      count: reindex,
      oldest_tier12_age_days: oldest,
      href: '/admin/reindex',
    },
    {
      lane: 'uncrawled',
      engine: 'google',
      count: google,
      oldest_tier12_age_days: null,
      href: null,
    },
    { lane: 'uncrawled', engine: 'bing', count: bing, oldest_tier12_age_days: null, href: null },
  ];
  return out;
}

function item(url: string, over: Partial<SeoQueueItem> = {}): SeoQueueItem {
  return {
    url,
    page_type: 'product',
    published_at: '2026-08-21T00:00:00.000Z',
    age_days: 144,
    last_fetch_at: null,
    ...over,
  };
}

function response(
  laneList: SeoQueueLane[],
  data: SeoQueueItem[],
  over: { engine?: 'google' | 'bing'; page?: number; total?: number } = {},
): SeoQueueResponse {
  return {
    generated_at: GENERATED,
    window: {
      from: '2026-12-15T09:00:00.000Z',
      to: GENERATED,
      timezone: 'UTC',
      days: 28,
    },
    lanes: laneList,
    items: {
      lane: 'uncrawled',
      engine: over.engine ?? 'google',
      data,
      page: over.page ?? 1,
      perPage: 25,
      total: over.total ?? data.length,
    },
    notes: [
      {
        code: 'crawl_coverage_is_gateway_arrivals',
        severity: 'info',
        message: 'fallback',
      },
    ],
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const attached: HTMLElement[] = [];

async function setup(queue: (q: Partial<SeoQueueQuery>) => Promise<SeoQueueResponse>) {
  const api = { queue: vi.fn(queue), trend: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminSeoApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(SeoQueuePanel);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  // Attached, so focus moves can be observed.
  document.body.appendChild(el);
  attached.push(el);
  return { fixture, api, el, announced };
}

async function flush(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Text a sighted reader sees: sr-only spans removed. */
function visible(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return text(clone);
}

function buttonByText(root: Element, label: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => text(b) === label);
  if (!btn) throw new Error(`No button "${label}"`);
  return btn;
}

function card(el: HTMLElement, lane: string, engine: string): HTMLElement {
  const c = el.querySelector<HTMLElement>(`[data-testid="admin-seo-lane-${lane}-${engine}"]`);
  if (!c) throw new Error(`No card ${lane}/${engine}`);
  return c;
}

describe('SeoQueuePanel', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (attached.length > 0) attached.pop()!.remove();
  });

  it('asks for the Google lane, page 1, 25 a page, on first load', async () => {
    const { api } = await setup(async () => response(lanes(37, 2, 1), [item('https://x.test/a')]));
    expect(api.queue).toHaveBeenCalledWith({
      lane: 'uncrawled',
      engine: 'google',
      page: 1,
      perPage: 25,
    });
  });

  it('renders the three lanes in the API order, counts first', async () => {
    const { el } = await setup(async () =>
      response(lanes(37, 412, 96), [item('https://x.test/a')]),
    );
    const cards = [...el.querySelectorAll('[data-testid^="admin-seo-lane-"]')].map((c) =>
      c.getAttribute('data-testid'),
    );
    expect(cards).toEqual([
      'admin-seo-lane-reindex-google',
      'admin-seo-lane-uncrawled-google',
      'admin-seo-lane-uncrawled-bing',
    ]);
    expect(text(card(el, 'reindex', 'google'))).toContain('37 URLs waiting');
    expect(text(card(el, 'uncrawled', 'google'))).toContain('412 pages');
    expect(text(card(el, 'uncrawled', 'bing'))).toContain('96 pages');
  });

  it('links the re-index lane to /admin/reindex with its oldest age, and does not list it', async () => {
    const { el } = await setup(async () => response(lanes(37, 2, 1), [item('https://x.test/a')]));
    const reindex = card(el, 'reindex', 'google');
    expect(reindex.querySelector('a')?.getAttribute('href')).toBe('/admin/reindex');
    expect(text(reindex)).toContain('Oldest priority 1 or 2 row: 3 days');
    expect(reindex.querySelector('button')).toBeNull();
  });

  it('reads "None" when the re-index queue has no tier-1 or tier-2 row', async () => {
    const { el } = await setup(async () =>
      response(lanes(5, 2, 1, null), [item('https://x.test/a')]),
    );
    expect(text(card(el, 'reindex', 'google'))).toContain('Oldest priority 1 or 2 row: None');
  });

  it('opens the Google lane first, with an expanded disclosure and its table', async () => {
    const { el } = await setup(async () => response(lanes(1, 2, 1), [item('https://x.test/a')]));
    const google = buttonByText(card(el, 'uncrawled', 'google'), 'Show URLs');
    const bing = buttonByText(card(el, 'uncrawled', 'bing'), 'Show URLs');
    expect(google.getAttribute('aria-expanded')).toBe('true');
    expect(bing.getAttribute('aria-expanded')).toBe('false');
    // A disclosure, not also a toggle (AECI-823 audit A6).
    expect(google.hasAttribute('aria-pressed')).toBe(false);
    expect(bing.hasAttribute('aria-pressed')).toBe(false);
    expect(google.getAttribute('aria-controls')).toBe('admin-seo-list');
    expect(text(el.querySelector('h4[tabindex="-1"]'))).toBe('Not crawled by Google');
    expect(el.querySelector('caption')?.textContent).toContain('Googlebot');
  });

  it('switching to Bing refetches page 1 for Bing, keeps focus on the toggle and announces it', async () => {
    const { el, fixture, api, announced } = await setup(async (q) =>
      response(lanes(1, 40, 3), [item(`https://x.test/${q.engine}`)], {
        engine: q.engine,
        total: q.engine === 'bing' ? 3 : 40,
      }),
    );
    const bing = buttonByText(card(el, 'uncrawled', 'bing'), 'Show URLs');
    bing.focus();
    bing.click();
    await flush(fixture);

    expect(api.queue).toHaveBeenLastCalledWith({
      lane: 'uncrawled',
      engine: 'bing',
      page: 1,
      perPage: 25,
    });
    expect(bing.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(bing);
    expect(text(el.querySelector('h4[tabindex="-1"]'))).toBe('Not crawled by Bing');
    expect(text(el.querySelector('thead'))).toContain('Last Bingbot visit');
    expect(announced.at(-1)).toBe('Listing pages not crawled by Bing, page 1 of 1.');
  });

  it('ignores a stale answer that lands after a newer lane was chosen', async () => {
    let releaseGoogle: (() => void) | null = null;
    let calls = 0;
    const { el, fixture } = await setup(async (q) => {
      calls++;
      const res = response(lanes(1, 40, 3), [item(`https://x.test/${q.engine}-${calls}`)], {
        engine: q.engine,
      });
      // The third call is the slow Google request.
      if (calls === 3) await new Promise<void>((r) => (releaseGoogle = r));
      return res;
    });
    buttonByText(card(el, 'uncrawled', 'bing'), 'Show URLs').click();
    await flush(fixture);
    buttonByText(card(el, 'uncrawled', 'google'), 'Show URLs').click();
    await settle();
    buttonByText(card(el, 'uncrawled', 'bing'), 'Show URLs').click();
    await flush(fixture);
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/bing-4');

    (releaseGoogle as (() => void) | null)?.();
    await flush(fixture);
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/bing-4');
    expect(text(el.querySelector('h4[tabindex="-1"]'))).toBe('Not crawled by Bing');
  });

  it('pages: asks for the next page, moves focus to the list heading and announces it', async () => {
    const { el, fixture, api, announced } = await setup(async (q) =>
      response(lanes(1, 60, 1), [item(`https://x.test/p${q.page}`)], {
        page: q.page,
        total: 60,
      }),
    );
    buttonByText(el, 'Next').click();
    await flush(fixture);

    expect(api.queue).toHaveBeenLastCalledWith({
      lane: 'uncrawled',
      engine: 'google',
      page: 2,
      perPage: 25,
    });
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/p2');
    expect(document.activeElement).toBe(el.querySelector('h4[tabindex="-1"]'));
    expect(announced.at(-1)).toBe('Listing pages not crawled by Google, page 2 of 3.');
  });

  it('renders the row columns: page type, publish date, waiting age, last fetch', async () => {
    const { el } = await setup(async () =>
      response(lanes(1, 3, 1), [
        item('https://x.test/vendors/trimble', {
          page_type: 'vendor',
          last_fetch_at: '2026-10-30T12:00:00.000Z',
        }),
        item('https://x.test/products/a/integrations/b', { page_type: 'pair' }),
        item('https://x.test/categories/estimating', {
          page_type: 'category',
          published_at: null,
          age_days: null,
        }),
      ]),
    );
    // Visible text only, and the Copy cell (column 1) is its own column.
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].slice(1).map((c) => visible(c)),
    );
    expect(rows[0]).toEqual(['Vendor', 'Aug 21, 2026', '144 d', 'Oct 30, 2026 73 days ago']);
    expect(rows[1]).toEqual(['Integration pair', 'Aug 21, 2026', '144 d', 'Never recorded']);
    expect(rows[2]![0]).toBe('Category');
    expect(rows[2]![1]).toBe('Not dated');
    expect(rows[2]![3]).toBe('Never recorded');
    // A screen reader hears "144 days", never "144 d".
    const waiting = el.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')[3]!;
    expect(text(waiting.querySelector('[aria-hidden="true"]'))).toBe('144 d');
    expect(text(waiting.querySelector('.sr-only'))).toBe('144 days');
  });

  it('humanizes a page type this build has never seen instead of blanking it', async () => {
    const { el } = await setup(async () =>
      response(lanes(1, 1, 1), [item('https://x.test/a', { page_type: 'data_object' })]),
    );
    expect(text(el.querySelectorAll('tbody td')[1])).toBe('Data object');
  });

  it('copies a URL, shows Copied on that button and announces it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { el, fixture, announced } = await setup(async () =>
      response(lanes(1, 2, 1), [item('https://x.test/one'), item('https://x.test/two')]),
    );
    const row = [...el.querySelectorAll('tbody tr')][1]!;
    const copy = buttonByText(row, 'Copy');
    // Each button's accessible name carries its own URL, so 25 buttons are
    // never 25 identical "Copy"s. The rendered attribute is asserted, because an
    // interpolated i18n-aria-label would emit none.
    expect(copy.getAttribute('aria-label')).toBe('Copy https://x.test/two');
    expect(
      buttonByText([...el.querySelectorAll('tbody tr')][0]!, 'Copy').getAttribute('aria-label'),
    ).toBe('Copy https://x.test/one');
    copy.click();
    await flush(fixture);

    expect(writeText).toHaveBeenCalledWith('https://x.test/two');
    expect(text(copy)).toBe('Copied');
    expect(copy.getAttribute('aria-label')).toBe('Copied https://x.test/two');
    expect(text(buttonByText([...el.querySelectorAll('tbody tr')][0]!, 'Copy'))).toBe('Copy');
    expect(announced.at(-1)).toBe('Copied https://x.test/two');
  });

  it('says how to copy by hand when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { el, fixture, announced } = await setup(async () =>
      response(lanes(1, 1, 1), [item('https://x.test/one')]),
    );
    buttonByText(el, 'Copy').click();
    await flush(fixture);
    expect(announced.at(-1)).toContain('Select it and copy it by hand');
    expect(text(buttonByText(el, 'Copy'))).toBe('Copy');
  });

  it('reads "Nothing outstanding" in an empty lane card, with no toggle', async () => {
    const { el } = await setup(async () => response(lanes(3, 2, 0), [item('https://x.test/a')]));
    const bing = card(el, 'uncrawled', 'bing');
    expect(text(bing)).toContain('Nothing outstanding');
    expect(bing.querySelector('button')).toBeNull();
    expect(el.querySelector('[data-testid="admin-seo-all-empty"]')).toBeNull();
  });

  it('every lane empty: one "Nothing outstanding" line and no list', async () => {
    const { el } = await setup(async () => response(lanes(0, 0, 0, null), []));
    const line = el.querySelector('[data-testid="admin-seo-all-empty"]');
    expect(text(line)).toContain('Nothing outstanding.');
    expect(text(line)).toContain('in the last 28 days');
    expect(el.querySelectorAll('[data-testid^="admin-seo-lane-"]')).toHaveLength(3);
    expect(el.querySelector('table')).toBeNull();
    // Never a loading line or a blank panel.
    expect(text(el)).not.toContain('Loading');
  });

  it('no public site address: says so, lists no lanes and does not repeat the note', async () => {
    const { el } = await setup(async () => ({
      ...response([], []),
      notes: [{ code: 'public_site_url_unset', severity: 'warn', message: 'unset' }],
    }));
    expect(text(el.querySelector('[data-testid="admin-seo-url-unset"]'))).toContain(
      'No URLs on this tier.',
    );
    expect(el.querySelectorAll('[data-testid^="admin-seo-lane-"]')).toHaveLength(0);
    expect(el.querySelector('aec-admin-notes')).toBeNull();
  });

  it('renders the response notes through AdminNotes', async () => {
    const { el } = await setup(async () => response(lanes(1, 1, 1), [item('https://x.test/a')]));
    expect(text(el.querySelector('aec-admin-notes'))).toContain("site's gateway records");
  });

  it('an empty re-index queue still links to /admin/reindex', async () => {
    const { el } = await setup(async () =>
      response(lanes(0, 2, 1, null), [item('https://x.test/a')]),
    );
    const reindex = card(el, 'reindex', 'google');
    expect(text(reindex)).toContain('Nothing outstanding');
    expect(reindex.querySelector('a')?.getAttribute('href')).toBe('/admin/reindex');
  });

  it('pressing the open lane closes its list, keeps focus and stays truthful; pressing again reopens it', async () => {
    const { el, fixture, api, announced } = await setup(async () =>
      response(lanes(1, 2, 1), [item('https://x.test/a')]),
    );
    const google = buttonByText(card(el, 'uncrawled', 'google'), 'Show URLs');
    expect(google.getAttribute('aria-expanded')).toBe('true');
    google.focus();
    google.click();
    await flush(fixture);

    expect(google.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('table')).toBeNull();
    expect(document.activeElement).toBe(google);
    expect(announced.at(-1)).toBe('URL list closed.');
    // Closing fetches nothing.
    expect(api.queue).toHaveBeenCalledTimes(1);

    google.click();
    await flush(fixture);
    expect(google.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('table')).not.toBeNull();
    expect(api.queue).toHaveBeenCalledTimes(1);
  });

  it('a failed page change keeps the lane cards and fails in the list area, with a retry', async () => {
    let failPage2 = true;
    const { el, fixture, api } = await setup(async (q) => {
      if (q.page === 2 && failPage2) throw new Error('500');
      return response(lanes(7, 60, 3), [item(`https://x.test/p${q.page}`)], {
        page: q.page,
        total: 60,
      });
    });
    buttonByText(el, 'Next').click();
    await flush(fixture);

    expect(el.querySelectorAll('[data-testid^="admin-seo-lane-"]')).toHaveLength(3);
    expect(text(card(el, 'reindex', 'google'))).toContain('7 URLs waiting');
    const listError = el.querySelector('[data-testid="admin-seo-list-error"]');
    expect(text(listError?.querySelector('[role="alert"]'))).toContain(
      "We couldn't load these URLs",
    );
    expect(text(el)).not.toContain("We couldn't load the search queue");
    expect(el.querySelector('table')).toBeNull();

    failPage2 = false;
    buttonByText(listError!, 'Try again').click();
    await flush(fixture);
    expect(api.queue).toHaveBeenLastCalledWith({
      lane: 'uncrawled',
      engine: 'google',
      page: 2,
      perPage: 25,
    });
    expect(el.querySelector('[data-testid="admin-seo-list-error"]')).toBeNull();
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/p2');
  });

  it("a failed lane switch keeps the cards and shows the list error, not the old lane's rows", async () => {
    const { el, fixture } = await setup(async (q) => {
      if (q.engine === 'bing') throw new Error('500');
      return response(lanes(1, 2, 3), [item('https://x.test/google-row')]);
    });
    buttonByText(card(el, 'uncrawled', 'bing'), 'Show URLs').click();
    await flush(fixture);
    expect(el.querySelectorAll('[data-testid^="admin-seo-lane-"]')).toHaveLength(3);
    expect(el.querySelector('[data-testid="admin-seo-list-error"]')).not.toBeNull();
    expect(text(el)).not.toContain('https://x.test/google-row');
  });

  it('ignores a stale page answer that lands after a newer page was asked for', async () => {
    let releasePage2: (() => void) | null = null;
    const { el, fixture } = await setup(async (q) => {
      if (q.page === 2) await new Promise<void>((r) => (releasePage2 = r));
      return response(lanes(1, 80, 1), [item(`https://x.test/p${q.page}`)], {
        page: q.page,
        total: 80,
      });
    });
    buttonByText(el, 'Next').click();
    await settle();
    // While page 2 hangs, the operator goes back to page 1.
    void (fixture.componentInstance as unknown as { goToPage(p: number): Promise<void> }).goToPage(
      1,
    );
    await flush(fixture);
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/p1');

    (releasePage2 as (() => void) | null)?.();
    await flush(fixture);
    expect(text(el.querySelector('tbody'))).toContain('https://x.test/p1');
    expect(text(el.querySelector('tbody'))).not.toContain('https://x.test/p2');
  });

  it('a failed load shows an alert and Try again, which reloads', async () => {
    let fail = true;
    const { el, fixture, api } = await setup(async () => {
      if (fail) throw new Error('500');
      return response(lanes(1, 1, 1), [item('https://x.test/a')]);
    });
    expect(text(el.querySelector('[role="alert"]'))).toContain("We couldn't load the search queue");
    expect(el.querySelector('table')).toBeNull();

    fail = false;
    buttonByText(el, 'Try again').click();
    await flush(fixture);
    expect(api.queue).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('table')).not.toBeNull();
  });

  it('keeps the Copy button out of the row header, in its own column', async () => {
    const { el } = await setup(async () =>
      response(lanes(1, 1, 1), [item('https://x.test/products/a')]),
    );
    const row = el.querySelector('tbody tr')!;
    const header = row.querySelector('th[scope="row"]')!;
    expect(text(header)).toBe('https://x.test/products/a');
    expect(header.querySelector('button')).toBeNull();
    expect(row.querySelectorAll('td')[0]!.querySelector('button')).not.toBeNull();
    const cols = [...el.querySelectorAll('thead th')].map((th) => text(th));
    expect(cols.slice(0, 2)).toEqual(['URL', 'Copy']);
  });

  it('makes the URL table a focusable, named scroll region', async () => {
    const { el } = await setup(async () => response(lanes(1, 1, 1), [item('https://x.test/a')]));
    const region = el.querySelector('[role="region"]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    const caption = el.querySelector('caption')!;
    expect(region.getAttribute('aria-labelledby')).toBe(caption.id);
    expect(caption.id).toBe('admin-seo-list-caption');
  });

  it('a retry that fails again announces it and moves focus to the heading', async () => {
    const { el, fixture, api, announced } = await setup(async () => {
      throw new Error('500');
    });
    buttonByText(el, 'Try again').click();
    await flush(fixture);
    expect(api.queue).toHaveBeenCalledTimes(2);
    expect(announced.at(-1)).toBe('The search queue still could not load.');
    expect(document.activeElement).toBe(el.querySelector('h3'));
  });

  it('a retry that succeeds announces it and moves focus to the heading', async () => {
    let fail = true;
    const { el, fixture, announced } = await setup(async () => {
      if (fail) throw new Error('500');
      return response(lanes(1, 1, 1), [item('https://x.test/a')]);
    });
    fail = false;
    buttonByText(el, 'Try again').click();
    await flush(fixture);
    expect(announced.at(-1)).toBe('Search queue loaded.');
    expect(document.activeElement).toBe(el.querySelector('h3'));
  });

  it('a list retry that fails again announces it and focuses the list heading', async () => {
    const { el, fixture, announced } = await setup(async (q) => {
      if (q.page === 2) throw new Error('500');
      return response(lanes(7, 60, 3), [item(`https://x.test/p${q.page}`)], {
        page: q.page,
        total: 60,
      });
    });
    buttonByText(el, 'Next').click();
    await flush(fixture);
    const listError = el.querySelector('[data-testid="admin-seo-list-error"]')!;
    buttonByText(listError, 'Try again').click();
    await flush(fixture);
    expect(announced.at(-1)).toBe('These URLs still could not load.');
    expect(document.activeElement).toBe(el.querySelector('h4[tabindex="-1"]'));
  });

  it('shows a loading line, never a blank panel, before the first answer', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AdminSeoApi,
          useValue: { queue: vi.fn(() => new Promise(() => undefined)), trend: vi.fn() },
        },
      ],
    });
    const fixture = TestBed.createComponent(SeoQueuePanel);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text(fixture.nativeElement as HTMLElement)).toContain('Loading the search queue');
  });
});
