/**
 * AECI-822. `SeoTrendPanel`, Panel 2 of `/admin/seo` (`ADMIN_PANEL_SPEC.md`
 * §5.24.6 and §5.24.11).
 *
 * The rule this spec exists for is "never zero": a week the snapshot did not
 * record reads "Not recorded" and is a gap in the chart, the oldest re-index
 * row's "none" reads "None", and a week that published nothing reads "No pages".
 * It also pins the oldest-left order, the change from the week before, the open
 * cohort, the self-reported label, and a failed load with its retry.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SeoTrendLanes, SeoTrendResponse, SeoTrendWeek } from '@aeci/shared';

import { AdminSeoApi } from './admin-seo.api';
import { SeoTrendPanel } from './seo-trend-panel';

const RECORDED: SeoTrendLanes = {
  reindex_pending: 40,
  reindex_oldest_tier12_age_days: 2.25,
  uncrawled_google: 400,
  uncrawled_bing: 90,
  pairs_without_reviews: 800,
};

const UNRECORDED: SeoTrendLanes = {
  reindex_pending: null,
  reindex_oldest_tier12_age_days: null,
  uncrawled_google: null,
  uncrawled_bing: null,
  pairs_without_reviews: null,
};

function week(
  start: string,
  lanes: SeoTrendLanes,
  over: Partial<Omit<SeoTrendWeek, 'lanes'>> = {},
): SeoTrendWeek {
  return {
    week_start: start,
    lanes,
    cohort: {
      published: 10,
      crawled_within_days: 7,
      open: false,
      google: { crawled: 4, rate: 0.4 },
      bing: { crawled: 9, rate: 0.9 },
    },
    requests_self_reported: 3,
    ...over,
  };
}

/** Oldest first for readability. The API, and so `respond`, sends newest first. */
const OLDEST_FIRST: SeoTrendWeek[] = [
  week('2026-11-02', UNRECORDED),
  week('2026-11-09', { ...RECORDED, uncrawled_google: 420 }),
  week('2026-11-16', { ...RECORDED, reindex_oldest_tier12_age_days: 'none' }),
  week('2026-11-23', RECORDED, {
    cohort: {
      published: 0,
      crawled_within_days: 7,
      open: false,
      google: { crawled: 0, rate: null },
      bing: { crawled: 0, rate: null },
    },
  }),
  week(
    '2026-11-30',
    { ...RECORDED, uncrawled_google: 380 },
    {
      cohort: {
        published: 15,
        crawled_within_days: 7,
        open: true,
        google: { crawled: 4, rate: 0.2667 },
        bing: { crawled: 9, rate: 0.6 },
      },
      requests_self_reported: 9,
    },
  ),
];

