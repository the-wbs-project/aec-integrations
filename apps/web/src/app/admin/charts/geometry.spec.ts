/**
 * AECI-578 / Phase 8.3 P1.4 — chart geometry, tested as pure functions with no
 * rendering involved (`docs/ADMIN_PANEL_SPEC.md` §11).
 *
 * Runs in the **plain Vitest runner** (`apps/web/vitest.config.ts`, node
 * environment), not `ng test`, because `geometry.ts` imports nothing from
 * Angular. If a future change adds an Angular import there, this file stops
 * running silently — the import discipline is the load-bearing part.
 *
 * The four cases §11 names — empty, single-point, all-zero, dominant outlier —
 * each get their own describe block, because each has bitten a chart somewhere.
 */
import { describe, expect, it } from 'vitest';

import {
  arcPath,
  areaPath,
  bandScale,
  barPath,
  donutSegments,
  indexAtFraction,
  linePath,
  linearScale,
  niceTicks,
  plotArea,
  polar,
  stackSeries,
  stackTotals,
  valueDomain,
  type ChartBox,
} from './geometry';

const BOX: ChartBox = {
  width: 600,
  height: 200,
  padding: { top: 8, right: 8, bottom: 24, left: 40 },
};

describe('plotArea', () => {
  it('subtracts padding from the box', () => {
    expect(plotArea(BOX)).toEqual({ x: 40, y: 8, width: 552, height: 168 });
  });

  it('never returns a negative dimension when padding exceeds the box', () => {
    const cramped = plotArea({ width: 10, height: 10, padding: BOX.padding });
    expect(cramped.width).toBe(0);
    expect(cramped.height).toBe(0);
  });
});

describe('valueDomain', () => {
  it('anchors at zero and takes the max', () => {
    expect(valueDomain([3, 17, 9])).toEqual({ min: 0, max: 17 });
  });

  it('ignores non-finite values rather than propagating NaN', () => {
    expect(valueDomain([5, NaN, Infinity, 2])).toEqual({ min: 0, max: 5 });
  });

  it('never lets a bar baseline float above zero', () => {
    // A domain of [900, 1000] would make a 5% difference look like 100%.
    expect(valueDomain([900, 950, 1000]).min).toBe(0);
  });
});

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale({ min: 0, max: 100 }, 176, 8); // y axis: inverted
    expect(scale(0)).toBe(176);
    expect(scale(100)).toBe(8);
    expect(scale(50)).toBe(92);
  });

  it('returns the range start rather than NaN for a zero-span domain', () => {
    const scale = linearScale({ min: 5, max: 5 }, 100, 0);
    expect(scale(5)).toBe(100);
    expect(Number.isNaN(scale(5))).toBe(false);
  });

  it('returns the range start for a non-finite value', () => {
    const scale = linearScale({ min: 0, max: 10 }, 100, 0);
    expect(scale(NaN)).toBe(100);
  });
});

describe('bandScale', () => {
  it('splits a span into evenly spaced centred slots', () => {
    const bands = bandScale(4, 0, 400);
    expect(bands.map((b) => b.center)).toEqual([50, 150, 250, 350]);
    expect(bands.every((b) => b.width === 100)).toBe(true);
  });

  it('subtracts the surface gap from the mark, not from the slot spacing', () => {
    const bands = bandScale(4, 0, 400, 2);
    // Centres are unchanged — the gap is white space inside the slot.
    expect(bands.map((b) => b.center)).toEqual([50, 150, 250, 350]);
    expect(bands[0]!.width).toBe(98);
  });

  it('clamps the gap so a thin slot never inverts to a negative width', () => {
    // 90 days across 300 units: a 2px gap is a large fraction of a 3.33 slot.
    const bands = bandScale(90, 0, 300, 8);
    expect(bands.every((b) => b.width > 0)).toBe(true);
  });

  it('returns no bands for an empty series', () => {
    expect(bandScale(0, 0, 400)).toEqual([]);
  });

  it('centres a single point instead of pinning it to the left edge', () => {
    const [only] = bandScale(1, 0, 400);
    expect(only!.center).toBe(200);
    expect(only!.width).toBe(400);
  });
});

