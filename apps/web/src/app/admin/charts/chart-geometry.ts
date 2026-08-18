/**
 * AECI-576 / Phase 8.3 P1.2 — pure chart geometry for the operator console.
 *
 * `docs/ADMIN_PANEL_SPEC.md` §8 settles the approach: **hand-rolled SVG, no
 * charting dependency** (§13 D3). Two rules shape this file:
 *
 *   1. **SSR-safe.** Geometry is computed from data alone — no DOM measurement,
 *      no `window`, no post-hydration layout pass. Everything here is a pure
 *      function of `(values, box)`, so the server and the browser draw the same
 *      picture and hydration is a no-op.
 *   2. **Independently testable.** §11 makes chart geometry its own test
 *      category: scales, paths and ticks are asserted here (`chart-geometry.spec.ts`,
 *      plain Vitest) without rendering a component.
 *
 * Responsiveness comes from `viewBox` + `preserveAspectRatio` on the consuming
 * `<svg>`, never from a JS resize handler — so these functions work in an
 * arbitrary unitless coordinate space and the browser does the scaling.
 *
 * P1.4 (AECI-578) extends this folder with the rest of §8's vocabulary (line,
 * area, donut). The invariants above are the contract it inherits.
 */

/** A unitless drawing box. Consumers map it onto an SVG `viewBox`. */
export interface ChartBox {
  width: number;
  height: number;
}

/** SVG coordinates round to 2dp: shorter path strings, and stable assertions
 *  (floating-point tails are noise no test should have to encode). */
const PRECISION = 2;

function round(n: number): number {
  return Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;
}

/** Non-finite and negative inputs become 0. Counts are the only thing charted
 *  here and none of them can legitimately be negative, so a bad value is data
 *  corruption — clamping keeps it from producing NaN path commands that would
 *  silently blank the whole chart. */
function sanitize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Round a maximum up to a "nice" axis bound — 1, 2 or 5 × a power of ten. Keeps
 * the implied gridline values readable (100, not 97) without drawing an axis.
 *
 * Returns 1 for an all-zero or empty series so callers never divide by zero; a
 * flat-zero chart then renders as an empty baseline, which is the honest picture.
 */
export function niceMax(values: readonly number[]): number {
  const peak = Math.max(0, ...values.map(sanitize));
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface SparklineGeometry {
  /** `M…L…` polyline through every value. */
  path: string;
  /** The same line closed down to the baseline, for a faint area fill. */
  areaPath: string;
  /** The last point, so a consumer can mark "today" without recomputing. */
  last: SparklinePoint;
  points: readonly SparklinePoint[];
  /** The scale ceiling actually used (see {@link niceMax}). */
  max: number;
}

/**
 * Polyline geometry for a small trend line.
 *
 * - An **empty** series returns `null` — there is no honest line to draw, and the
 *   caller renders nothing rather than a misleading flat zero.
 * - A **single** value draws a flat line across the full width: one reading is a
 *   level, not a trend, and a lone dot reads as noise at sparkline size.
 * - An **all-zero** series draws along the baseline (`niceMax` → 1).
 */
export function sparklineGeometry(
  values: readonly number[],
  box: ChartBox,
): SparklineGeometry | null {
  if (values.length === 0) return null;

  const clean = values.map(sanitize);
  const max = niceMax(clean);
  // A single value has no horizontal span to divide across, so pin it to a flat
  // line: step 0 puts both synthesized points at x = 0 and x = width.
  const step = clean.length > 1 ? box.width / (clean.length - 1) : 0;

  const points: SparklinePoint[] =
    clean.length > 1
      ? clean.map((v, i) => ({
          x: round(i * step),
          y: round(box.height - (v / max) * box.height),
        }))
      : [
          { x: 0, y: round(box.height - (clean[0]! / max) * box.height) },
          { x: round(box.width), y: round(box.height - (clean[0]! / max) * box.height) },
        ];

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${path} L${round(box.width)},${round(box.height)} L0,${round(box.height)} Z`;

  return { path, areaPath, last: points[points.length - 1]!, points, max };
}

// ─── Stacked bars ────────────────────────────────────────────────────────────

/** One column: a label (the UTC day) and one value per stacked series. */
export interface StackedBarPoint {
  label: string;
  segments: readonly number[];
}

export interface StackedBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Index into the point's `segments` — the consumer maps it to a color token. */
  seriesIndex: number;
  pointIndex: number;
}

export interface StackedBarGeometry {
  rects: readonly StackedBarRect[];
  /** Scale ceiling, from the stacked column totals (not from any one series). */
  max: number;
  barWidth: number;
}

/**
 * Column geometry for a stacked bar chart, stacking series 0 at the BOTTOM.
 *
 * The scale is driven by each column's **total**, not by the tallest single
 * series, so a stacked column can never overflow the box. Zero-height segments
 * are dropped rather than emitted as `height: 0` rects: they render nothing but
 * would each cost a DOM node, and 30 days × 2 series of empty rects is exactly
 * the shape of a pre-launch window.
 *
 * `gap` is the fraction of a column's slot left as whitespace (0–0.9).
 */
export function stackedBarGeometry(
  points: readonly StackedBarPoint[],
  box: ChartBox,
  opts: { gap?: number } = {},
): StackedBarGeometry {
  if (points.length === 0) return { rects: [], max: 1, barWidth: 0 };

  const gap = Math.min(Math.max(opts.gap ?? 0.2, 0), 0.9);
  const slot = box.width / points.length;
  const barWidth = slot * (1 - gap);
  const totals = points.map((p) => p.segments.reduce((sum, v) => sum + sanitize(v), 0));
  const max = niceMax(totals);

  const rects: StackedBarRect[] = [];
  points.forEach((point, pointIndex) => {
    const x = pointIndex * slot + (slot - barWidth) / 2;
    // Stack upward from the baseline: series 0 sits on the floor.
    let bottom = box.height;
    point.segments.forEach((raw, seriesIndex) => {
      const value = sanitize(raw);
      if (value === 0) return;
      const height = (value / max) * box.height;
      bottom -= height;
      rects.push({
        x: round(x),
        y: round(bottom),
        width: round(barWidth),
        height: round(height),
        seriesIndex,
        pointIndex,
      });
    });
  });

  return { rects, max, barWidth: round(barWidth) };
}
