/**
 * Chart geometry — AECI-578 / Phase 8.3 P1.4. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §8, and the `dataviz` skill for mark specs.
 *
 * Every function here is **pure**: data in, numbers and path strings out. That is
 * the §8 SSR-safety rule stated as a constraint on this file rather than as a
 * habit — no DOM measurement, no `window`, no `getBBox`, no post-hydration layout
 * pass. A chart's geometry is a function of its data and a declared viewBox, so
 * the SSR HTML is already correct and hydration changes nothing.
 *
 * **This module imports nothing from `@angular/*`, and must not start.** That is
 * not stylistic: `apps/web/vitest.config.ts` runs every `.spec.ts` under `src/`
 * in a plain Node Vitest and excludes `*.component.spec.ts` (which need the
 * Angular build pipeline). Keeping this file Angular-free is what lets
 * `geometry.spec.ts`
 * run in the fast runner, which is in turn what makes the §11 "pure-function unit
 * tests … no rendering involved" requirement cheap enough to be exhaustive.
 *
 * ─── The four awkward cases, solved once ─────────────────────────────────────
 *
 * §11 calls out empty, single-point, all-zero, and single-dominant-outlier
 * series. They are handled HERE, in {@link valueDomain} and {@link bandScale},
 * rather than in each chart — otherwise five components each grow their own
 * subtly different guard and one of them divides by zero.
 *
 *   - **empty** — `valueDomain([])` returns the unit domain and every chart
 *     renders its empty state instead of marks. Nothing throws.
 *   - **all-zero** — max is 0, so the domain is forced to `[0, 1]`: marks collapse
 *     onto the baseline and the axis reads 0/1 rather than producing `0/0` NaN
 *     paths.
 *   - **single point** — a one-slot band is centred rather than given zero width,
 *     so a lone value plots as a visible mark in the middle of the plot area
 *     instead of a zero-width sliver at x=0.
 *   - **dominant outlier** — deliberately NOT special-cased. {@link niceTicks}
 *     still yields round numbers and the small bars stay small: an outlier that
 *     flattens its neighbours is the truth about the data. No auto-log, no
 *     clipped axis — both would misreport it.
 */

/** A rendered chart's coordinate space, in SVG user units. Charts scale via
 *  `viewBox` + `preserveAspectRatio`, so these are never CSS pixels and never
 *  need to match the element's rendered size. */
export interface ChartBox {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

/** A point in chart user units. */
export interface Point {
  x: number;
  y: number;
}

/** A closed numeric interval. `min` may exceed 0 only when a caller opts out of a
 *  zero baseline, which no chart here does — bar and area charts MUST start at
 *  zero (truncating a bar baseline is the most misleading thing a chart can do). */
export interface Domain {
  min: number;
  max: number;
}

/** The plot area — the box minus its padding. Axis labels live in the padding. */
export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function plotArea(box: ChartBox): PlotArea {
  return {
    x: box.padding.left,
    y: box.padding.top,
    width: Math.max(0, box.width - box.padding.left - box.padding.right),
    height: Math.max(0, box.height - box.padding.top - box.padding.bottom),
  };
}

/**
 * The value (y) domain for a set of series, always anchored at zero.
 *
 * Returns `[0, 1]` for an empty or all-zero input. Both would otherwise give a
 * zero-height domain, and every subsequent division by `max - min` would be
 * `0/0` → `NaN` → an SVG path the browser silently drops. Returning a unit
 * domain means the chart renders a correct, empty-looking plot instead.
 */
export function valueDomain(values: readonly number[]): Domain {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) max = v;
  }
  return { min: 0, max: max > 0 ? max : 1 };
}

/**
 * Map a value onto a pixel position. Returns the range start for a degenerate
 * domain rather than `NaN` — {@link valueDomain} already prevents that, but a
 * caller passing a hand-built domain should still get a drawable number.
 */
export function linearScale(domain: Domain, rangeStart: number, rangeEnd: number) {
  const span = domain.max - domain.min;
  return (value: number): number => {
    if (span === 0 || !Number.isFinite(value)) return rangeStart;
    const t = (value - domain.min) / span;
    return rangeStart + t * (rangeEnd - rangeStart);
  };
}

