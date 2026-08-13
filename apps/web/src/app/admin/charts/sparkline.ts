import { Component, computed, input } from '@angular/core';

import { type ChartBox, sparklineGeometry } from './chart-geometry';

/** Unitless drawing space. The `<svg>` scales it via `viewBox` +
 *  `preserveAspectRatio`, so there is no JS resize handling anywhere (§8). */
const BOX: ChartBox = { width: 100, height: 24 };

/**
 * AECI-576 / Phase 8.3 P1.2 — a small trend line for a stat tile.
 *
 * §8 rules, all held here: hand-rolled SVG (no dependency), geometry from pure
 * functions (`chart-geometry.ts`) so it is SSR-safe, tokenized colors, light
 * theme only, responsive via `viewBox` rather than measurement.
 *
 * **Accessibility.** `role="img"` + a caller-supplied `aria-label`, and the
 * decorative internals are `aria-hidden`. The sparkline is never the only
 * representation of the number — the tile it sits in always renders the figure
 * itself, which is §8's "charts are never the only representation" rule. That is
 * also why there is no visually-hidden table here (unlike the 30-day chart, whose
 * per-day values appear nowhere else).
 *
 * An empty series renders **nothing**: a flat line through no data would imply a
 * measured zero.
 */
@Component({
  selector: 'aec-sparkline',
  template: `
    @let g = geometry();
    @if (g) {
      <svg
        [attr.viewBox]="viewBox"
        preserveAspectRatio="none"
        role="img"
        [attr.aria-label]="label()"
        class="h-6 w-full overflow-visible"
      >
        <path [attr.d]="g.areaPath" fill="var(--accent-primary-soft)" aria-hidden="true" />
        <path
          [attr.d]="g.path"
          fill="none"
          stroke="var(--accent-primary)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
          aria-hidden="true"
        />
        <circle
          [attr.cx]="g.last.x"
          [attr.cy]="g.last.y"
          r="1.5"
          fill="var(--accent-primary)"
          vector-effect="non-scaling-stroke"
          aria-hidden="true"
        />
      </svg>
    }
  `,
  styles: [':host { display: block; }'],
})
export class Sparkline {
  /** Oldest-first series. Empty renders nothing. */
  readonly values = input.required<readonly number[]>();
  /** Accessible name — the caller owns it because only the caller knows the
   *  metric and window ("Human page views, last 30 days"). */
  readonly label = input.required<string>();

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;
  protected readonly geometry = computed(() => sparklineGeometry(this.values(), BOX));
}
