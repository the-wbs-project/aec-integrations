/**
 * AECI-822. `LineChart` leaves a gap for a week with no data and never plots it
 * as zero (`ADMIN_PANEL_SPEC.md` §5.24.6 "never as zero", §8.1 item 4).
 *
 * `chart-a11y.component.spec.ts` keeps pinning the number-only output every
 * existing chart relies on. This spec covers the four things AECI-822 added:
 * `null` breaks the line, an all-`null` stretch is hatched and labelled, the
 * hidden table prints the gap label, and `openLast` / `unit="percent"`.
 */
import { provideZonelessChangeDetection, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LineChart } from './line-chart';
import { recordedRuns, unrecordedSpans, type NullableChartSeries } from './chart-types';

const WEEKS = ['1', '2', '3', '4', '5', '6'];

function render(inputs: Record<string, unknown>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(LineChart);
  fixture.componentRef.setInput('categories', WEEKS);
  fixture.componentRef.setInput('categoryHeader', 'Week');
  fixture.componentRef.setInput('ariaLabel', 'Pages not crawled');
  fixture.componentRef.setInput('emptyLabel', 'Nothing');
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The `d` of each series' line, in series order. */
function lines(el: HTMLElement): string[] {
  return [...el.querySelectorAll('svg path[fill="none"]')].map((p) => p.getAttribute('d') ?? '');
}

function moves(d: string): number {
  return (d.match(/M /g) ?? []).length;
}

function tableRows(el: HTMLElement): string[][] {
  return [...el.querySelectorAll('aec-chart-data-table tbody tr')].map((r) =>
    [...r.children].map((c) => (c.textContent ?? '').trim()),
  );
}

const series = (values: Array<number | null>, key = 'google'): NullableChartSeries => ({
  key,
  label: key,
  slot: 1,
  values,
});

describe('LineChart gaps (AECI-822)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a series with no null is one unbroken line, as before', () => {
    const el = render({ series: [series([5, 4, 3, 2, 1, 0])] });
    expect(lines(el)).toHaveLength(1);
    expect(moves(lines(el)[0]!)).toBe(1);
    expect(el.querySelectorAll('svg g[aria-hidden="true"] line').length).toBeGreaterThan(0);
  });

  it('a null breaks the line into separate runs instead of diving to zero', () => {
    const el = render({
      series: [series([400, 380, null, null, 350, 340])],
      gapLabel: 'Not recorded',
    });
    const d = lines(el)[0]!;
    expect(moves(d)).toBe(2);
    // Four plotted points, never six: the two nulls have no vertex at all.
    expect((d.match(/[ML] /g) ?? []).length).toBe(4);
  });

  it('never prints a null as 0 in the hidden table', () => {
    const el = render({
      series: [series([null, 12, 0]), series([null, 3, null], 'bing')],
      categories: ['a', 'b', 'c'],
      gapLabel: 'Not recorded',
    });
    expect(tableRows(el)).toEqual([
      ['a', 'Not recorded', 'Not recorded'],
      ['b', '12', '3'],
      ['c', '0', 'Not recorded'],
    ]);
  });

  it('hatches and labels a stretch where every series is null', () => {
    const el = render({
      series: [series([null, null, 5, 6, 7, 8]), series([null, null, 1, null, 2, 3], 'bing')],
      gapLabel: 'Not recorded',
    });
    const labels = [...el.querySelectorAll('span[aria-hidden="true"]')].filter(
      (s) => s.textContent?.trim() === 'Not recorded',
    );
    // Weeks 1 and 2 are empty in both series: one band. Week 4 is empty in Bing
    // only, which is a gap in that line and not a band.
    expect(labels).toHaveLength(1);
    expect(unrecordedSpans([series([null, null, 5]), series([null, null, null], 'b')], 3)).toEqual([
      { from: 0, to: 1 },
    ]);
  });

  it('draws the hatch at 3:1 and keeps the label as text at every width (AECI-823)', () => {
    const el = render({
      series: [series([null, null, 5, 6, 7, 8])],
      gapLabel: 'Not recorded',
    });
    // --border-field is 3.55:1 on the chart surface. The grid colour was 1.22:1.
    const hatch = [...el.querySelectorAll('svg line')].filter(
      (l) => l.getAttribute('stroke') === 'var(--border-field)',
    );
    expect(hatch.length).toBeGreaterThan(0);
    const label = [...el.querySelectorAll('span[aria-hidden="true"]')].find(
      (s) => s.textContent?.trim() === 'Not recorded',
    )!;
    // Narrow: the words run down the band. Never hidden.
    expect(label.className).toContain('@max-md:[writing-mode:vertical-rl]');
    expect(label.className).not.toContain('hidden');
  });

  it('a chart with no gap draws no hatch line at all', () => {
    const el = render({ series: [series([1, 2, 3, 4, 5, 6])], gapLabel: 'Not recorded' });
    expect(el.querySelectorAll('svg line[stroke="var(--border-field)"]')).toHaveLength(0);
  });

  it('draws no band and no label for number-only series', () => {
    const el = render({ series: [series([1, 2, 3, 4, 5, 6])], gapLabel: 'Not recorded' });
    expect(el.textContent).not.toContain('Not recorded');
  });

  it('openLast draws the last point hollow and off the line, and qualifies its cell', () => {
    const el = render({
      series: [series([0.2, 0.3, 0.4, 0.5, 0.6, 0.27])],
      unit: 'percent',
      openLast: true,
      openLabel: 'so far',
    });
    expect((lines(el)[0]!.match(/[ML] /g) ?? []).length).toBe(5);
    const hollow = el.querySelectorAll('svg circle[fill="var(--chart-surface)"]');
    expect(hollow).toHaveLength(1);
    expect(tableRows(el).at(-1)).toEqual(['6', '27% so far']);
    expect(tableRows(el)[0]).toEqual(['1', '20%']);
  });

  it('the visible tooltip says "so far" on the open week, as the table does', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(LineChart);
    for (const [k, v] of Object.entries({
      categories: WEEKS,
      categoryHeader: 'Week',
      ariaLabel: 'Crawled',
      emptyLabel: 'Nothing',
      series: [series([0.2, 0.3, 0.4, 0.5, 0.6, 0.27])],
      unit: 'percent',
      openLast: true,
      openLabel: 'so far',
    })) {
      fixture.componentRef.setInput(k, v);
    }
    const hover = (
      fixture.componentInstance as unknown as { hoverIndex: WritableSignal<number | null> }
    ).hoverIndex;
    const tooltip = () =>
      (fixture.nativeElement as HTMLElement).querySelector('div.pointer-events-none')
        ?.textContent ?? '';

    hover.set(6); // 1-based: the open week.
    fixture.detectChanges();
    expect(tooltip()).toContain('27% so far');

    hover.set(1);
    fixture.detectChanges();
    expect(tooltip()).toContain('20%');
    expect(tooltip()).not.toContain('so far');
  });

  // AECI-2125's relief legend writes a low-contrast series' latest value. With a
  // gap or a rate, that value follows the table: never a 0 for a null, and in
  // the chart's own unit.
  function reliefLegend(el: HTMLElement): string[] {
    const legend = el.querySelector('aec-chart-legend');
    return legend
      ? [...legend.querySelectorAll('li span:not([aria-hidden])')].map(
          (s) => s.textContent?.trim() ?? '',
        )
      : [];
  }

  it('a relief legend prints the gap label, not 0, when the last value is null', () => {
    const el = render({
      series: [{ ...series([5, 4, 3, 2, 1, null]), slot: 4 }],
      gapLabel: 'Not recorded',
    });
    expect(reliefLegend(el)).toEqual(['google', 'Not recorded']);
  });

  it('a relief legend prints a percent chart in percent, with the open-week label', () => {
    const el = render({
      series: [{ ...series([0.1, 0.2, 0.3, 0.2, 0.1, 0.27]), slot: 3 }],
      unit: 'percent',
      openLast: true,
      openLabel: 'so far',
    });
    expect(reliefLegend(el)).toEqual(['google', '27% so far']);
  });

  it('a percent axis always runs to 100%', () => {
    const el = render({ series: [series([0.1, 0.2, 0.3, 0.2, 0.1, 0.2])], unit: 'percent' });
    const ticks = [...el.querySelectorAll('div[aria-hidden="true"] > span')].map((s) =>
      s.textContent?.trim(),
    );
    expect(ticks).toContain('100%');
    expect(ticks).toContain('0%');
  });

  it('recordedRuns splits on null and keeps a null-free list whole', () => {
    expect(recordedRuns([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(recordedRuns([null, 1, null, 2, 3, null])).toEqual([[1], [2, 3]]);
    expect(recordedRuns([null, null])).toEqual([]);
  });
});
