import { Component, computed, input, signal } from '@angular/core';

import { buildTimeAxis } from './axis';
import { ChartDataTable } from './chart-data-table';
import { ChartLegend, type ChartLegendItem } from './chart-legend';
import { areaPath, indexAtFraction, linePath } from './geometry';
import { formatThousands } from './format';
import { slotClass, type ChartSeries } from './chart-types';

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
      @if (legendItems().length > 1) {
        <aec-chart-legend class="mb-3" [items]="legendItems()" />
      }

      @if (isEmpty()) {
        <p class="py-10 text-center text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
      } @else {
        <div class="flex gap-2">
          <!-- Value axis: HTML labels, positioned by percentage of the plot box. -->
          <div class="relative w-10 shrink-0" aria-hidden="true">
            @for (tick of axis().ticks; track tick.value) {
              <span
                class="absolute right-0 -translate-y-1/2 text-[0.6875rem] tabular-nums
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

            <!-- Tooltip: HTML, positioned by percentage from the same pure
                 geometry. Nothing is measured, so it is SSR-consistent. -->
            @if (hoverIndex(); as idx) {
              <div
                class="pointer-events-none absolute top-0 z-10 min-w-32 -translate-x-1/2
                  rounded-(--radius-md) border border-(--border-default) bg-(--surface-base)
                  px-3 py-2 text-xs shadow-sm"
                [style.left.%]="hoverPct()"
                aria-hidden="true"
              >
                <p class="font-semibold text-(--text-primary)">{{ categories()[idx - 1] }}</p>
                @for (row of hoverRows(); track row.key) {
                  <p class="flex items-center gap-1.5 text-(--text-secondary)">
                    <span class="size-2 shrink-0 rounded-full {{ row.swatch }}"></span>
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
                  class="absolute -translate-x-1/2 text-[0.6875rem] whitespace-nowrap
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
      />
    </figure>
  `,
  styles: [':host { display: block; }'],
})
export class LineChart {
  readonly series = input.required<readonly ChartSeries[]>();
  /** Row headers — already-localized day labels, index-aligned to the values. */
  readonly categories = input.required<readonly string[]>();
  readonly categoryHeader = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;
  /** 1-based so `@if (hoverIndex(); as idx)` treats index 0 as present — a plain
   *  0 is falsy and would silently drop the tooltip on the first day. */
  protected readonly hoverIndex = signal<number | null>(null);

  protected readonly isEmpty = computed(() => this.categories().length === 0);

  protected readonly axis = computed(() =>
    buildTimeAxis({
      box: BOX,
      count: this.categories().length,
      series: this.series().map((s) => s.values),
      stacked: false,
    }),
  );

  protected readonly paths = computed(() => {
    const axis = this.axis();
    const single = this.series().length === 1;
    return this.series().map((s) => {
      const points = axis.bands.map((band, i) => ({ x: band.center, y: axis.y(s.values[i] ?? 0) }));
      return {
        key: s.key,
        line: linePath(points),
        // The wash reads as "this is the quantity" for a lone series. With two or
        // more it just muddies the overlap, so it is single-series only.
        area: single ? areaPath(points, axis.plot.y + axis.plot.height) : '',
        fill: slotClass(s.slot, 'fill'),
        stroke: slotClass(s.slot, 'stroke'),
      };
    });
  });

  /** A legend for one series would restate the title; the template gates on > 1. */
  protected readonly legendItems = computed<ChartLegendItem[]>(() =>
    this.series().map((s) => ({ key: s.key, label: s.label, slot: s.slot })),
  );

  protected readonly hoverX = computed(() => {
    const idx = this.hoverIndex();
    return idx === null ? 0 : (this.axis().bands[idx - 1]?.center ?? 0);
  });

  protected readonly hoverPct = computed(() => (this.hoverX() / BOX.width) * 100);

  protected readonly hoverDots = computed(() => {
    const idx = this.hoverIndex();
    if (idx === null) return [];
    const axis = this.axis();
    return this.series().map((s) => ({
      key: s.key,
      x: axis.bands[idx - 1]?.center ?? 0,
      y: axis.y(s.values[idx - 1] ?? 0),
      fill: slotClass(s.slot, 'fill'),
    }));
  });

  protected readonly hoverRows = computed(() => {
    const idx = this.hoverIndex();
    if (idx === null) return [];
    return this.series().map((s) => ({
      key: s.key,
      label: s.label,
      value: formatThousands(s.values[idx - 1] ?? 0),
      swatch: slotClass(s.slot, 'swatch'),
    }));
  });

  protected tickLabel(value: number): string {
    return formatThousands(value);
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
