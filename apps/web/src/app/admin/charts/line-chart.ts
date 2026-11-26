import { Component, computed, input, signal } from '@angular/core';

import { buildTimeAxis } from './axis';
import { ChartDataTable } from './chart-data-table';
import { ChartLegend, slotNeedsRelief, type ChartLegendItem } from './chart-legend';
import { areaPath, indexAtFraction, linePath } from './geometry';
import { formatPercent, formatThousands } from './format';
import { recordedRuns, slotClass, unrecordedSpans, type NullableChartSeries } from './chart-types';

const BOX = { width: 720, height: 220, padding: { top: 12, right: 12, bottom: 8, left: 8 } };

/**
 * Line chart over a day axis — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §8.
 *
 * Renders one or more series as 2px lines with an area wash under a lone series.
 * Geometry comes entirely from `buildTimeAxis` (pure), so the SSR HTML is already
 * the finished chart — no measurement, no post-hydration layout pass.
 *
 * **Axis labels are HTML over the SVG, not `<text>` inside it.** See `axis.ts`
 * for why; the short version is that `viewBox` scaling shrinks SVG text to
 * unreadable sizes in a narrow column, and the fix would be the JS resize handler
 * §8 forbids.
 *
 * a11y: `role="img"` + `aria-label` on the `<svg>`, and the data table as its
 * **sibling** — inside, `role="img"` would make it presentational and hide it
 * from the reader it exists for (see `ChartDataTable`). The hover tooltip is
 * `aria-hidden`: it is a convenience for pointer users and duplicates the table.
 */
