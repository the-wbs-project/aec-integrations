/**
 * AECI-578 / Phase 8.3 P1.4 — `StackedBarChart` rendering logic.
 *
 * The shared §8 a11y contract is asserted in `chart-a11y.component.spec.ts`. This
 * file covers what is specific to stacking, and specifically the two mistakes
 * that produce a chart which looks right and is wrong:
 *
 *   1. scaling the y-axis to the tallest single series instead of the stack
 *      total, which clips the top segment above its own axis, and
 *   2. putting the rounded data-end cap on a segment that is not the top one,
 *      which reads as a gap in the middle of a column.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { StackedBarChart } from './stacked-bar-chart';
import type { ChartSeries } from './chart-types';

const DAYS = ['1 Aug', '2 Aug', '3 Aug'];

function render(series: ChartSeries[], area = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(StackedBarChart);
  fixture.componentRef.setInput('series', series);
  fixture.componentRef.setInput('categories', DAYS);
  fixture.componentRef.setInput('categoryHeader', 'Day (UTC)');
  fixture.componentRef.setInput('ariaLabel', 'Page views per day');
  fixture.componentRef.setInput('emptyLabel', 'No views recorded.');
  fixture.componentRef.setInput('area', area);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** Data marks only — gridlines and the hover highlight are not `<path>`s. */
function marks(el: HTMLElement): SVGPathElement[] {
  return [...el.querySelectorAll('svg path')] as unknown as SVGPathElement[];
}

/** The vertical extent of a path, read back out of its `d`. */
function yRange(path: SVGPathElement): { min: number; max: number } {
  const ys = [...(path.getAttribute('d') ?? '').matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map((m) =>
    Number(m[1]),
  );
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

describe('StackedBarChart', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('draws one mark per non-zero segment', () => {
    const el = render([
      { key: 'human', label: 'Human', slot: 1, values: [10, 20, 30] },
      { key: 'bot', label: 'Bot', slot: 2, values: [5, 0, 15] },
    ]);
    // 3 human + 2 bot (the bot zero on 2 Aug draws nothing).
    expect(marks(el)).toHaveLength(5);
  });

  it('scales to the stack TOTAL, so the top segment never escapes the axis', () => {
    const el = render([
      { key: 'a', label: 'A', slot: 1, values: [60] as number[] },
      { key: 'b', label: 'B', slot: 2, values: [60] as number[] },
    ]);
    // Scaled to the tallest single series (60) the stack would reach 200% of the
    // plot. Every mark must sit inside the 220-unit viewBox.
    for (const path of marks(el)) {
      const ys = [...(path.getAttribute('d') ?? '').matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map((m) =>
        Number(m[1]),
      );
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(220);
    }
  });

  it('caps only the topmost segment, leaving interior segments square', () => {
    const el = render([
      { key: 'a', label: 'A', slot: 1, values: [10] as number[] },
      { key: 'b', label: 'B', slot: 2, values: [10] as number[] },
    ]);
    const ds = marks(el).map((p) => p.getAttribute('d') ?? '');
    const withArcs = ds.filter((d) => d.includes('A '));
    expect(withArcs).toHaveLength(1);
  });

  it('leaves a 2-unit surface gap between touching segments', () => {
    // Without it, `human` under `bot` reads as one bar with a coloured
    // underline instead of two quantities. Caught by looking at the rendered
    // chart, not by any test that existed before this one.
    const el = render([
      { key: 'human', label: 'Human', slot: 1, values: [100] as number[] },
      { key: 'bot', label: 'Bot', slot: 2, values: [100] as number[] },
    ]);
    const [human, bot] = marks(el).map((p) => yRange(p));
    // Bot sits above human, so bot's bottom edge and human's top edge are the
    // boundary; white must separate them.
    expect(human!.min - bot!.max).toBe(2);
  });

  it('shrinks rather than inverting when a segment is thinner than the gap', () => {
    const el = render([
      { key: 'human', label: 'Human', slot: 1, values: [1] as number[] },
      { key: 'bot', label: 'Bot', slot: 2, values: [100_000] as number[] },
    ]);
    for (const path of marks(el)) {
      const { min, max } = yRange(path);
      expect(max).toBeGreaterThanOrEqual(min);
      expect(path.getAttribute('d')).not.toContain('NaN');
    }
  });

  it('moves the cap to whichever series is actually on top that day', () => {
    // Bot is zero on day 1, so human must take the cap there even though bot is
    // the upper series in the stack order.
    const el = render([
      { key: 'human', label: 'Human', slot: 1, values: [10, 10] },
      { key: 'bot', label: 'Bot', slot: 2, values: [0, 10] },
    ]);
    const capped = marks(el).filter((p) => (p.getAttribute('d') ?? '').includes('A '));
    expect(capped).toHaveLength(2); // one per day, never two on the same day
  });

  it('shows the legend for two series and the entity keeps its slot', () => {
    const el = render([
      { key: 'human', label: 'Human', slot: 1, values: [1] as number[] },
      { key: 'bot', label: 'Bot', slot: 2, values: [1] as number[] },
    ]);
    const swatches = [...el.querySelectorAll('aec-chart-legend li span[aria-hidden="true"]')];
    expect(swatches).toHaveLength(2);
    expect(swatches[0]!.className).toContain('chart-swatch-1');
    expect(swatches[1]!.className).toContain('chart-swatch-2');
  });

  it('omits the legend for a single series — the title already names it', () => {
    const el = render([{ key: 'human', label: 'Human', slot: 1, values: [1, 2, 3] }]);
    expect(el.querySelector('aec-chart-legend')).toBeNull();
  });

  it('renders bands rather than columns in the area variant', () => {
    const el = render(
      [
        { key: 'a', label: 'A', slot: 1, values: [1, 2, 3] },
        { key: 'b', label: 'B', slot: 2, values: [3, 2, 1] },
      ],
      true,
    );
    // One band per series, not one mark per segment.
    expect(marks(el)).toHaveLength(2);
  });

  it('renders an all-zero window without NaN in any path', () => {
    const el = render([{ key: 'a', label: 'A', slot: 1, values: [0, 0, 0] }]);
    for (const path of marks(el)) {
      expect(path.getAttribute('d')).not.toContain('NaN');
    }
    // The table still reports the zeros — the numbers are never lost.
    expect(el.querySelector('table')?.textContent).toContain('0');
  });

  it('draws a single-day window as one visible column', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(StackedBarChart);
    fixture.componentRef.setInput('series', [
      { key: 'a', label: 'A', slot: 1, values: [42] },
    ] satisfies ChartSeries[]);
    fixture.componentRef.setInput('categories', ['1 Aug']);
    fixture.componentRef.setInput('categoryHeader', 'Day (UTC)');
    fixture.componentRef.setInput('ariaLabel', 'One day');
    fixture.componentRef.setInput('emptyLabel', 'No views recorded.');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(marks(el)).toHaveLength(1);
    expect(marks(el)[0]!.getAttribute('d')).not.toBe('');
  });

  it('scales via viewBox and never via a resize handler', () => {
    const el = render([{ key: 'a', label: 'A', slot: 1, values: [1, 2, 3] }]);
    const svg = el.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 720 220');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  });
});
