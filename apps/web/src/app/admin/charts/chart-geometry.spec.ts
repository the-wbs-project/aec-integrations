/**
 * AECI-576 / Phase 8.3 P1.2 — chart geometry.
 *
 * `docs/ADMIN_PANEL_SPEC.md` §11 makes this its own test category: "chart geometry
 * — pure-function unit tests (scales, paths, ticks, empty and single-point series)
 * with **no rendering**". Plain Vitest, no TestBed, no DOM — which is only possible
 * because §8 requires the geometry to be a pure function of `(values, box)` in the
 * first place. If a future chart needs a spec to mount a component to test its
 * maths, that maths is in the wrong place.
 */
import { describe, expect, it } from 'vitest';

import { type ChartBox, niceMax, sparklineGeometry, stackedBarGeometry } from './chart-geometry';

const BOX: ChartBox = { width: 100, height: 20 };

describe('niceMax', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceMax([7])).toBe(10);
    expect(niceMax([12])).toBe(20);
    expect(niceMax([37])).toBe(50);
    expect(niceMax([64])).toBe(100);
    expect(niceMax([100])).toBe(100);
    expect(niceMax([1400])).toBe(2000);
  });

  it('returns 1 for empty and all-zero series so nothing divides by zero', () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  it('clamps negative and non-finite values to zero rather than propagating NaN', () => {
    expect(niceMax([-5, Number.NaN, 3])).toBe(5);
    expect(niceMax([Number.POSITIVE_INFINITY])).toBe(1);
  });
});

describe('sparklineGeometry', () => {
  it('returns null for an empty series — there is no honest line to draw', () => {
    expect(sparklineGeometry([], BOX)).toBeNull();
  });

  it('draws a flat line across the full width for a single value', () => {
    const g = sparklineGeometry([5], BOX)!;
    expect(g.points).toHaveLength(2);
    expect(g.points[0]!.x).toBe(0);
    expect(g.points[1]!.x).toBe(BOX.width);
    expect(g.points[0]!.y).toBe(g.points[1]!.y);
  });

  it('spreads points evenly and inverts the y axis (SVG y grows downward)', () => {
    const g = sparklineGeometry([0, 5, 10], BOX)!;
    expect(g.max).toBe(10);
    expect(g.points.map((p) => p.x)).toEqual([0, 50, 100]);
    // 0 sits on the baseline (y = height), the peak at the top (y = 0).
    expect(g.points.map((p) => p.y)).toEqual([20, 10, 0]);
    expect(g.path).toBe('M0,20 L50,10 L100,0');
  });

  it('reports the last point so a consumer can mark the latest reading', () => {
    const g = sparklineGeometry([1, 2, 8], BOX)!;
    expect(g.last).toEqual(g.points[g.points.length - 1]);
  });

  it('draws an all-zero series along the baseline', () => {
    const g = sparklineGeometry([0, 0, 0], BOX)!;
    expect(g.points.every((p) => p.y === BOX.height)).toBe(true);
  });

  it('closes the area path down to the baseline', () => {
    const g = sparklineGeometry([10, 10], BOX)!;
    expect(g.areaPath.startsWith(g.path)).toBe(true);
    expect(g.areaPath.endsWith('L100,20 L0,20 Z')).toBe(true);
  });

  it('produces no NaN coordinates from corrupt input', () => {
    const g = sparklineGeometry([Number.NaN, -3, 4], BOX)!;
    expect(g.path).not.toContain('NaN');
  });
});

describe('stackedBarGeometry', () => {
  const box: ChartBox = { width: 100, height: 100 };

  it('returns nothing for an empty series', () => {
    expect(stackedBarGeometry([], box)).toEqual({ rects: [], max: 1, barWidth: 0 });
  });

  it('scales against the column TOTAL, so a stack can never overflow the box', () => {
    const g = stackedBarGeometry([{ label: 'd1', segments: [60, 40] }], box);
    expect(g.max).toBe(100);
    const total = g.rects.reduce((sum, r) => sum + r.height, 0);
    expect(total).toBeCloseTo(box.height, 5);
    expect(Math.min(...g.rects.map((r) => r.y))).toBeGreaterThanOrEqual(0);
  });

  it('stacks series 0 at the bottom', () => {
    const [first, second] = stackedBarGeometry([{ label: 'd1', segments: [50, 50] }], box).rects;
    expect(first!.seriesIndex).toBe(0);
    // Larger y is lower on screen.
    expect(first!.y).toBeGreaterThan(second!.y);
    expect(first!.y + first!.height).toBe(box.height);
  });

  it('drops zero-height segments instead of emitting empty rects', () => {
    const g = stackedBarGeometry(
      [
        { label: 'd1', segments: [5, 0] },
        { label: 'd2', segments: [0, 0] },
      ],
      box,
    );
    expect(g.rects).toHaveLength(1);
    expect(g.rects[0]).toMatchObject({ pointIndex: 0, seriesIndex: 0 });
  });

  it('lays columns out in slots with a gap, in order', () => {
    const g = stackedBarGeometry(
      [
        { label: 'd1', segments: [1] },
        { label: 'd2', segments: [1] },
      ],
      box,
      { gap: 0.2 },
    );
    expect(g.barWidth).toBe(40);
    expect(g.rects.map((r) => r.pointIndex)).toEqual([0, 1]);
    expect(g.rects[0]!.x).toBeLessThan(g.rects[1]!.x);
  });

  it('clamps the gap to a drawable range', () => {
    expect(stackedBarGeometry([{ label: 'd', segments: [1] }], box, { gap: 5 }).barWidth).toBe(10);
    expect(stackedBarGeometry([{ label: 'd', segments: [1] }], box, { gap: -1 }).barWidth).toBe(
      100,
    );
  });

  it('renders no bars for an all-zero window rather than a full-height block', () => {
    const g = stackedBarGeometry(
      [
        { label: 'd1', segments: [0, 0] },
        { label: 'd2', segments: [0, 0] },
      ],
      box,
    );
    expect(g.rects).toHaveLength(0);
    expect(g.max).toBe(1);
  });
});