@Component({
  selector: 'aec-line-chart',
  imports: [ChartDataTable, ChartLegend],
  template: `
    <figure class="m-0">
      @if (showLegend()) {
        <aec-chart-legend class="mb-3" [items]="legendItems()" />
      }

      @if (isEmpty()) {
        <p class="py-10 text-center text-t-14 text-(--text-secondary)">{{ emptyLabel() }}</p>
      } @else {
        <div class="flex gap-2">
          <!-- Value axis: HTML labels, positioned by percentage of the plot box. -->
          <div class="relative w-10 shrink-0" aria-hidden="true">
            @for (tick of axis().ticks; track tick.value) {
              <span
                class="absolute right-0 -translate-y-1/2 text-t-12 tabular-nums
                  text-(--text-secondary)"
                [style.top.%]="tick.pct"
                >{{ tickLabel(tick.value) }}</span
              >
            }
          </div>

          <div class="relative min-w-0 flex-1">
            <svg
              [attr.viewBox]="viewBox"
              preserveAspectRatio="xMidYMid meet"
              class="block h-auto w-full"
              role="img"
              [attr.aria-label]="ariaLabel()"
              (pointermove)="onPointerMove($event)"
              (pointerleave)="hoverIndex.set(null)"
            >
              <g aria-hidden="true">
                @for (tick of axis().ticks; track tick.value) {
                  <line
                    [attr.x1]="axis().plot.x"
                    [attr.x2]="axis().plot.x + axis().plot.width"
                    [attr.y1]="tick.y"
                    [attr.y2]="tick.y"
                    stroke="var(--chart-grid)"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                }
              </g>

              <!-- AECI-822: a stretch where NO series has a value is hatched, so
                   the gap reads as "nothing was recorded", never as a quiet week.
                   Hand-drawn lines, not an SVG pattern: a url(#id) fill is a
                   bare fragment, which the app's base href breaks. The hatch is
                   --border-field, 3.55:1 on the chart surface, so the band
                   passes WCAG 1.4.11 (AECI-823). The grid colour was 1.22:1. -->
              @for (span of gapSpans(); track span.key) {
                <g aria-hidden="true">
                  @for (hatch of span.hatches; track $index) {
                    <line
                      [attr.x1]="hatch.x1"
                      [attr.y1]="hatch.y1"
                      [attr.x2]="hatch.x2"
                      [attr.y2]="hatch.y2"
                      stroke="var(--border-field)"
                      stroke-width="1"
                      vector-effect="non-scaling-stroke"
                    />
                  }
                </g>
              }

              @for (path of paths(); track path.key) {
                @if (path.area) {
                  <path [attr.d]="path.area" [class]="path.fill" opacity="0.1" />
                }
                <path
                  [attr.d]="path.line"
                  [class]="path.stroke"
                  fill="none"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  vector-effect="non-scaling-stroke"
                />
              }

              <!-- AECI-822: the last point of an open period (a cohort whose window
                   has not closed) is hollow and off the line, because its value
                   can still rise. -->
              @for (dot of openDots(); track dot.key) {
                <circle
                  [attr.cx]="dot.x"
                  [attr.cy]="dot.y"
                  r="4"
                  fill="var(--chart-surface)"
                  [class]="dot.stroke"
                  stroke-width="2"
                  vector-effect="non-scaling-stroke"
                />
              }

              @if (hoverIndex() !== null) {
                <g aria-hidden="true">
                  <line
                    [attr.x1]="hoverX()"
                    [attr.x2]="hoverX()"
                    [attr.y1]="axis().plot.y"
                    [attr.y2]="axis().plot.y + axis().plot.height"
                    stroke="var(--border-strong)"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                  @for (dot of hoverDots(); track dot.key) {
                    <circle
                      [attr.cx]="dot.x"
                      [attr.cy]="dot.y"
                      r="4"
                      [class]="dot.fill"
                      stroke="var(--chart-surface)"
                      stroke-width="2"
                      vector-effect="non-scaling-stroke"
                    />
                  }
                </g>
              }
            </svg>

            <!-- The band's label. When an @container ancestor is narrow, a
                 one-week band cannot hold the words across, so they run down the
                 band instead. There is a text cue at every width, never the
                 hatch alone (AECI-823, WCAG 1.4.11). -->
            @if (gapLabel()) {
              @for (span of gapSpans(); track span.key) {
                <span
                  class="pointer-events-none absolute top-[40%] -translate-x-1/2 -translate-y-1/2
                    bg-(--chart-surface) px-1 text-center text-t-12 leading-tight
                    text-(--text-secondary) @max-md:rotate-180
                    @max-md:whitespace-nowrap @max-md:[writing-mode:vertical-rl]"
                  [style.left.%]="span.centerPct"
                  [style.max-width.%]="span.widthPct"
                  aria-hidden="true"
                  >{{ gapLabel() }}</span
                >
              }
            }

            <!-- Tooltip: HTML, positioned by percentage from the same pure
                 geometry. Nothing is measured, so it is SSR-consistent. -->
            @if (hoverIndex(); as idx) {
              <div
                class="pointer-events-none absolute top-0 z-10 min-w-32 -translate-x-1/2
                  rounded-control border border-(--border-default) bg-(--surface-base)
                  px-3 py-2 text-t-12 shadow-sm"
                [style.left.%]="hoverPct()"
                aria-hidden="true"
              >
                <p class="font-semibold text-(--text-primary)">{{ categories()[idx - 1] }}</p>
                @for (row of hoverRows(); track row.key) {
                  <p class="flex items-center gap-2 text-(--text-secondary)">
                    <span class="size-2 shrink-0 rounded-pill {{ row.swatch }}"></span>
                    <span>{{ row.label }}</span>
                    <span class="ms-auto font-semibold tabular-nums text-(--text-primary)">{{
                      row.value
                    }}</span>
                  </p>
                }
              </div>
            }

            <!-- Category axis: HTML, same percentage trick. -->
            <div class="relative mt-1 h-4" aria-hidden="true">
              @for (label of axis().labelled; track label.index) {
                <span
                  class="absolute -translate-x-1/2 text-t-12 whitespace-nowrap
                    text-(--text-secondary)"
                  [style.left.%]="label.pct"
                  >{{ categories()[label.index] }}</span
                >
              }
            </div>
          </div>
        </div>
      }

      <aec-chart-data-table
        [caption]="ariaLabel()"
        [categoryHeader]="categoryHeader()"
        [categories]="categories()"
        [series]="series()"
        [gapLabel]="gapLabel()"
        [format]="tableFormat()"
      />
    </figure>
  `,
  styles: [':host { display: block; }'],
})
export class LineChart {
  readonly series = input.required<readonly NullableChartSeries[]>();
  /** Row headers — already-localized day labels, index-aligned to the values. */
  readonly categories = input.required<readonly string[]>();
  readonly categoryHeader = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();
  /**
   * AECI-822. What a `null` value says, in the data table, in the tooltip and on
   * the hatched band where every series is `null`. A `null` is drawn as a gap,
   * never as zero. Charts that pass only numbers never see it.
   */
  readonly gapLabel = input('');
  /** `'percent'` reads every value as a fraction from 0 to 1, pins the axis to
   *  0 to 100% and prints whole percents. `'count'` is the default, unchanged. */
  readonly unit = input<'count' | 'percent'>('count');
  /** AECI-822. The last position is still open (its value can still change), so
   *  it is drawn as a hollow point off the line, and its table cell carries
   *  {@link openLabel}. */
  readonly openLast = input(false);
  readonly openLabel = input('');

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;
  /** 1-based so `@if (hoverIndex(); as idx)` treats index 0 as present — a plain
   *  0 is falsy and would silently drop the tooltip on the first day. */
  protected readonly hoverIndex = signal<number | null>(null);

