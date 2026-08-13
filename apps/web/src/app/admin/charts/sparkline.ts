import { Component, computed, input } from '@angular/core';

import { areaPath, bandScale, linePath, linearScale, plotArea, valueDomain } from './geometry';
import { slotClass } from './chart-types';
import type { ChartSlot } from './chart-types';

/** Fixed user-unit coordinate space. Rendered size comes from `viewBox` scaling,
 *  never from measurement — §8's "responsive via viewBox, not JS resize". */
const BOX = { width: 160, height: 40, padding: { top: 4, right: 2, bottom: 4, left: 2 } };

/**
 * Sparkline — AECI-578 / Phase 8.3 P1.4. The trend line inside a stat tile
 * (`docs/ADMIN_PANEL_SPEC.md` §8, and the `dataviz` stat-tile contract:
 * label · value · delta · sparkline).
 *
 * No axes, no gridlines, no legend, no tooltip. A sparkline's whole job is the
 * shape of the trend; the number it belongs to is an inch away in the same tile
 * and the exact series is in the tile's data table.
 *
 * ─── Why this one is `aria-hidden` and the others are not ────────────────────
 *
 * A sparkline is the one chart here that is genuinely **redundant**: it never
 * carries a number that is not already stated beside it. Announcing "chart: human
 * page views over 30 days" immediately after the tile has already said "human
 * page views, 1,284, up 12%" is noise, not access. So the SVG is `aria-hidden`
 * and the tile — not the sparkline — owns the data table for the series. That is
 * a deliberate, local exception to §8's "each chart is `role="img"`", and it is
 * the exception the rule is *for*: charts are never the only representation of a
 * number, which here is satisfied by the tile.
 */
@Component({
  selector: 'aec-sparkline',
  template: `
    <svg
      [attr.viewBox]="viewBox"
      preserveAspectRatio="xMidYMid meet"
      class="block h-auto w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      @if (area()) {
        <path [attr.d]="area()" [class]="fillClass()" opacity="0.1" />
      }
      @if (line()) {
        <path
          [attr.d]="line()"
          [class]="strokeClass()"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      }
      @if (endPoint(); as end) {
        <circle
          [attr.cx]="end.x"
          [attr.cy]="end.y"
          r="4"
          [class]="fillClass()"
          stroke="var(--chart-surface)"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
      }
    </svg>
  `,
  styles: [':host { display: block; }'],
})
export class Sparkline {
  readonly values = input.required<readonly number[]>();
  readonly slot = input<ChartSlot>(1);

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;

  private readonly points = computed(() => {
    const values = this.values();
    const plot = plotArea(BOX);
    const domain = valueDomain(values);
    const y = linearScale(domain, plot.y + plot.height, plot.y);
    const bands = bandScale(values.length, plot.x, plot.width);
    return values.map((v, i) => ({ x: bands[i]!.center, y: y(v) }));
  });

  protected readonly line = computed(() => linePath(this.points()));

  protected readonly area = computed(() => {
    const pts = this.points();
    // A single point has no area to fill — `areaPath` would emit a zero-width
    // sliver that reads as a stray tick mark next to the end dot.
    return pts.length > 1 ? areaPath(pts, plotArea(BOX).y + plotArea(BOX).height) : '';
  });

  /** The end marker — "where the trend got to", the one point worth marking. */
  protected readonly endPoint = computed(() => {
    const pts = this.points();
    return pts.length > 0 ? pts[pts.length - 1]! : null;
  });

  protected readonly fillClass = computed(() => slotClass(this.slot(), 'fill'));
  protected readonly strokeClass = computed(() => slotClass(this.slot(), 'stroke'));
}