/** One slot in a categorical band. `center` is where a line's vertex or a
 *  column's midpoint sits; `start`/`width` bound a bar. */
export interface Band {
  start: number;
  center: number;
  width: number;
}

/**
 * Split a span into `count` evenly spaced slots.
 *
 * `gap` is the §"two spacers" surface gap — the white separating touching marks.
 * It is subtracted from the slot, never drawn as a stroke.
 *
 * `count === 0` returns no bands (the empty-series case; the caller renders its
 * empty state). `count === 1` returns one full-span band, so a single point plots
 * at the centre of the plot area rather than at its left edge.
 */
export function bandScale(count: number, start: number, span: number, gap = 0): Band[] {
  if (count <= 0 || span <= 0) return [];
  const slot = span / count;
  // Never let the gap eat the mark: a 90-day window at a small width has thin
  // slots, and a fixed 2px gap would otherwise invert the width to negative.
  const effectiveGap = Math.min(gap, slot * 0.5);
  const width = Math.max(slot - effectiveGap, slot * 0.5);
  return Array.from({ length: count }, (_, i) => {
    const center = start + slot * i + slot / 2;
    return { start: center - width / 2, center, width };
  });
}

/**
 * Axis ticks at round numbers — 0 / 500 / 1,000, never 0 / 437 / 874.
 *
 * Steps come from the 1-2-5 ladder scaled by a power of ten, which is what makes
 * every tick a number a reader can hold in their head. The returned array always
 * starts at the domain min and always covers `domain.max`, so the top gridline is
 * at or above the tallest mark and nothing renders outside the plot area.
 *
 * `target` is a hint, not a promise: snapping to a round step means the actual
 * count lands near it, which is the trade that buys readable numbers.
 */
export function niceTicks(domain: Domain, target = 4): number[] {
  const span = domain.max - domain.min;
  if (span <= 0 || !Number.isFinite(span)) return [domain.min];
  const rawStep = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  // The 1-2-5 ladder, selected on the GEOMETRIC midpoints (√2, √10, √50) rather
  // than on `<= 1 / 2 / 5`. The naive comparison rounds 2.5 up to 5 and halves
  // the tick count — a 0–1000 axis comes out as 0/500/1000, which is too coarse
  // to read a value off. The geometric thresholds pick whichever rung is
  // proportionally nearer, which is what "nice" means here. (Same selection
  // d3-array uses; recorded because the constants look arbitrary otherwise.)
  const step =
    magnitude *
    (normalized >= Math.sqrt(50)
      ? 10
      : normalized >= Math.sqrt(10)
        ? 5
        : normalized >= Math.sqrt(2)
          ? 2
          : 1);

  // Extend to the first step AT OR ABOVE the max, so the top gridline is never
  // below the tallest mark. Stopping at "near enough" leaves a bar sticking out
  // above its own axis.
  const end = Math.ceil(domain.max / step) * step;
  const count = Math.min(64, Math.floor((end - domain.min) / step) + 1);
  // Indexed rather than accumulated: repeated float addition drifts, and a tick
  // labelled "1500.0000000000002" is a visible bug.
  return Array.from({ length: count }, (_, i) => Number((domain.min + i * step).toFixed(10)));
}

/**
 * A polyline `d` for a series of points.
 *
 * A **single point produces a short horizontal segment**, not a bare `M`. An SVG
 * path with only a move-to renders nothing at all — with `stroke-linecap: round`
 * a zero-length segment does render as a dot, but only in some engines, so the
 * segment is explicit. A one-day window should show its one value, not a blank
 * chart.
 */
export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0]!;
    return `M ${round(p.x - 0.5)} ${round(p.y)} L ${round(p.x + 0.5)} ${round(p.y)}`;
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ');
}

/**
 * A closed area `d` — the line, dropped to the baseline and closed. The fill is
 * the series hue at ~10% opacity (a wash, never a saturated block); that opacity
 * is the component's business, the shape is this function's.
 */
export function areaPath(points: readonly Point[], baselineY: number): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const line = points.map((p) => `L ${round(p.x)} ${round(p.y)}`).join(' ');
  return `M ${round(first.x)} ${round(baselineY)} ${line} L ${round(last.x)} ${round(baselineY)} Z`;
}

