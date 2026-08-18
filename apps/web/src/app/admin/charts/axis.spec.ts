/**
 * AECI-587 / Phase 8.3 §12 closeout — `axis.ts` as pure functions, no rendering
 * (`docs/ADMIN_PANEL_SPEC.md` §11).
 *
 * §11 names "scales, paths, **ticks**, empty and single-point series" as the
 * chart-geometry test surface. `geometry.spec.ts` and `format.spec.ts` cover the
 * primitives; `buildTimeAxis` is the composition both time-series charts actually
 * render from, and it was the one pure module with no spec of its own.
 *
 * Runs in the **plain Vitest runner** (`apps/web/vitest.config.ts`, node
 * environment), not `ng test`, because `axis.ts` imports nothing from Angular.
 * If a future change adds an Angular import there, this file stops running
 * silently — the import discipline is the load-bearing part (§8.1).
 *
 * The two properties worth guarding here are the ones a primitive spec cannot
 * see, because they only exist once the primitives are composed: the stacked
 * y-domain must accommodate the per-index TOTAL, and every SVG coordinate must
 * have a matching percentage for the HTML label overlay.
 */
import { describe, expect, it } from 'vitest';

import { buildTimeAxis, type TimeAxisOptions } from './axis';
import type { ChartBox } from './geometry';

const BOX: ChartBox = {
  width: 600,
  height: 200,
  padding: { top: 8, right: 8, bottom: 24, left: 40 },
};

/** `buildTimeAxis` with the two required-but-uninteresting fields defaulted. */
function axis(overrides: Partial<TimeAxisOptions> = {}) {
  return buildTimeAxis({
    box: BOX,
    count: 7,
    series: [[1, 2, 3, 4, 5, 6, 7]],
    stacked: false,
    ...overrides,
  });
}

describe('buildTimeAxis — plot and domain', () => {
  it('lays the plot out inside the box padding', () => {
    expect(axis().plot).toEqual({ x: 40, y: 8, width: 552, height: 168 });
  });

  it('anchors the value domain at zero and takes the max', () => {
    expect(axis({ series: [[3, 17, 9]], count: 3 }).domain).toEqual({ min: 0, max: 17 });
  });

  it('takes the max ACROSS series when overlaid', () => {
    const overlaid = axis({
      series: [
        [1, 2, 3],
        [9, 4, 2],
      ],
      count: 3,
      stacked: false,
    });
    expect(overlaid.domain.max).toBe(9);
  });

  it('takes the per-index TOTAL when stacked, not the tallest single series', () => {
    // The classic stacked-chart bug: a domain built from the tallest series (9)
    // instead of the tallest column (1+9=10 at index 0) clips the top segment
    // above its own axis. Guard the sum, not the max.
    const stacked = axis({
      series: [
        [1, 2, 3],
        [9, 4, 2],
      ],
      count: 3,
      stacked: true,
    });
    expect(stacked.domain.max).toBe(10);
  });
});