  protected readonly isEmpty = computed(() => this.categories().length === 0);

  protected readonly axis = computed(() => {
    // A `null` adds nothing to the domain. Mapping it to 0 cannot raise the max,
    // and an all-number series maps to itself, so existing axes are unchanged.
    const values = this.series().map((s) => s.values.map((v) => v ?? 0));
    return buildTimeAxis({
      box: BOX,
      count: this.categories().length,
      // A rate axis always runs to 100%, so a good week and a bad week are drawn
      // on the same scale whatever the data's own maximum is.
      series: this.unit() === 'percent' ? [...values, [1]] : values,
      stacked: false,
    });
  });

  /** The index left off the line because it is still open, or -1. */
  private readonly openIndex = computed(() =>
    this.openLast() ? this.categories().length - 1 : -1,
  );

  protected readonly paths = computed(() => {
    const axis = this.axis();
    const single = this.series().length === 1;
    const open = this.openIndex();
    return this.series().map((s) => {
      // `null` breaks the line. A missing index (a series shorter than the axis)
      // still plots as 0, as it always has.
      const points = axis.bands.map((band, i) => {
        const value = s.values[i];
        if (value === null || i === open) return null;
        return { x: band.center, y: axis.y(value ?? 0) };
      });
      // One run per stretch of recorded values. A series with no `null` is one
      // run, so its `d` is exactly what a single `linePath` call produced.
      const runs = recordedRuns(points);
      return {
        key: s.key,
        line: runs.map((run) => linePath(run)).join(' '),
        // The wash reads as "this is the quantity" for a lone series. With two or
        // more it just muddies the overlap, so it is single-series only.
        area: single
          ? runs.map((run) => areaPath(run, axis.plot.y + axis.plot.height)).join(' ')
          : '',
        fill: slotClass(s.slot, 'fill'),
        stroke: slotClass(s.slot, 'stroke'),
      };
    });
  });

  protected readonly openDots = computed(() => {
    const open = this.openIndex();
    if (open < 0) return [];
    const axis = this.axis();
    const x = axis.bands[open]?.center;
    if (x === undefined) return [];
    return this.series().flatMap((s) => {
      const value = s.values[open];
      if (value === null || value === undefined) return [];
      return [{ key: s.key, x, y: axis.y(value), stroke: slotClass(s.slot, 'stroke') }];
    });
  });

  /** The hatched "nothing recorded" bands, with their label positions. */
  protected readonly gapSpans = computed(() => {
    const axis = this.axis();
    const count = this.categories().length;
    if (count === 0) return [];
    const slot = axis.plot.width / count;
    const top = axis.plot.y;
    const height = axis.plot.height;
    return unrecordedSpans(this.series(), count).map((span) => {
      const x0 = axis.plot.x + slot * span.from;
      const width = slot * (span.to - span.from + 1);
      return {
        key: `${span.from}-${span.to}`,
        hatches: hatchLines(x0, top, width, height, 8),
        centerPct: ((x0 + width / 2) / BOX.width) * 100,
        widthPct: (width / BOX.width) * 100,
      };
    });
  });

  /** Value to text for the table and the tooltip, in this chart's unit. */
  private readonly valueText = computed(() =>
    this.unit() === 'percent'
      ? (value: number) => formatPercent(value, 1)
      : (value: number) => formatThousands(value),
  );

  protected readonly tableFormat = computed(() => {
    const text = this.valueText();
    const open = this.openIndex();
    const label = this.openLabel();
    return (value: number, index: number) =>
      index === open && label ? `${text(value)} ${label}` : text(value);
  });

