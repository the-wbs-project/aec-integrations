import { Component, computed, input, signal } from '@angular/core';

import { buildTimeAxis } from './axis';
import { ChartDataTable } from './chart-data-table';
import { ChartLegend, type ChartLegendItem } from './chart-legend';
import { areaPath, barPath, indexAtFraction, stackSeries } from './geometry';
import { formatThousands } from './format';
import { slotClass, type ChartSeries } from './chart-types';

const BOX = { width: 720, height: 220, padding: { top: 12, right: 12, bottom: 8, left: 8 } };
/** The surface gap — 2 user units of white between touching columns. White does
 *  the separating; a stroke around a mark would add ink that isn't data. */
const COLUMN_GAP = 2;
/** The same gap, applied vertically between the segments of one column. Same
 *  width as the column gap by design: one consistent spacer across the chart. */
const SEGMENT_GAP = 2;
/** 4px rounded data end, square at the baseline. */
const BAR_RADIUS = 4;

/**
 * Stacked bar / area chart over a day axis — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §8 lists these as one form because they answer the
 * same question (part-to-whole over time) and differ only in mark; `[area]`
 * flips between them.
 *
 * The page's primary chart: human vs bot page views per day.
 *
 * ─── Two things that are easy to get wrong, and are handled ──────────────────
 *
 * **The y-domain is the stack TOTAL, not the tallest series.** `buildTimeAxis`
 * does this (`stacked: true`); getting it wrong clips the top segment above its
 * own axis, and it looks plausible enough to ship.
 *
 * **Only the topmost non-zero segment gets the rounded data end.** Rounding
 * every segment would put a rounded cap in the middle of a column, which reads as
 * a gap in the data. Interior segments are square, and the 2px surface gap is
 * what separates them.
 */
@Component({
  selector: 'aec-stacked-series-chart',
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

              @if (area()) {
                @for (band of areaBands(); track band.key) {
                  <path [attr.d]="band.d" [class]="band.fill" opacity="0.6" />
                }
              } @else {
                @for (mark of marks(); track mark.key) {
                  <path [attr.d]="mark.d" [class]="mark.fill" />
                }
              }

              @if (hoverIndex() !== null) {
                <rect
                  aria-hidden="true"
                  [attr.x]="hoverBand().start"
                  [attr.y]="axis().plot.y"
                  [attr.width]="hoverBand().width"
                  [attr.height]="axis().plot.height"
                  fill="var(--text-primary)"
                  opacity="0.06"
                />
              }
            </svg>

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
export class StackedSeriesChart {
  readonly series = input.required<readonly ChartSeries[]>();
  readonly categories = input.required<readonly string[]>();
  readonly categoryHeader = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();
  /** Stacked area instead of stacked columns. Same data, same domain, same
   *  table — a denser read for long windows where columns get hairline-thin. */
  readonly area = input(false);

  protected readonly viewBox = `0 0 ${BOX.width} ${BOX.height}`;
  /** 1-based; see `LineChart.hoverIndex` for why. */
  protected readonly hoverIndex = signal<number | null>(null);

  protected readonly isEmpty = computed(() => this.categories().length === 0);

  protected readonly axis = computed(() =>
    buildTimeAxis({
      box: BOX,
      count: this.categories().length,
      series: this.series().map((s) => s.values),
      stacked: true,
      gap: this.area() ? 0 : COLUMN_GAP,
    }),
  );

  private readonly stacked = computed(() => stackSeries(this.series().map((s) => s.values)));

  /** One path per series per day. Flattened so the template does not nest two
   *  `@for`s over index-aligned arrays, which is where off-by-ones live. */
  protected readonly marks = computed(() => {
    const axis = this.axis();
    const stacked = this.stacked();
    const series = this.series();
    const out: Array<{ key: string; d: string; fill: string }> = [];

    axis.bands.forEach((band, dayIndex) => {
      // Which series is on top TODAY — it varies per day, because a series can
      // be zero on any given day and a zero segment must not claim the cap.
      let topSeries = -1;
      for (let s = series.length - 1; s >= 0; s--) {
        if ((stacked[s]?.[dayIndex]?.value ?? 0) > 0) {
          topSeries = s;
          break;
        }
      }

      series.forEach((s, seriesIndex) => {
        const segment = stacked[seriesIndex]?.[dayIndex];
        if (!segment || segment.value <= 0) return;
        const isTopSegment = seriesIndex === topSeries;
        const yTop = axis.y(segment.top);
        const yBase = axis.y(segment.base);

        // The surface gap, vertically. Every segment with another above it gives
        // 2 units back off its TOP edge, so the boundary between two fills is
        // white rather than a hue-on-hue seam. Without it, `human` under `bot`
        // reads as one bar with a coloured underline instead of two quantities.
        //
        // Clamped to half the segment so a thin day shrinks rather than
        // inverting into a negative height, and skipped on the topmost segment,
        // which has nothing to separate from.
        const inset = isTopSegment ? 0 : Math.min(SEGMENT_GAP, Math.max(0, (yBase - yTop) / 2));
        const y = yTop + inset;
        const height = Math.max(0, yBase - y);

        out.push({
          key: `${s.key}-${dayIndex}`,
          d: barPath(
            { x: band.start, y, width: band.width, height },
            isTopSegment ? BAR_RADIUS : 0,
            'vertical',
          ),
          fill: slotClass(s.slot, 'fill'),
        });
      });
    });
    return out;
  });

  /** Stacked-area variant: one filled band per series between its base and top. */
  protected readonly areaBands = computed(() => {
    const axis = this.axis();
    const stacked = this.stacked();
    return this.series().map((s, seriesIndex) => {
      const segments = stacked[seriesIndex] ?? [];
      const tops = axis.bands.map((band, i) => ({
        x: band.center,
        y: axis.y(segments[i]?.top ?? 0),
      }));
      const bases = axis.bands
        .map((band, i) => ({ x: band.center, y: axis.y(segments[i]?.base ?? 0) }))
        .reverse();
      // Trace the top edge forward and the base edge back — a true band, not an
      // area to the axis, so lower series are not overpainted by higher ones.
      const d = [
        areaPath(tops, axis.plot.y + axis.plot.height).split(' Z')[0] ?? '',
        ...bases.map((p) => `L ${p.x} ${p.y}`),
        'Z',
      ].join(' ');
      return { key: s.key, d, fill: slotClass(s.slot, 'fill') };
    });
  });

  protected readonly legendItems = computed<ChartLegendItem[]>(() =>
    this.series().map((s) => ({ key: s.key, label: s.label, slot: s.slot })),
  );

  protected readonly hoverBand = computed(() => {
    const idx = this.hoverIndex();
    return (idx === null ? null : this.axis().bands[idx - 1]) ?? { start: 0, center: 0, width: 0 };
  });

  protected readonly hoverPct = computed(() => (this.hoverBand().center / BOX.width) * 100);

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

  /** See `LineChart.onPointerMove` — same rationale, same purity boundary. */
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