/** One series' contribution to a stack at a single index. */
export interface StackSegment {
  /** Cumulative value at the bottom of this segment. */
  base: number;
  /** Cumulative value at the top of this segment (`base + value`). */
  top: number;
  value: number;
}

/**
 * Cumulative offsets for a stacked bar / area.
 *
 * `series` is an array of equal-length value arrays, bottom series first, and the
 * result mirrors that shape. Series shorter than the longest are treated as zero
 * past their end rather than throwing — a chart is not the right place to
 * discover a ragged API response, and the visually-hidden table will still show
 * the real numbers.
 */
export function stackSeries(series: ReadonlyArray<readonly number[]>): StackSegment[][] {
  const length = series.reduce((max, s) => Math.max(max, s.length), 0);
  const running = new Array<number>(length).fill(0);
  return series.map((values) =>
    Array.from({ length }, (_, i) => {
      const value = Number.isFinite(values[i]) ? values[i]! : 0;
      const base = running[i]!;
      const top = base + value;
      running[i] = top;
      return { base, top, value };
    }),
  );
}

/** Per-index totals of a stack — the value the y-domain must accommodate. */
export function stackTotals(series: ReadonlyArray<readonly number[]>): number[] {
  const length = series.reduce((max, s) => Math.max(max, s.length), 0);
  return Array.from({ length }, (_, i) =>
    series.reduce((sum, s) => sum + (Number.isFinite(s[i]) ? s[i]! : 0), 0),
  );
}

/**
 * A rounded-data-end bar path: **4px rounded at the data end, square at the
 * baseline**. The asymmetry is the point — rounding both ends detaches the bar
 * from its axis and makes it read as a floating pill.
 *
 * `orientation: 'vertical'` grows up from `y + height`; `'horizontal'` grows
 * right from `x`. A bar shorter than the radius degrades to a plain rect rather
 * than producing a self-intersecting arc.
 */
export function barPath(
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
  orientation: 'vertical' | 'horizontal',
): string {
  const { x, y, width: w, height: h } = rect;
  if (w <= 0 || h <= 0) return '';
  if (orientation === 'vertical') {
    const r = Math.min(radius, w / 2, h);
    if (r <= 0) return rectPath(rect);
    return [
      `M ${round(x)} ${round(y + h)}`,
      `L ${round(x)} ${round(y + r)}`,
      `A ${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)}`,
      `L ${round(x + w - r)} ${round(y)}`,
      `A ${round(r)} ${round(r)} 0 0 1 ${round(x + w)} ${round(y + r)}`,
      `L ${round(x + w)} ${round(y + h)}`,
      'Z',
    ].join(' ');
  }
  const r = Math.min(radius, h / 2, w);
  if (r <= 0) return rectPath(rect);
  return [
    `M ${round(x)} ${round(y)}`,
    `L ${round(x + w - r)} ${round(y)}`,
    `A ${round(r)} ${round(r)} 0 0 1 ${round(x + w)} ${round(y + r)}`,
    `L ${round(x + w)} ${round(y + h - r)}`,
    `A ${round(r)} ${round(r)} 0 0 1 ${round(x + w - r)} ${round(y + h)}`,
    `L ${round(x)} ${round(y + h)}`,
    'Z',
  ].join(' ');
}

function rectPath(rect: { x: number; y: number; width: number; height: number }): string {
  const { x, y, width: w, height: h } = rect;
  return `M ${round(x)} ${round(y)} L ${round(x + w)} ${round(y)} L ${round(x + w)} ${round(
    y + h,
  )} L ${round(x)} ${round(y + h)} Z`;
}

/** One donut slice, with everything a label needs already computed. */
export interface DonutSegment {
  /** Index into the original values array — the palette slot follows the entity,
   *  never the sort order, so this is what a colour class is keyed on. */
  index: number;
  value: number;
  /** Share of the total, 0..1. Zero when the total is zero. */
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
  /** Where a leader line or direct label anchors — the arc's mid-radius point. */
  labelPoint: Point;
}