describe('niceTicks', () => {
  it('produces round numbers off the 1-2-5 ladder', () => {
    expect(niceTicks({ min: 0, max: 1000 }, 4)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(niceTicks({ min: 0, max: 87 }, 4)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks({ min: 0, max: 24_119 }, 4)).toEqual([
      0, 5000, 10_000, 15_000, 20_000, 25_000,
    ]);
  });

  it('picks the nearer rung of the ladder, not the next one up', () => {
    // The naive `<= 2 ? 2 : <= 5 ? 5` comparison rounds this 2.5 up to 5 and
    // yields 0/500/1000 — half the ticks, and unreadable between them.
    expect(niceTicks({ min: 0, max: 1000 }, 4).length).toBeGreaterThan(3);
  });

  it('always covers the domain max so no mark escapes the plot area', () => {
    for (const max of [7, 13, 99, 137, 1284, 24_119]) {
      const ticks = niceTicks({ min: 0, max });
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });

  it('does not accumulate float drift across ticks', () => {
    for (const tick of niceTicks({ min: 0, max: 1 }, 5)) {
      expect(String(tick).length).toBeLessThan(8);
    }
  });

  it('returns a single tick for a zero-span domain', () => {
    expect(niceTicks({ min: 0, max: 0 })).toEqual([0]);
  });
});

describe('linePath', () => {
  it('emits a move-to followed by line-tos', () => {
    const d = linePath([
      { x: 0, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 5 },
    ]);
    expect(d).toBe('M 0 10 L 10 20 L 20 5');
  });

  it('emits a drawable segment for a single point, not a bare move-to', () => {
    // `M 10 20` alone renders nothing at all — a one-day window would look broken.
    const d = linePath([{ x: 10, y: 20 }]);
    expect(d).toContain('L');
    expect(d).toBe('M 9.5 20 L 10.5 20');
  });

  it('returns an empty string for an empty series', () => {
    expect(linePath([])).toBe('');
  });

  it('rounds coordinates so the SSR HTML stays small', () => {
    expect(
      linePath([
        { x: 1.23456789, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toContain('1.235');
  });
});

describe('areaPath', () => {
  it('closes the line down to the baseline', () => {
    const d = areaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 20 },
      ],
      100,
    );
    expect(d).toBe('M 0 100 L 0 10 L 10 20 L 10 100 Z');
  });

  it('returns an empty string for an empty series', () => {
    expect(areaPath([], 100)).toBe('');
  });
});

describe('stackSeries', () => {
  it('accumulates each series on top of the previous', () => {
    const stacked = stackSeries([
      [1, 2],
      [3, 4],
    ]);
    expect(stacked[0]).toEqual([
      { base: 0, top: 1, value: 1 },
      { base: 0, top: 2, value: 2 },
    ]);
    expect(stacked[1]).toEqual([
      { base: 1, top: 4, value: 3 },
      { base: 2, top: 6, value: 4 },
    ]);
  });

  it('treats a short or ragged series as zero past its end', () => {
    const stacked = stackSeries([[1, 2, 3], [5]]);
    expect(stacked[1]).toEqual([
      { base: 1, top: 6, value: 5 },
      { base: 2, top: 2, value: 0 },
      { base: 3, top: 3, value: 0 },
    ]);
  });

  it('treats a non-finite entry as zero rather than poisoning the stack', () => {
    const stacked = stackSeries([[NaN, 2]]);
    expect(stacked[0]![0]).toEqual({ base: 0, top: 0, value: 0 });
  });

  it('handles an empty input', () => {
    expect(stackSeries([])).toEqual([]);
  });
});

describe('stackTotals', () => {
  it('sums each index across every series — the y-domain input', () => {
    expect(
      stackTotals([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([4, 6]);
  });
});

describe('barPath', () => {
  it('rounds the data end and leaves the baseline square (vertical)', () => {
    const d = barPath({ x: 0, y: 50, width: 20, height: 50 }, 4, 'vertical');
    // Two arcs at the top (the data end), plain corners at the bottom.
    expect(d.match(/A /g)).toHaveLength(2);
    expect(d.startsWith('M 0 100')).toBe(true);
  });

  it('rounds the right end for a horizontal bar', () => {
    const d = barPath({ x: 0, y: 0, width: 100, height: 20 }, 4, 'horizontal');
    expect(d.match(/A /g)).toHaveLength(2);
    expect(d.startsWith('M 0 0')).toBe(true);
  });

  it('degrades to a plain rect when the bar is shorter than the radius', () => {
    const d = barPath({ x: 0, y: 0, width: 100, height: 20 }, 0, 'horizontal');
    expect(d).not.toContain('A ');
  });

  it('returns an empty string for a zero-size bar (the all-zero series)', () => {
    expect(barPath({ x: 0, y: 0, width: 0, height: 20 }, 4, 'horizontal')).toBe('');
    expect(barPath({ x: 0, y: 0, width: 100, height: 0 }, 4, 'horizontal')).toBe('');
  });
});

describe('polar', () => {
  it('places 0 degrees at 12 o’clock and runs clockwise', () => {
    const top = polar(100, 100, 50, 0);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(50);
    const right = polar(100, 100, 50, 90);
    expect(right.x).toBeCloseTo(150);
    expect(right.y).toBeCloseTo(100);
  });
});

describe('arcPath', () => {
  it('returns an empty string for a non-positive sweep', () => {
    expect(arcPath(0, 0, 50, 30, 90, 90)).toBe('');
    expect(arcPath(0, 0, 50, 30, 90, 45)).toBe('');
  });

  it('sets the large-arc flag past 180 degrees', () => {
    expect(arcPath(0, 0, 50, 30, 0, 200)).toContain('0 1 1');
    expect(arcPath(0, 0, 50, 30, 0, 90)).toContain('0 0 1');
  });

  it('draws a full ring as two half-arcs so 100% is not a silent no-op', () => {
    // A single arc whose start and end coincide draws nothing in SVG.
    const d = arcPath(100, 100, 50, 30, 0, 360);
    expect(d.match(/A /g)).toHaveLength(4);
  });
});

describe('donutSegments', () => {
  const opts = { cx: 100, cy: 100, outerRadius: 50, innerRadius: 30 };

  it('computes shares and consecutive angles', () => {
    const segments = donutSegments([50, 25, 25], opts);
    expect(segments.map((s) => s.share)).toEqual([0.5, 0.25, 0.25]);
    expect(segments[0]!.startAngle).toBe(0);
    expect(segments[0]!.endAngle).toBe(180);
    expect(segments[1]!.startAngle).toBe(180);
    expect(segments[2]!.endAngle).toBe(360);
  });

  it('keeps the original index so colour follows the entity, not the sort order', () => {
    const segments = donutSegments([0, 10, 5], opts);
    expect(segments.map((s) => s.index)).toEqual([1, 2]);
  });

  it('drops zero-valued entries instead of emitting a hairline seam', () => {
    expect(donutSegments([10, 0, 5], opts)).toHaveLength(2);
  });

  it('returns nothing for an empty or all-zero series', () => {
    expect(donutSegments([], opts)).toEqual([]);
    expect(donutSegments([0, 0, 0], opts)).toEqual([]);
  });

  it('omits the surface gap for a lone slice so 100% closes into a full ring', () => {
    const [only] = donutSegments([42], opts);
    expect(only!.share).toBe(1);
    // A gap would leave a visible notch in a value that is genuinely everything.
    expect(only!.path.match(/A /g)).toHaveLength(4);
  });

  it('survives a single dominant outlier without distorting the small slices', () => {
    const segments = donutSegments([9800, 100, 100], opts);
    expect(segments[0]!.share).toBeCloseTo(0.98);
    expect(segments.every((s) => s.path.length > 0)).toBe(true);
  });
});

describe('indexAtFraction', () => {
  it('maps a pointer fraction onto a bucket index', () => {
    expect(indexAtFraction(0, 30)).toBe(0);
    expect(indexAtFraction(0.5, 30)).toBe(15);
    expect(indexAtFraction(1, 30)).toBe(29);
  });

  it('clamps out-of-range fractions rather than returning an out-of-bounds index', () => {
    expect(indexAtFraction(-2, 10)).toBe(0);
    expect(indexAtFraction(4, 10)).toBe(9);
  });

  it('returns null for an empty series or a non-finite fraction', () => {
    expect(indexAtFraction(0.5, 0)).toBeNull();
    expect(indexAtFraction(NaN, 10)).toBeNull();
  });
});

// ─── The four cases §11 names, end to end ──────────────────────────────────────

describe('awkward series (ADMIN_PANEL_SPEC §11)', () => {
  const area = plotArea(BOX);

  function render(values: number[]) {
    const domain = valueDomain(values);
    const y = linearScale(domain, area.y + area.height, area.y);
    const bands = bandScale(values.length, area.x, area.width);
    const points = values.map((v, i) => ({ x: bands[i]!.center, y: y(v) }));
    return { domain, points, d: linePath(points), ticks: niceTicks(domain) };
  }

  it('empty series: no marks, no NaN, a usable unit domain', () => {
    const out = render([]);
    expect(out.d).toBe('');
    expect(out.domain).toEqual({ min: 0, max: 1 });
    expect(out.ticks.every(Number.isFinite)).toBe(true);
  });

  it('single-point series: one visible mark at the centre of the plot', () => {
    const out = render([42]);
    expect(out.points[0]!.x).toBeCloseTo(area.x + area.width / 2);
    expect(out.d).toContain('L');
  });

  it('all-zero series: marks sit on the baseline, nothing is NaN', () => {
    const out = render([0, 0, 0]);
    expect(out.domain).toEqual({ min: 0, max: 1 });
    expect(out.points.every((p) => p.y === area.y + area.height)).toBe(true);
    expect(out.d).not.toContain('NaN');
  });

  it('single dominant outlier: small values stay small and nothing is clipped', () => {
    const out = render([1, 1, 5000, 2]);
    expect(out.domain.max).toBe(5000);
    // Every point stays inside the plot area — no clipping, no auto-log rescale.
    for (const p of out.points) {
      expect(p.y).toBeGreaterThanOrEqual(area.y);
      expect(p.y).toBeLessThanOrEqual(area.y + area.height);
    }
    // The three small values compress against the baseline. That is the truth
    // about the data, and the chart must not "fix" it.
    expect(out.points[0]!.y).toBeGreaterThan(area.y + area.height * 0.9);
  });
});
