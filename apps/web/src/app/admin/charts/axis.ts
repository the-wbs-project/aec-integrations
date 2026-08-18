/**
 * The time-series axis model — AECI-578 / Phase 8.3 P1.4.
 *
 * Composes `geometry.ts` (primitives) and `format.ts` (label thinning) into the
 * one shape both time-series charts render. Pure and Angular-free like its
 * siblings, so it tests in the fast runner.
 *
 * ─── Why every position is also a percentage ─────────────────────────────────
 *
 * Axis tick labels and date labels are rendered as **HTML positioned over the
 * SVG**, not as `<text>` inside it. The reason is legibility, and it is not
 * cosmetic: an SVG scaled by `viewBox` scales its text too, so a chart in a
 * narrow column renders 6px axis labels — below any reasonable reading size,
 * invisible to axe, and unfixable without the JS resize handler §8 forbids. HTML
 * labels stay at their CSS size at every width.
 *
 * That is what `pct` is for. The SVG is laid out in user units; the HTML overlay
 * is positioned in percentages of the same box. Because the `<svg>` is
 * `width: 100%; height: auto` with a fixed `viewBox`, the two coordinate systems
 * are the same box scaled uniformly — so a percentage lands exactly where the
 * user-unit coordinate does, at any width, with nothing measured.
 */

import { axisLabelIndices } from './format';
import {
  bandScale,
  linearScale,
  niceTicks,
  plotArea,
  stackTotals,
  valueDomain,
  type Band,
  type ChartBox,
  type Domain,
  type PlotArea,
} from './geometry';

/** A value-axis tick, with both the SVG coordinate and the HTML overlay percent. */
export interface AxisTick {
  value: number;
  /** SVG user units. */
  y: number;
  /** Percentage of the box height, for the HTML label overlay. */
  pct: number;
}

/** A category-axis label position. */
export interface AxisCategory {
  index: number;
  /** SVG user units. */
  x: number;
  /** Percentage of the box width, for the HTML label overlay. */
  pct: number;
}

export interface TimeAxis {
  box: ChartBox;
  plot: PlotArea;
  domain: Domain;
  bands: Band[];
  ticks: AxisTick[];
  /** Only the indices that get a visible label — thinned to avoid collision. */
  labelled: AxisCategory[];
  /** Value → SVG y. */
  y: (value: number) => number;
  /** True when there is nothing to plot; the chart renders its empty state. */
  isEmpty: boolean;
}

export interface TimeAxisOptions {
  box: ChartBox;
  /** Number of category slots (days). */
  count: number;
  /** Every series' values. Stacked charts pass all of them; the domain must
   *  accommodate the STACK TOTAL, not the tallest single series, or the top
   *  segment renders above its own axis. */
  series: ReadonlyArray<readonly number[]>;
  /** Stacked charts sum per index; overlaid charts take the max. */
  stacked: boolean;
  /** Surface gap between touching marks, in user units. */
  gap?: number;
  targetTicks?: number;
  maxLabels?: number;
}

export function buildTimeAxis(options: TimeAxisOptions): TimeAxis {
  const { box, count, series, stacked } = options;
  const plot = plotArea(box);

  // A stacked chart's y-domain is driven by the per-index TOTAL. Using the
  // tallest single series instead is the classic stacked-chart bug: the sum
  // exceeds the axis and the top segment is clipped.
  const domainValues = stacked ? stackTotals(series) : series.flatMap((s) => [...s]);
  const domain = valueDomain(domainValues);

  const y = linearScale(domain, plot.y + plot.height, plot.y);
  const bands = bandScale(count, plot.x, plot.width, options.gap ?? 0);

  const ticks: AxisTick[] = niceTicks(domain, options.targetTicks ?? 4).map((value) => {
    const py = y(value);
    return { value, y: py, pct: box.height > 0 ? (py / box.height) * 100 : 0 };
  });

  const labelled: AxisCategory[] = axisLabelIndices(count, options.maxLabels ?? 7).map((index) => {
    const x = bands[index]?.center ?? plot.x;
    return { index, x, pct: box.width > 0 ? (x / box.width) * 100 : 0 };
  });

  return { box, plot, domain, bands, ticks, labelled, y, isEmpty: count === 0 };
}
