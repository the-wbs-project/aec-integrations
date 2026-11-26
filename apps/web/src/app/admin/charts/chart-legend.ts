import { Component, input } from '@angular/core';

import { slotClass } from './chart-types';
import type { ChartSlot } from './chart-types';

/** One legend entry. `value` is optional and, when present, is rendered visibly —
 *  which is what discharges the relief rule for the low-contrast slots. */
export interface ChartLegendItem {
  key: string;
  label: string;
  slot: ChartSlot;
  value?: string;
}

/**
 * The relief rule (`styles.css` `.aec-charts`, DESIGN.md "Data visualization"):
 * slots 3, 4 and 5 sit below 3:1 on the light surface, so a mark in one of them
 * must never be the only way to read its value. A line or stacked chart that
 * draws a series in one of these slots shows that series' value as visible text
 * in its legend, and shows the legend even for a single series (AECI-2125, WCAG
 * 1.4.1). The visually hidden data table does not discharge this: the reader who
 * needs the relief can see the chart.
 */
export function slotNeedsRelief(slot: ChartSlot): boolean {
  return slot === 3 || slot === 4 || slot === 5;
}

/**
 * Chart legend — AECI-578 / Phase 8.3 P1.4.
 *
 * Present for **two or more series, absent for one**, unless a series is on a
 * relief slot (see {@link slotNeedsRelief}). A one-swatch legend restates the
 * chart's own title and costs vertical space; with a single series the title
 * already says what is plotted.
 *
 * The swatch carries the series colour; **the text never does**. A light
 * categorical hue (the yellow and aqua slots) is illegible as text on the light
 * surface, so identity comes from the coloured mark *beside* the label. The
 * swatch is `aria-hidden` and the legend is a plain list: colour is a redundant
 * channel here, never the only one — the label is right there, and the chart's
 * data table carries the numbers regardless.
 */
@Component({
  selector: 'aec-chart-legend',
  template: `
    <ul class="flex flex-wrap items-center gap-x-4 gap-y-1">
      @for (item of items(); track item.key) {
        <li class="flex items-center gap-2 text-t-13 text-(--text-secondary)">
          <span class="size-3 shrink-0 rounded-pill {{ swatch(item.slot) }}" aria-hidden="true">
          </span>
          <span>{{ item.label }}</span>
          @if (item.value) {
            <span class="font-semibold tabular-nums text-(--text-primary)">{{ item.value }}</span>
          }
        </li>
      }
    </ul>
  `,
  styles: [':host { display: block; }'],
})
export class ChartLegend {
  readonly items = input.required<readonly ChartLegendItem[]>();

  protected swatch(slot: ChartSlot): string {
    return slotClass(slot, 'swatch');
  }
}