  /**
   * A series on a relief slot (3 to 5, below 3:1) carries its latest value as
   * visible text, the line's end label, so its colour never carries a value
   * alone (AECI-2125, `slotNeedsRelief`).
   */
  protected readonly legendItems = computed<ChartLegendItem[]>(() =>
    this.series().map((s) => ({
      key: s.key,
      label: s.label,
      slot: s.slot,
      ...(slotNeedsRelief(s.slot) && s.values.length > 0
        ? { value: this.reliefValue(s.values) }
        : {}),
    })),
  );

  /** The relief label's text: the last value in this chart's unit and open-week
   *  wording, or the gap label when nothing was recorded there (AECI-822). A
   *  count chart with no `null` and no `openLast` prints exactly what `main` did. */
  private reliefValue(values: readonly (number | null)[]): string {
    const last = values.length - 1;
    const value = values[last];
    return value === null ? this.gapLabel() : this.tableFormat()(value ?? 0, last);
  }

  /** A legend for one series would restate the title, unless that series needs
   *  relief: then the legend is where its value is written. */
  protected readonly showLegend = computed(() => {
    const items = this.legendItems();
    return items.length > 1 || items.some((i) => i.value !== undefined);
  });

  protected readonly hoverX = computed(() => {
    const idx = this.hoverIndex();
    return idx === null ? 0 : (this.axis().bands[idx - 1]?.center ?? 0);
  });

  protected readonly hoverPct = computed(() => (this.hoverX() / BOX.width) * 100);

  protected readonly hoverDots = computed(() => {
    const idx = this.hoverIndex();
    if (idx === null) return [];
    const axis = this.axis();
    // A `null` has no position, so it gets no dot. Everything else is as before.
    return this.series()
      .filter((s) => s.values[idx - 1] !== null)
      .map((s) => ({
        key: s.key,
        x: axis.bands[idx - 1]?.center ?? 0,
        y: axis.y(s.values[idx - 1] ?? 0),
        fill: slotClass(s.slot, 'fill'),
      }));
  });

  protected readonly hoverRows = computed(() => {
    const idx = this.hoverIndex();
    if (idx === null) return [];
    // The table's formatter, so an open week reads "so far" in the tooltip too.
    // With no `openLast` it is the plain unit format, as before.
    const text = this.tableFormat();
    return this.series().map((s) => {
      const value = s.values[idx - 1];
      return {
        key: s.key,
        label: s.label,
        value: value === null ? this.gapLabel() : text(value ?? 0, idx - 1),
        swatch: slotClass(s.slot, 'swatch'),
      };
    });
  });

  protected tickLabel(value: number): string {
    return this.unit() === 'percent' ? formatPercent(value, 1) : formatThousands(value);
  }

  /**
   * Pointer → bucket, as a FRACTION of the chart's width.
   *
   * This is the one `getBoundingClientRect` in the directory, and it does not
   * breach §8's "no DOM measurement": that rule is about *geometry* — the chart
   * must render correctly in the SSR HTML without a layout pass. Nothing here
   * feeds geometry. A pointer event only exists in a browser, after paint, and
   * the measurement it triggers decides which already-computed bucket the cursor
   * is over. Delete this handler and the chart is unchanged.
   *
   * The result is a fraction rather than a pixel offset so `indexAtFraction`
   * stays pure and unit-tested, and so the tooltip can be placed by percentage.
   */
  protected onPointerMove(event: PointerEvent): void {
    const target = event.currentTarget as SVGSVGElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const index = indexAtFraction(fraction, this.categories().length);
    this.hoverIndex.set(index === null ? null : index + 1);
  }
}

/**
 * Diagonal hatch lines filling a rectangle, clipped to it, `step` user units
 * apart. Each line runs at 45 degrees, rising right to left. Pure, so the band is in
 * the SSR HTML like the rest of the chart.
 */
function hatchLines(
  x0: number,
  y0: number,
  width: number,
  height: number,
  step: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  if (width <= 0 || height <= 0 || step <= 0) return lines;
  const bottom = y0 + height;
  for (let c = step; c < width + height; c += step) {
    // Start on the bottom edge, or on the right edge once c passes the width.
    const x1 = c <= width ? x0 + c : x0 + width;
    const y1 = c <= width ? bottom : bottom - (c - width);
    // End on the left edge, or on the top edge once c passes the height.
    const x2 = c <= height ? x0 : x0 + (c - height);
    const y2 = c <= height ? bottom - c : y0;
    lines.push({ x1: round1(x1), y1: round1(y1), x2: round1(x2), y2: round1(y2) });
  }
  return lines;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
