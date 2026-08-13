/**
 * AECI-578 / Phase 8.3 P1.4 — the §8 accessibility contract, asserted for every
 * chart type at once.
 *
 * §8: *"Each chart is `role="img"` with a descriptive `aria-label`, plus a
 * visually-hidden `<table>` carrying the same series. Charts are never the only
 * representation of a number."* §11 turns that into an acceptance criterion: the
 * hidden table's contents asserted against the series data, per chart type.
 *
 * Table-driven on purpose. Written per-file, each chart would get its own
 * slightly different assertion and the contract would drift; here a new chart
 * either satisfies the same four rules or it fails.
 *
 * The fourth rule is the one that is easy to get wrong and impossible to see:
 * **the table must not be a descendant of the `role="img"` element.** `role="img"`
 * makes its subtree presentational, so a nested table is invisible to exactly the
 * reader it was written for — and axe cannot detect it, because nothing about the
 * markup is invalid.
 */
import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { DonutChart } from './donut-chart';
import { HorizontalBarChart } from './horizontal-bar-chart';
import { LineChart } from './line-chart';
import { StackedBarChart } from './stacked-bar-chart';
import type { ChartCategory, ChartSeries } from './chart-types';

const DAYS = ['1 Aug', '2 Aug', '3 Aug'];

const SERIES: ChartSeries[] = [
  { key: 'human', label: 'Human', slot: 1, values: [12, 3400, 7] },
  { key: 'bot', label: 'Bot', slot: 2, values: [0, 15, 1284] },
];

const CATEGORIES: ChartCategory[] = [
  { key: 'google.com', label: 'google.com', value: 1284, link: null },
  { key: '', label: 'Unattributed', value: 7, link: null },
];

interface ChartCase {
  name: string;
  type: Type<unknown>;
  inputs: Record<string, unknown>;
  /** Row header → expected cells, exactly as they must appear in the table. */
  expected: Array<[string, string[]]>;
  columns: string[];
  /** Inputs that empty this chart. Declared per case rather than blanket-cleared:
   *  setting an input a component does not declare throws NG0303. */
  emptyInputs: Record<string, unknown>;
}

const CASES: ChartCase[] = [
  {
    name: 'LineChart',
    type: LineChart,
    inputs: {
      series: SERIES,
      categories: DAYS,
      categoryHeader: 'Day (UTC)',
      ariaLabel: 'Unique visitors per UTC day',
      emptyLabel: 'No views recorded.',
    },
    columns: ['Day (UTC)', 'Human', 'Bot'],
    expected: [
      ['1 Aug', ['12', '0']],
      ['2 Aug', ['3,400', '15']],
      ['3 Aug', ['7', '1,284']],
    ],
    emptyInputs: { series: [], categories: [] },
  },
  {
    name: 'StackedBarChart',
    type: StackedBarChart,
    inputs: {
      series: SERIES,
      categories: DAYS,
      categoryHeader: 'Day (UTC)',
      ariaLabel: 'Page views per day, human and bot',
      emptyLabel: 'No views recorded.',
    },
    columns: ['Day (UTC)', 'Human', 'Bot'],
    expected: [
      ['1 Aug', ['12', '0']],
      ['2 Aug', ['3,400', '15']],
      ['3 Aug', ['7', '1,284']],
    ],
    emptyInputs: { series: [], categories: [] },
  },
  {
    name: 'DonutChart',
    type: DonutChart,
    inputs: {
      data: CATEGORIES,
      categoryHeader: 'Source',
      valueHeader: 'Views',
      ariaLabel: 'Traffic sources',
      emptyLabel: 'No views recorded.',
    },
    columns: ['Source', 'Views'],
    expected: [
      ['google.com', ['1,284']],
      ['Unattributed', ['7']],
    ],
    emptyInputs: { data: [] },
  },
];

function setup(chart: ChartCase) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(chart.type);
  for (const [key, value] of Object.entries(chart.inputs)) {
    fixture.componentRef.setInput(key, value);
  }
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** Read a table back as `[rowHeader, cells]`, the shape the case declares. */
function readTable(table: HTMLTableElement): Array<[string, string[]]> {
  return [...table.querySelectorAll('tbody tr')].map((row) => {
    const header = row.querySelector('th')?.textContent?.trim() ?? '';
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
    return [header, cells] as [string, string[]];
  });
}