/**
 * Donut slices for a set of values.
 *
 * Angles run clockwise from 12 o'clock, which is where a reader's eye starts.
 * `gapDegrees` is the surface gap between slices, applied only when there is
 * more than one non-zero slice (a lone slice must close into a full ring, and
 * subtracting a gap from 360° would leave a visible notch in a 100% value).
 *
 * **Zero-valued entries produce no slice.** A zero-area arc still renders a hairline
 * seam at some zoom levels, and it would take a legend row for a slice that isn't
 * there.
 */
export function donutSegments(
  values: readonly number[],
  options: {
    cx: number;
    cy: number;
    outerRadius: number;
    innerRadius: number;
    gapDegrees?: number;
  },
): DonutSegment[] {
  const { cx, cy, outerRadius, innerRadius } = options;
  const total = values.reduce((sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (total <= 0) return [];

  const nonZero = values.filter((v) => Number.isFinite(v) && v > 0).length;
  const gap = nonZero > 1 ? (options.gapDegrees ?? 2) : 0;
  const midRadius = (outerRadius + innerRadius) / 2;

  const segments: DonutSegment[] = [];
  let cursor = 0;
  values.forEach((raw, index) => {
    const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (value === 0) return;
    const share = value / total;
    const sweep = share * 360;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    // Halve the gap into each side of the boundary so slices stay centred on
    // their true share; clamp so a sliver never inverts into a negative sweep.
    const inset = Math.min(gap / 2, sweep / 4);
    const a0 = startAngle + inset;
    const a1 = endAngle - inset;
    const mid = (startAngle + endAngle) / 2;
    segments.push({
      index,
      value,
      share,
      startAngle,
      endAngle,
      path: arcPath(cx, cy, outerRadius, innerRadius, a0, a1),
      labelPoint: polar(cx, cy, midRadius, mid),
    });
  });
  return segments;
}

/**
 * A donut-segment `d` — an annular sector between two radii. Angles are degrees
 * clockwise from 12 o'clock.
 *
 * A sweep at or beyond 360° is drawn as two half-arcs plus an inner ring, because
 * a single arc whose start and end coincide is a no-op in SVG: the 100%-of-one-
 * category case would silently render nothing.
 */
export function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  if (sweep <= 0) return '';
  if (sweep >= 359.999) {
    return [
      `M ${round(cx)} ${round(cy - outerRadius)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy + outerRadius)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy - outerRadius)}`,
      `M ${round(cx)} ${round(cy - innerRadius)}`,
      `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(cx)} ${round(cy + innerRadius)}`,
      `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(cx)} ${round(cy - innerRadius)}`,
      'Z',
    ].join(' ');
  }
  const largeArc = sweep > 180 ? 1 : 0;
  const o0 = polar(cx, cy, outerRadius, startAngle);
  const o1 = polar(cx, cy, outerRadius, endAngle);
  const i1 = polar(cx, cy, innerRadius, endAngle);
  const i0 = polar(cx, cy, innerRadius, startAngle);
  return [
    `M ${round(o0.x)} ${round(o0.y)}`,
    `A ${round(outerRadius)} ${round(outerRadius)} 0 ${largeArc} 1 ${round(o1.x)} ${round(o1.y)}`,
    `L ${round(i1.x)} ${round(i1.y)}`,
    `A ${round(innerRadius)} ${round(innerRadius)} 0 ${largeArc} 0 ${round(i0.x)} ${round(i0.y)}`,
    'Z',
  ].join(' ');
}

/** Cartesian point at `angle` degrees clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, radius: number, angleDegrees: number): Point {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

/**
 * Nearest data index for a pointer position along the x axis — the crosshair's
 * "which day am I on" lookup.
 *
 * Takes a **fraction** of the plot width (0..1), not a pixel offset, because the
 * caller derives it from the pointer event's position within the element and
 * never measures the SVG. Returns `null` for an empty series.
 */
export function indexAtFraction(fraction: number, count: number): number | null {
  if (count <= 0) return null;
  if (!Number.isFinite(fraction)) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.min(count - 1, Math.floor(clamped * count));
}

/** Trim float noise out of path strings. Three decimals is well under a device
 *  pixel at any viewBox we use, and keeps the SSR HTML small. */
function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}
