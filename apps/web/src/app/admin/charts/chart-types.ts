/**
 * Shared chart vocabulary — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §8, `DESIGN.md` §"Data visualization".
 *
 * Angular-free, like its siblings `geometry.ts` and `format.ts`, so the charts'
 * data shapes can be asserted in the fast plain-Vitest runner.
 *
 * ─── Why `slot` is on the series and not derived ─────────────────────────────
 *
 * The `dataviz` rule is "colour follows the entity, never its rank": a filter
 * that changes the series count must not repaint the survivors. If a chart
 * assigned colours by array index, hiding "bots" would turn "humans" orange, and
 * a reader comparing two screenshots would read a change that never happened.
 * So the palette slot is declared by the CALLER as part of the series identity
 * and travels with it. Human is always slot 1; bot is always slot 2.
 */

/**
 * A palette slot, 1-based, matching `.chart-fill-N` / `.chart-stroke-N` /
 * `.chart-swatch-N` in `styles.css`.
 *
 * Eight is the ceiling, not a soft limit: a ninth generated hue is
 * indistinguishable from an existing one under colour-vision deficiency and
 * fails every check in the validated set. Past eight, a series folds into
 * `'other'` — which is why that is a member here rather than a ninth number.
 */
export type ChartSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'other';

/** One named series of values, index-aligned to a shared category axis. */
export interface ChartSeries {
  /** Stable identity. Not shown; used for `track` and for the slot mapping. */
  key: string;
  /** Already localized by the caller — nothing in `charts/` calls `$localize`
   *  on domain text it did not author. */
  label: string;
  slot: ChartSlot;
  values: readonly number[];
}

/**
 * A series that may have no value at some positions (AECI-822). `null` means
 * "no value was recorded here", which is a different claim from zero: the line
 * chart leaves a gap and the data table prints the caller's gap label.
 *
 * Every `ChartSeries` is assignable to this, so a chart or table that accepts it
 * keeps every existing caller compiling. Only `LineChart` and `ChartDataTable`
 * accept it today. The stacked charts keep `ChartSeries`, because a stack has no
 * honest way to draw a missing segment.
 */
export interface NullableChartSeries extends Omit<ChartSeries, 'values'> {
  values: readonly (number | null)[];
}

/** One row of a categorical chart (a horizontal bar, a donut slice). */
export interface ChartCategory {
  /** Stable identity. The empty string is legitimate: it is how the API's
   *  `key: null` unattributed bucket arrives after the page has replaced the
   *  untranslated server `label` with a localized placeholder. */
  key: string;
  /** Already localized by the caller. */
  label: string;
  value: number;
  slot?: ChartSlot;
  /** Router commands when the row links somewhere (the hydrated `LinkRef` on a
   *  `dimension=product` breakdown). Null for every other dimension. */
  link?: readonly string[] | null;
}

/**
 * Split a series' points into runs of consecutive recorded values (AECI-822).
 *
 * Each index maps to a point, or to `null` when it has no value. A `null` ends
 * the current run, so a line drawn per run leaves a gap there instead of diving
 * to zero. A series with no `null` yields exactly one run of every point, which
 * is what keeps an existing chart's path byte-for-byte unchanged.
 */
export function recordedRuns<T>(points: readonly (T | null)[]): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * The index ranges where EVERY series is `null`, inclusive at both ends. The
 * line chart shades these as one "not recorded" band, because nothing at all was
 * stored there. An index where only some series are missing is a gap in those
 * lines and gets no band.
 */
export function unrecordedSpans(
  series: ReadonlyArray<{ values: readonly (number | null)[] }>,
  count: number,
): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  if (series.length === 0) return spans;
  let start: number | null = null;
  for (let i = 0; i < count; i++) {
    const empty = series.every((s) => s.values[i] === null);
    if (empty && start === null) start = i;
    if (!empty && start !== null) {
      spans.push({ from: start, to: i - 1 });
      start = null;
    }
  }
  if (start !== null) spans.push({ from: start, to: count - 1 });
  return spans;
}

/** The CSS class for a slot's SVG fill / stroke, or an HTML swatch background. */
export function slotClass(slot: ChartSlot, kind: 'fill' | 'stroke' | 'swatch'): string {
  return `chart-${kind}-${slot}`;
}