describe('chart accessibility contract (ADMIN_PANEL_SPEC §8)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const chart of CASES) {
    describe(chart.name, () => {
      it('exposes the plot as role="img" with a descriptive accessible name', () => {
        const el = setup(chart);
        const img = el.querySelector('[role="img"]');
        expect(img, 'no role="img" element').not.toBeNull();
        expect(img!.getAttribute('aria-label')).toBe(chart.inputs['ariaLabel']);
      });

      it('carries a visually-hidden table whose contents match the series', () => {
        const el = setup(chart);
        const table = el.querySelector('table');
        expect(table, 'no data table').not.toBeNull();
        expect(table!.classList.contains('sr-only')).toBe(true);
        expect(readTable(table as HTMLTableElement)).toEqual(chart.expected);
      });

      it('names its columns and its caption', () => {
        const el = setup(chart);
        const table = el.querySelector('table')!;
        expect(table.querySelector('caption')?.textContent?.trim()).toBe(chart.inputs['ariaLabel']);
        expect([...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual(
          chart.columns,
        );
      });

      it('uses scoped header cells so every value has row and column context', () => {
        const el = setup(chart);
        const table = el.querySelector('table')!;
        expect(
          [...table.querySelectorAll('thead th')].every((th) => th.getAttribute('scope') === 'col'),
        ).toBe(true);
        expect(
          [...table.querySelectorAll('tbody th')].every((th) => th.getAttribute('scope') === 'row'),
        ).toBe(true);
      });

      it('keeps the table OUT of the role="img" subtree', () => {
        // Inside, role="img" makes it presentational and the reader it exists
        // for never sees it — and no linter catches that.
        const el = setup(chart);
        const img = el.querySelector('[role="img"]')!;
        expect(img.querySelector('table')).toBeNull();
      });

      it('renders an empty state instead of an empty chart', () => {
        const empty = { ...chart, inputs: { ...chart.inputs, ...chart.emptyInputs } };
        const el = setup(empty);
        expect(el.textContent).toContain('No views recorded.');
      });
    });
  }
});

/**
 * The horizontal bar chart answers the same contract a different way, and it is
 * a deliberate departure rather than an oversight — so it gets its own
 * assertions rather than a special case bolted into the loop above.
 *
 * It renders a REAL table instead of `<svg role="img">` + a hidden copy, because
 * a ranked category-to-count list is already tabular and because
 * `dimension=product` rows link to `/products/:slug` — links inside a
 * `role="img"` subtree are removed from the accessibility tree entirely.
 */
describe('HorizontalBarChart accessibility (the documented §8 departure)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const inputs = {
    data: [
      { key: 'p1', label: 'Procore', value: 1284, link: ['/products', 'procore'] },
      { key: '', label: 'Unknown product', value: 7, link: null },
    ] satisfies ChartCategory[],
    categoryHeader: 'Product',
    valueHeader: 'Views',
    ariaLabel: 'Top products by views',
    emptyLabel: 'No views recorded.',
    total: 2000,
  };

  function render(over: Partial<typeof inputs> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(HorizontalBarChart);
    for (const [key, value] of Object.entries({ ...inputs, ...over })) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('is a real table, not a role="img" with a hidden copy', () => {
    const el = render();
    expect(el.querySelector('[role="img"]')).toBeNull();
    const table = el.querySelector('table')!;
    expect(table.classList.contains('sr-only')).toBe(false);
    expect(table.querySelector('caption')?.textContent?.trim()).toBe('Top products by views');
  });

  it('carries the same values a hidden table would have', () => {
    const table = render().querySelector('table') as HTMLTableElement;
    expect(readTable(table)).toEqual([
      // 1284 / 2000 of the window.
      ['Procore', ['1,284 64%']],
      ['Unknown product', ['7 0%']],
    ]);
  });

  it('keeps product links reachable — the reason it is not role="img"', () => {
    const link = render().querySelector('tbody a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/products/procore');
  });

  it('marks the bar decorative — the row cells already carry the number', () => {
    const el = render();
    const bar = el.querySelector('tbody th span[aria-hidden="true"]');
    expect(bar).not.toBeNull();
    // Scaled against the largest row, so the leader is full width.
    expect((bar as HTMLElement).style.width).toBe('100%');
  });

  it('scales bars against the largest row, not the window total', () => {
    const el = render();
    const bars = [...el.querySelectorAll('tbody th span[aria-hidden="true"]')] as HTMLElement[];
    // 7 / 1284 of the leader — a sliver, but a truthful one. Against the 2000
    // window total the leader itself would only be 64% and the tail invisible.
    expect(bars[0]!.style.width).toBe('100%');
    expect(parseFloat(bars[1]!.style.width)).toBeCloseTo((7 / 1284) * 100, 3);
  });

  it('renders zero-width bars rather than dividing by zero on an empty window', () => {
    const el = render({
      data: [{ key: 'a', label: 'A', value: 0, link: null }],
      total: 0,
    });
    const bar = el.querySelector('tbody th span[aria-hidden="true"]') as HTMLElement;
    expect(bar.style.width).toBe('0%');
    // No denominator means no share — better than "0%" of nothing being read as
    // a measured result. The `total` input is null-guarded for this.
    expect(el.querySelector('tbody td')?.textContent?.trim()).toBe('0');
  });

  it('renders an empty state when there are no rows', () => {
    const el = render({ data: [] });
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('No views recorded.');
  });
});
