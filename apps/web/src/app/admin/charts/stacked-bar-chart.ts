import { Component, computed, input } from '@angular/core';

import { type ChartBox, type StackedBarPoint, stackedBarGeometry } from './chart-geometry';

/** Unitless drawing space, scaled by `viewBox`. `preserveAspectRatio="none"` is
 *  deliberate: stretching rectangles horizontally distorts nothing a reader
 *  measures, and it lets the chart fill any column width without JS (§8). */
const BOX: ChartBox = { width: 300, height: 80 };

/**
 * Fill per stacked series, by index. Forest first (the primary population),
 * Clay-deep second — they differ in **hue and lightness**, so the two series stay
 * distinguishable without relying on color perception alone, and both clear the
 * 3:1 non-text contrast floor on `--surface-base` / `--surface-raised`. The
 * visually-hidden table carries the same numbers regardless.
 */
const SERIES_FILLS = ['var(--accent-primary)', 'var(--accent-secondary-deep)'] as const;

/** Per-instance suffix for the hatch pattern id, so two charts on one page never
 *  resolve each other's `url(#…)`. A counter, not a random value: SSR and the
 *  client construct components in the same order, so the ids agree on hydration. */
let nextChartId = 0;

/**
 * AECI-576 / Phase 8.3 P1.2 — a stacked bar chart, built for the Overview's
 * 30-day human-vs-bot traffic series.
 *
 * §8 rules: hand-rolled SVG (no charting dependency), pure geometry from
 * `chart-geometry.ts` so it is SSR-safe, tokenized colors, light theme only,
 * responsive via `viewBox`.
 *
 * **Accessibility.** `role="img"` with a descriptive `aria-label`, PLUS a
 * visually-hidden `<table>` carrying the same series — §8 is explicit that a chart
 * is never the only representation of a number, and unlike a sparkline these
 * per-day values appear nowhere else on the page. A visible legend names each
 * series so the fills are never the only encoding.
 *
 * An empty series renders nothing but the empty-state message the caller passes;
 * the geometry function returns no rects, and no axis is drawn for data that
 * does not exist.
 */
