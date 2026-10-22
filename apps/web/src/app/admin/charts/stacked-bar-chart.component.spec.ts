/**
 * AECI-1346 — `StackedBarChart` annotations: series fills, unmeasured columns and
 * boundaries, and how each composes with the AECI-877 degraded hatch.
 *
 * The overview spec covers the chart as the page wires it. This file covers the
 * component contract, including that a caller passing none of the new inputs
 * draws exactly what it drew before.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StackedBarPoint } from './chart-geometry';
import { StackedBarChart } from './stacked-bar-chart';

const FOUR = ['A', 'B', 'C', 'D'];
const FILLS = ['var(--f0)', 'var(--f1)', 'var(--f2)', 'var(--f3)'];

function render(points: StackedBarPoint[], inputs: Record<string, unknown> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(StackedBarChart);
  fixture.componentRef.setInput('points', points);
  fixture.componentRef.setInput('seriesLabels', inputs['seriesLabels'] ?? FOUR);
  fixture.componentRef.setInput('label', 'Requests per day');
  fixture.componentRef.setInput('emptyLabel', 'Nothing recorded.');
  for (const [k, v] of Object.entries(inputs)) {
    if (k !== 'seriesLabels') fixture.componentRef.setInput(k, v);
  }
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const headers = (el: HTMLElement) =>
  [...el.querySelectorAll('table.sr-only thead th')].map((th) => th.textContent?.trim());

describe('StackedBarChart', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('keeps the two-series default fills for a caller that passes none', () => {
    const el = render([{ label: 'd1', segments: [1, 1] }], { seriesLabels: ['Human', 'Bot'] });
    const fills = [...el.querySelectorAll('svg rect')].map((r) => r.getAttribute('fill'));
    expect(fills).toEqual(['var(--accent-primary)', 'var(--accent-secondary-deep)']);
    expect(headers(el)).toEqual(['Day', 'Human', 'Bot']);
  });

  it('paints four series from seriesFills, in legend and bars alike', () => {
    const el = render([{ label: 'd1', segments: [1, 2, 3, 4] }], { seriesFills: FILLS });
    const fills = [...el.querySelectorAll('svg rect')].map((r) => r.getAttribute('fill'));
    expect(fills).toEqual(FILLS);
    const swatches = [...el.querySelectorAll('ul li span[aria-hidden="true"]')].map(
      (s) => (s as HTMLElement).style.backgroundColor,
    );
    expect(swatches).toHaveLength(4);
  });

  it('outlines an unmeasured column, lists it once, and says so in every table cell', () => {
    const el = render(
      [
        { label: 'd1', segments: [1, 2, 3, 4] },
        { label: 'd2', segments: [], notMeasured: true },
      ],
      { seriesFills: FILLS, notMeasuredLabel: 'Not classified' },
    );
    expect(el.querySelectorAll('rect[data-not-measured]')).toHaveLength(1);
    expect(el.querySelectorAll('ul li')).toHaveLength(5);
    expect(headers(el)).toEqual(['Day', ...FOUR, 'Not classified']);
    const row = [...el.querySelectorAll('table.sr-only tbody tr')][1]!;
    expect([...row.querySelectorAll('td')].map((td) => td.textContent?.trim())).toEqual([
      'Not classified',
      'Not classified',
      'Not classified',
      'Not classified',
      'Yes',
    ]);
  });

  it('draws an all-unmeasured window as outlines, not as the empty state', () => {
    const el = render(
      [
        { label: 'd1', segments: [], notMeasured: true },
        { label: 'd2', segments: [], notMeasured: true },
      ],
      { notMeasuredLabel: 'Not classified' },
    );
    expect(el.querySelectorAll('rect[data-not-measured]')).toHaveLength(2);
    expect(el.textContent).not.toContain('Nothing recorded.');
    // No bars, so no scale: "Scale 0 to 1" would describe nothing.
    expect(el.textContent).not.toContain('Scale');
  });

  it('draws one rule per boundary day with a legend entry per distinct change', () => {
    const el = render(
      [
        { label: 'd1', segments: [1, 1, 1, 1], version: 'v1' },
        {
          label: 'd2',
          segments: [1, 1, 1, 1],
          version: 'v2',
          boundaryBefore: ['Classifier changed: v1 to v2', 'Collection method changed'],
        },
        { label: 'd3', segments: [1, 1, 1, 1], version: 'v2' },
      ],
      { versionLabel: 'Classifier version' },
    );
    expect(el.querySelectorAll('line[data-boundary]')).toHaveLength(1);
    const legend = [...el.querySelectorAll('ul li')].map((li) => li.textContent?.trim());
    expect(legend).toContain('Classifier changed: v1 to v2');
    expect(legend).toContain('Collection method changed');
    expect(headers(el)).toEqual(['Day', ...FOUR, 'Classifier version', 'Change before this day']);
    const cells = [...el.querySelectorAll('table.sr-only tbody tr')][1]!.querySelectorAll('td');
    expect(cells[4]!.textContent?.trim()).toBe('v2');
    expect(cells[5]!.textContent).toContain('Classifier changed: v1 to v2');
  });

  it('adds no annotation legend, mark or column when nothing is marked', () => {
    const el = render([{ label: 'd1', segments: [1, 1, 1, 1] }], {
      notMeasuredLabel: 'Not classified',
      versionLabel: 'Classifier version',
    });
    expect(el.querySelector('rect[data-not-measured]')).toBeNull();
    expect(el.querySelector('line[data-boundary]')).toBeNull();
    expect(headers(el)).toEqual(['Day', ...FOUR]);
  });

  it('composes the degraded hatch with an unmeasured column and with a boundary', () => {
    const el = render(
      [
        { label: 'd1', segments: [1, 1, 1, 1] },
        { label: 'd2', segments: [], notMeasured: true, degraded: true },
        { label: 'd3', segments: [2, 2, 2, 2], degraded: true, boundaryBefore: ['Changed'] },
      ],
      { notMeasuredLabel: 'Not classified', degradedLabel: 'Missing network information' },
    );
    // A hatch over the outline AND over the bars of the boundary day.
    expect(el.querySelectorAll('rect[data-degraded-day]')).toHaveLength(2);
    expect(el.querySelectorAll('rect[data-not-measured]')).toHaveLength(1);
    expect(el.querySelectorAll('line[data-boundary]')).toHaveLength(1);
    expect(headers(el)).toEqual([
      'Day',
      ...FOUR,
      'Missing network information',
      'Not classified',
      'Change before this day',
    ]);
  });
});