function respond(weeks: SeoTrendWeek[] = OLDEST_FIRST): SeoTrendResponse {
  return {
    generated_at: '2026-12-08T09:00:00.000Z',
    weeks: [...weeks].reverse(),
    notes: [
      {
        code: 'crawler_label_includes_inspection_tool',
        severity: 'info',
        message: 'fallback',
      },
    ],
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(trend: () => Promise<SeoTrendResponse>) {
  const api = { queue: vi.fn(), trend: vi.fn(trend) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminSeoApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(SeoTrendPanel);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, announced, el: fixture.nativeElement as HTMLElement };
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The visible week table, not the charts' hidden ones. */
function weekTable(el: HTMLElement): HTMLTableElement {
  const t = [...el.querySelectorAll('table')].find((x) => !x.closest('aec-chart-data-table'));
  if (!t) throw new Error('No week table');
  return t;
}

/** The visible cells of the row whose header starts with `label`. */
function rowCells(el: HTMLElement, label: string): string[] {
  const row = [...weekTable(el).querySelectorAll('tr')].find((r) =>
    text(r.querySelector('th[scope="row"]')).startsWith(label),
  );
  if (!row) throw new Error(`No row "${label}"`);
  return [...row.querySelectorAll('td')].map((td) => {
    // Visible text only: drop the sr-only delta words.
    const clone = td.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
    return text(clone);
  });
}

describe('SeoTrendPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('asks for the default twelve weeks', async () => {
    const { api } = await setup(async () => respond());
    expect(api.trend).toHaveBeenCalledWith(12);
  });

  it('puts the oldest week on the left, labelled by its Monday in UTC', async () => {
    const { el } = await setup(async () => respond());
    const headers = [...weekTable(el).querySelectorAll('thead th')].map((th) => text(th));
    expect(headers).toEqual(['Week starting', '2 Nov', '9 Nov', '16 Nov', '23 Nov', '30 Nov']);
  });

  it('reads "Not recorded" for a week with no snapshot row, never 0', async () => {
    const { el } = await setup(async () => respond());
    for (const label of [
      'Re-index queue',
      'Oldest re-index row',
      'Not crawled by Google',
      'Not crawled by Bing',
      'Pair pages with no reviews',
    ]) {
      expect(rowCells(el, label)[0]).toBe('Not recorded');
    }
    expect(text(el)).toContain('its count is unknown, not zero');
    // The first recorded week is derived from the data, never a fixed date.
    expect(text(el)).toContain('The first week it recorded starts 9 Nov.');
    expect(text(el)).toContain('The last 12 complete weeks');
  });

  it('reads "None" when the oldest re-index age was sampled and had no row', async () => {
    const { el } = await setup(async () => respond());
    expect(rowCells(el, 'Oldest re-index row')).toEqual([
      'Not recorded',
      '2.3 d',
      'None no such row',
      '2.3 d',
      '2.3 d',
    ]);
  });

  it('shows the change from the week before, and none across a "Not recorded" week', async () => {
    const { el } = await setup(async () => respond());
    expect(rowCells(el, 'Not crawled by Google')).toEqual([
      'Not recorded',
      '420',
      '400 ↓ 20',
      '400 → 0',
      '380 ↓ 20',
    ]);
    const row = [...weekTable(el).querySelectorAll('tr')].find((r) =>
      text(r.querySelector('th')).startsWith('Not crawled by Google'),
    )!;
    expect(text(row.querySelectorAll('td')[2]!.querySelector('.sr-only'))).toBe(
      'down 20 from the week before',
    );
  });

  it('reads "No pages" for a week that published nothing, never 0%', async () => {
    const { el } = await setup(async () => respond());
    expect(rowCells(el, 'Crawled by Google within 7 days')[3]).toBe('No pages');
    expect(rowCells(el, 'Crawled by Bing within 7 days')[3]).toBe('No pages');
    expect(rowCells(el, 'Published')[3]).toBe('0');
  });

  it('marks an open cohort as "so far"', async () => {
    const { el } = await setup(async () => respond());
    expect(rowCells(el, 'Crawled by Google within 7 days')[4]).toBe('27% 4 of 15 so far');
    expect(rowCells(el, 'Crawled by Google within 7 days')[0]).toBe('40% 4 of 10');
  });

  it('labels the requests row as self-reported, and not a measurement', async () => {
    const { el } = await setup(async () => respond());
    const row = el.querySelector('[data-testid="admin-seo-self-reported"]')!;
    expect(text(row.querySelector('th'))).toContain('Requests recorded');
    expect(text(row.querySelector('th'))).toContain('Self-reported');
    expect(text(row.querySelector('th'))).toContain('Not a measurement.');
    expect([...row.querySelectorAll('td')].map((td) => text(td))).toEqual([
      '3',
      '3',
      '3',
      '3',
      '9',
    ]);
  });

  it('draws two charts whose hidden tables say "Not recorded" and "No pages published", never 0', async () => {
    const { el } = await setup(async () => respond());
    const charts = el.querySelectorAll('aec-line-chart');
    expect(charts).toHaveLength(2);

    const rateRows = [...charts[0]!.querySelectorAll('aec-chart-data-table tbody tr')].map((r) =>
      [...r.children].map((c) => text(c)),
    );
    expect(rateRows[3]).toEqual(['23 Nov', 'No pages published', 'No pages published']);
    expect(rateRows[4]).toEqual(['30 Nov', '27% so far', '60% so far']);

    const depthRows = [...charts[1]!.querySelectorAll('aec-chart-data-table tbody tr')].map((r) =>
      [...r.children].map((c) => text(c)),
    );
    expect(depthRows[0]).toEqual(['2 Nov', 'Not recorded', 'Not recorded']);
    expect(depthRows[1]).toEqual(['9 Nov', '420', '90']);
  });

  it('renders the response notes', async () => {
    const { el } = await setup(async () => respond());
    expect(text(el.querySelector('aec-admin-notes'))).toContain('URL Inspection tool');
  });

  it('omits the "Not recorded" explanation when every week was recorded', async () => {
    const { el } = await setup(async () => respond(OLDEST_FIRST.slice(1)));
    expect(text(el)).not.toContain('Not recorded');
  });

  it('says "days" to a screen reader where the cell shows "d"', async () => {
    const { el } = await setup(async () => respond());
    const row = [...weekTable(el).querySelectorAll('tr')].find((r) =>
      text(r.querySelector('th')).startsWith('Oldest re-index row'),
    )!;
    const cell = row.querySelectorAll('td')[1]!;
    expect(text(cell.querySelector('[aria-hidden="true"]'))).toBe('2.3 d');
    expect(text(cell.querySelector('.sr-only'))).toBe('2.3 days');
  });

  it('keeps each row header to its name and links the description', async () => {
    const { el } = await setup(async () => respond());
    const th = [...weekTable(el).querySelectorAll('th[scope="row"]')].find((h) =>
      text(h).startsWith('Pair pages with no reviews'),
    )!;
    const desc = el.querySelector(`#${th.getAttribute('aria-describedby')}`)!;
    expect(text(desc)).toContain('A count to watch, not a work list.');
    expect(desc.getAttribute('aria-hidden')).toBe('true');
    const requests = el.querySelector('[data-testid="admin-seo-self-reported"] th')!;
    const reqDesc = el.querySelector(`#${requests.getAttribute('aria-describedby')}`)!;
    expect(text(reqDesc)).toContain('Not a measurement.');
    expect(reqDesc.getAttribute('aria-hidden')).toBe('true');
    // A row with no description links nothing.
    const plain = [...weekTable(el).querySelectorAll('th[scope="row"]')].find((h) =>
      text(h).startsWith('Re-index queue'),
    )!;
    expect(plain.hasAttribute('aria-describedby')).toBe(false);
  });

  it('makes the week table a focusable scroll region named by its caption', async () => {
    const { el } = await setup(async () => respond());
    const region = weekTable(el).parentElement!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-labelledby')).toBe('admin-seo-trend-caption');
    expect(weekTable(el).querySelector('caption')?.id).toBe('admin-seo-trend-caption');
  });

  it('a retry that fails again announces it and moves focus to the heading', async () => {
    const { el, fixture, api, announced } = await setup(async () => {
      throw new Error('500');
    });
    document.body.appendChild(el);
    try {
      const retry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Try again')!;
      retry.click();
      await settle();
      fixture.detectChanges();
      await fixture.whenStable();
      await settle();
      fixture.detectChanges();
      expect(api.trend).toHaveBeenCalledTimes(2);
      expect(announced.at(-1)).toBe('The weekly trend still could not load.');
      expect(document.activeElement).toBe(el.querySelector('h3'));
    } finally {
      el.remove();
    }
  });

  it('a failed load shows an alert and Try again, which reloads', async () => {
    let fail = true;
    const { el, fixture, api, announced } = await setup(async () => {
      if (fail) throw new Error('500');
      return respond();
    });
    expect(text(el.querySelector('[role="alert"]'))).toContain("We couldn't load the weekly trend");
    expect(el.querySelector('table')).toBeNull();

    fail = false;
    const retry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Try again')!;
    retry.click();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.trend).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(weekTable(el)).toBeTruthy();
    await settle();
    fixture.detectChanges();
    expect(announced.at(-1)).toBe('Weekly trend loaded.');
  });
});
