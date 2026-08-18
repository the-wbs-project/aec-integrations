import { Component, computed, input } from '@angular/core';

import { ChartDataTable } from './chart-data-table';
import { ChartLegend, type ChartLegendItem } from './chart-legend';
import { donutSegments } from './geometry';
import { formatPercent, formatThousands } from './format';
import { slotClass, type ChartCategory, type ChartSeries, type ChartSlot } from './chart-types';

const SIZE = 160;
const CENTER = SIZE / 2;
const OUTER_RADIUS = 70;
const INNER_RADIUS = 44;

/**
 * Donut chart — AECI-578 / Phase 8.3 P1.4. Part-to-whole for a small number of
 * categories. `docs/ADMIN_PANEL_SPEC.md` §8.
 *
 * ─── Shipped as a primitive, deliberately not placed on /admin/traffic ───────
 *
 * §8 lists donut in the chart vocabulary and this component completes it. It has
 * **no consumer on the Traffic section**, and that is a decision rather than an
 * omission:
 *
 *   - The `dataviz` skill deprioritises the form outright — *"part-to-whole rides
 *     on the stacked bar chart; donut stays deprioritized"* — and names two
 *     anti-patterns this page would walk straight into: a **2-slice pie** (the
 *     human/bot split, which the stacked bar already answers over time, with more
 *     information) and **a donut for comparing close values** (the country and
 *     source breakdowns, where the interesting rows differ by a few percent and
 *     arc lengths are the hardest encoding to compare).
 *   - Every §5.3 part-to-whole question is better served by
 *     `HorizontalBarChart`, which is what §5.3 uses.
 *
 * So it is built, tested, and available for a later section with a genuine
 * few-category split. When one adopts it, the **relief rule** applies and is
 * already handled below: slots 3-5 of the palette sit under 3:1 on the light
 * surface, so the legend renders **visible** counts and percentages beside each
 * label. That is also why the legend is not optional here the way it is on a
 * single-series line chart — an arc has no room for a direct label.
 */
@Component({
  selector: 'aec-donut-chart',
  imports: [ChartDataTable, ChartLegend],
  template: `
    <figure class="m-0">
      @if (segments().length === 0) {
        <p class="py-8 text-center text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
      } @else {
        <div class="flex flex-wrap items-center gap-6">
          <svg
            [attr.viewBox]="viewBox"
            preserveAspectRatio="xMidYMid meet"
            class="block size-40 shrink-0"
            role="img"
            [attr.aria-label]="ariaLabel()"
          >
            @for (segment of segments(); track segment.key) {
              <path [attr.d]="segment.d" [class]="segment.fill" />
            }
            @if (centerValue()) {
              <text
                [attr.x]="center"
                [attr.y]="center"
                text-anchor="middle"
                dominant-baseline="central"
                class="fill-(--text-primary) text-lg font-semibold tabular-nums"
                aria-hidden="true"
              >
                {{ centerValue() }}
              </text>
            }
          </svg>

          <!-- Visible values discharge the relief rule for the low-contrast
               slots, and give the arcs a label an arc cannot carry. -->
          <aec-chart-legend class="min-w-0 flex-1" [items]="legendItems()" />
        </div>
      }

      <aec-chart-data-table
        [caption]="ariaLabel()"
        [categoryHeader]="categoryHeader()"
        [categories]="tableCategories()"
        [series]="tableSeries()"
      />
    </figure>
  `,
  styles: [':host { display: block; }'],
})
export class DonutChart {
  readonly data = input.required<readonly ChartCategory[]>();
  readonly categoryHeader = input.required<string>();
  readonly valueHeader = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();
  /** Optional figure in the hole — usually the total. Already formatted. */
  readonly centerValue = input<string>('');

  protected readonly viewBox = `0 0 ${SIZE} ${SIZE}`;
  protected readonly center = CENTER;

  private readonly total = computed(() =>
    this.data().reduce((sum, d) => sum + (d.value > 0 ? d.value : 0), 0),
  );

  protected readonly segments = computed(() => {
    const data = this.data();
    return donutSegments(
      data.map((d) => d.value),
      {
        cx: CENTER,
        cy: CENTER,
        outerRadius: OUTER_RADIUS,
        innerRadius: INNER_RADIUS,
        gapDegrees: 2,
      },
    ).map((segment) => {
      // `segment.index` indexes the ORIGINAL array — zero-valued rows produce no
      // arc, so the palette slot must be read through it, never off the arc's
      // own position. Colour follows the entity, never its rank.
      const source = data[segment.index]!;
      return {
        key: source.key || `__unattributed__${source.label}`,
        d: segment.path,
        // Slot defaults to the entity's position in the ORIGINAL array, so a
        // zero-valued row that draws no arc still consumes its slot and the rows
        // around it keep their colours.
        fill: slotClass(source.slot ?? ((segment.index + 1) as ChartSlot), 'fill'),
      };
    });
  });

  protected readonly legendItems = computed<ChartLegendItem[]>(() => {
    const total = this.total();
    return this.data().map((d, i) => ({
      key: d.key || `__unattributed__${d.label}`,
      label: d.label,
      slot: d.slot ?? ((i + 1) as ChartLegendItem['slot']),
      value: `${formatThousands(d.value)} · ${formatPercent(d.value, total)}`,
    }));
  });

  protected readonly tableCategories = computed(() => this.data().map((d) => d.label));

  protected readonly tableSeries = computed<ChartSeries[]>(() => [
    {
      key: 'value',
      label: this.valueHeader(),
      slot: 1,
      values: this.data().map((d) => d.value),
    },
  ]);
}