@Component({
  selector: 'aec-stacked-bar-chart',
  template: `
    @let g = geometry();

    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <!-- Legend: the fills are never the only encoding of which series is which. -->
      <ul role="list" class="flex flex-wrap gap-x-4 gap-y-1">
        @for (s of seriesLabels(); track s; let i = $index) {
          <li class="flex items-center gap-1.5 text-xs text-(--text-secondary)">
            <span
              class="inline-block size-2.5 shrink-0 rounded-[2px]"
              [style.background-color]="fillFor(i)"
              aria-hidden="true"
            ></span>
            {{ s }}
          </li>
        }
        <!-- Only when a day is marked: a legend entry for a mark that is not on
             the chart is noise. The swatch repeats the bars' hatch in CSS. -->
        @if (anyDegraded() && degradedLabel()) {
          <li class="flex items-center gap-1.5 text-xs text-(--text-secondary)">
            <span
              class="inline-block size-2.5 shrink-0 rounded-[2px] border border-(--text-secondary)"
              style="
                background-image: repeating-linear-gradient(
                  45deg,
                  var(--text-secondary) 0 1px,
                  transparent 1px 3px
                );
              "
              aria-hidden="true"
            ></span>
            {{ degradedLabel() }}
          </li>
        }
      </ul>
      <!-- The bars have no axis, so without this they carry no magnitude at all:
           a full-height column could be 9 or 9,000. This is the scale ceiling
           (niceMax), not the observed peak. -->
      @if (g.rects.length > 0) {
        <span class="text-xs tabular-nums text-(--text-secondary)">{{ scaleLabel() }}</span>
      }
    </div>

    @if (g.rects.length > 0) {
      <svg
        [attr.viewBox]="viewBox"
        preserveAspectRatio="none"
        role="img"
        [attr.aria-label]="label()"
        class="h-32 w-full border-t border-dashed border-(--border-default)"
      >
        @if (anyDegraded()) {
          <defs>
            <pattern
              [attr.id]="hatchId"
              patternUnits="userSpaceOnUse"
              width="3"
              height="3"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="3" stroke="var(--text-primary)" stroke-width="1" />
            </pattern>
          </defs>
        }
        @for (r of g.rects; track r.pointIndex + ':' + r.seriesIndex) {
          <rect
            [attr.x]="r.x"
            [attr.y]="r.y"
            [attr.width]="r.width"
            [attr.height]="r.height"
            [attr.fill]="fillFor(r.seriesIndex)"
            [attr.fill-opacity]="isDegraded(r.pointIndex) ? 0.4 : null"
            aria-hidden="true"
          />
        }
        <!-- The hatch sits over the whole column, not per segment: the day is
             degraded, not one of its series. Opacity plus texture, so the mark
             survives a monochrome print and does not rest on colour alone. -->
        @for (h of hatches(); track h.pointIndex) {
          <rect
            data-degraded-day
            [attr.x]="h.x"
            [attr.y]="h.y"
            [attr.width]="h.width"
            [attr.height]="h.height"
            [attr.fill]="'url(#' + hatchId + ')'"
            fill-opacity="0.55"
            aria-hidden="true"
          />
        }
      </svg>

      <!-- Endpoints only: 30 in-SVG day labels would be unreadable, and the
           hidden table below carries every day for anyone who needs them. -->
      <div class="mt-2 flex justify-between text-xs text-(--text-secondary)">
        <span>{{ firstLabel() }}</span>
        <span>{{ lastLabel() }}</span>
      </div>
    } @else {
      <p class="py-8 text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
    }

    <!-- §8: the same series, readable by a screen reader and by anyone who
         needs the exact numbers. Hidden visually, never from the a11y tree. -->
    @if (points().length > 0) {
      <table class="sr-only">
        <caption>
          {{
            label()
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col" i18n="@@admin.chart.table.day">Day</th>
            @for (s of seriesLabels(); track s) {
              <th scope="col">{{ s }}</th>
            }
            @if (anyDegraded() && degradedLabel()) {
              <th scope="col">{{ degradedLabel() }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (p of points(); track p.label) {
            <tr>
              <th scope="row">{{ p.label }}</th>
              @for (v of p.segments; track $index) {
                <td>{{ v }}</td>
              }
              @if (anyDegraded() && degradedLabel()) {
                <td>{{ p.degraded ? degradedYes : degradedNo }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: [':host { display: block; }'],
})
export class StackedBarChart {
  /** Oldest-first columns. `segments[i]` pairs with `seriesLabels()[i]`, series 0
   *  stacking at the bottom. */
  readonly points = input.required<readonly StackedBarPoint[]>();
  /** One localized label per stacked series — drives the legend and the table. */
  readonly seriesLabels = input.required<readonly string[]>();
  /** Accessible name for the whole chart (also the table caption). */
  readonly label = input.required<string>();
  /** Localized message when there is nothing to plot. */
  readonly emptyLabel = input.required<string>();
  /**
   * Localized name for a `degraded` column (AECI-877). Drives the legend entry and
   * the hidden table's extra column. Without it a degraded column is still drawn
   * dimmed and hatched, but carries no text, so a caller marking days should pass it.
   */
  readonly degradedLabel = input<string>('');

  protected readonly hatchId = `aec-stacked-bar-hatch-${nextChartId++}`;
  protected readonly degradedYes = $localize`:@@admin.chart.degraded.yes:Yes`;
  protected readonly degradedNo = $localize`:@@admin.chart.degraded.no:No`;

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;
  protected readonly geometry = computed(() =>
    stackedBarGeometry(this.points(), BOX, { gap: 0.2 }),
  );

  protected readonly anyDegraded = computed(() => this.points().some((p) => p.degraded === true));

  /** One overlay per degraded column, spanning every segment it drew. A column
   *  with a zero total draws no segments and so gets no overlay: there is no bar
   *  to mark, and the hidden table still says the day was degraded. */
  protected readonly hatches = computed(() => {
    const points = this.points();
    const byPoint = new Map<number, { x: number; y: number; width: number; bottom: number }>();
    for (const r of this.geometry().rects) {
      if (points[r.pointIndex]?.degraded !== true) continue;
      const cur = byPoint.get(r.pointIndex);
      const bottom = r.y + r.height;
      if (!cur) byPoint.set(r.pointIndex, { x: r.x, y: r.y, width: r.width, bottom });
      else {
        cur.y = Math.min(cur.y, r.y);
        cur.bottom = Math.max(cur.bottom, bottom);
      }
    }
    return [...byPoint].map(([pointIndex, b]) => ({
      pointIndex,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.bottom - b.y,
    }));
  });

  protected isDegraded(pointIndex: number): boolean {
    return this.points()[pointIndex]?.degraded === true;
  }

  protected readonly firstLabel = computed(() => this.points()[0]?.label ?? '');
  protected readonly lastLabel = computed(
    () => this.points()[this.points().length - 1]?.label ?? '',
  );

  /** The dashed rule above the bars is this value; the baseline is zero. It is the
   *  scale ceiling from `niceMax`, deliberately not the observed peak. */
  protected readonly scaleLabel = computed(
    () => $localize`:@@admin.chart.scale:Scale 0 to ${this.geometry().max}:MAX:`,
  );

  protected fillFor(seriesIndex: number): string {
    return SERIES_FILLS[seriesIndex % SERIES_FILLS.length]!;
  }
}