describe('buildTimeAxis — ticks', () => {
  it('places ticks at round values, top tick at or above the max', () => {
    const { ticks } = axis({ series: [[0, 437, 874]], count: 3 });
    expect(ticks.map((t) => t.value)).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it('maps each tick to a descending y — larger value, smaller SVG y', () => {
    const { ticks, plot } = axis({ series: [[0, 100]], count: 2 });
    const ys = ticks.map((t) => t.y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    // The zero tick sits on the plot floor; the top tick on its ceiling.
    expect(ticks[0]!.y).toBeCloseTo(plot.y + plot.height);
    expect(ticks.at(-1)!.y).toBeCloseTo(plot.y);
  });

  it('honours targetTicks', () => {
    const sparse = axis({ series: [[0, 100]], count: 2, targetTicks: 2 });
    const dense = axis({ series: [[0, 100]], count: 2, targetTicks: 10 });
    expect(dense.ticks.length).toBeGreaterThan(sparse.ticks.length);
  });
});

describe('buildTimeAxis — label thinning', () => {
  it('labels every slot when the count fits under maxLabels', () => {
    expect(axis({ count: 5, series: [[1, 2, 3, 4, 5]] }).labelled.map((l) => l.index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('thins a 90-day window and always ends on the last index', () => {
    const { labelled } = axis({ count: 90, series: [Array.from({ length: 90 }, (_, i) => i)] });
    // `maxLabels` is a target, not a hard cap: the stride lands on 78, and the
    // always-label-the-last rule appends 89 rather than dropping it, because the
    // gap (11) is more than half a stride. So 7 can become 8 — by design. What
    // must hold is that both ends are labelled and the stride is even.
    expect(labelled.length).toBeLessThanOrEqual(8);
    expect(labelled[0]!.index).toBe(0);
    expect(labelled.at(-1)!.index).toBe(89);
    expect(labelled.map((l) => l.index)).toEqual([0, 13, 26, 39, 52, 65, 78, 89]);
  });

  it('positions each label at its band centre', () => {
    const { labelled, bands } = axis({ count: 3, series: [[1, 2, 3]] });
    for (const label of labelled) expect(label.x).toBeCloseTo(bands[label.index]!.center);
  });
});

describe('buildTimeAxis — the HTML overlay percentages (§8.1)', () => {
  // Labels render as HTML positioned over the SVG, so every user-unit coordinate
  // needs a percentage twin. A `pct` that disagrees with its coordinate puts the
  // label somewhere the mark is not — and it only shows up at some widths.
  it('derives tick pct from y over the box height', () => {
    const { ticks } = axis();
    for (const tick of ticks) expect(tick.pct).toBeCloseTo((tick.y / BOX.height) * 100);
  });

  it('derives category pct from x over the box width', () => {
    const { labelled } = axis();
    for (const label of labelled) expect(label.pct).toBeCloseTo((label.x / BOX.width) * 100);
  });

  it('returns 0 rather than NaN or Infinity when the box has no extent', () => {
    const flat = axis({ box: { width: 0, height: 0, padding: BOX.padding } });
    for (const tick of flat.ticks) expect(tick.pct).toBe(0);
    for (const label of flat.labelled) expect(label.pct).toBe(0);
  });
});

describe('awkward series (ADMIN_PANEL_SPEC §11)', () => {
  it('empty — flags isEmpty and emits no bands or labels', () => {
    const empty = axis({ count: 0, series: [] });
    expect(empty.isEmpty).toBe(true);
    expect(empty.bands).toEqual([]);
    expect(empty.labelled).toEqual([]);
  });

  it('single point — one band, one label, still not empty', () => {
    const single = axis({ count: 1, series: [[42]] });
    expect(single.isEmpty).toBe(false);
    expect(single.bands).toHaveLength(1);
    expect(single.labelled.map((l) => l.index)).toEqual([0]);
    expect(single.domain).toEqual({ min: 0, max: 42 });
  });

  it('all zero — falls back to a unit domain rather than a zero-height one', () => {
    // A zero-height domain makes every `(v - min) / (max - min)` a 0/0 → NaN,
    // and the browser silently drops an SVG path containing NaN. The unit
    // fallback renders a correct empty-looking plot instead.
    const zeroed = axis({ count: 3, series: [[0, 0, 0]] });
    expect(zeroed.domain).toEqual({ min: 0, max: 1 });
    expect(zeroed.ticks.length).toBeGreaterThan(1);
    for (const tick of zeroed.ticks) {
      expect(Number.isFinite(tick.y)).toBe(true);
      expect(Number.isFinite(tick.pct)).toBe(true);
    }
    expect(zeroed.isEmpty).toBe(false); // three days of zero traffic IS data
  });

  it('dominant outlier — the domain follows the outlier, small values stay finite', () => {
    const spiky = axis({ count: 4, series: [[1, 1, 1, 9000]] });
    expect(spiky.domain.max).toBeGreaterThanOrEqual(9000);
    expect(Number.isFinite(spiky.y(1))).toBe(true);
    expect(spiky.y(1)).toBeGreaterThan(spiky.y(9000)); // 1 sits below 9000 on screen
  });

  it('a count with no matching series still produces bands (zero-fill case)', () => {
    // The snapshot zero-fills days with no data, so a 30-day window can carry
    // fewer value entries than slots. Bands must still exist or the axis renders
    // narrower than its window.
    const gappy = axis({ count: 30, series: [[5, 3]] });
    expect(gappy.bands).toHaveLength(30);
    expect(gappy.labelled.at(-1)!.index).toBe(29);
  });
});
