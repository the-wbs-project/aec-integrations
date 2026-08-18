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
 * Chart legend — AECI-578 / Phase 8.3 P1.4.
 *
 * Present for **two or more series, absent for one**. A one-swatch legend
 * restates the chart's own title and costs vertical space; with a single series
 * the title already says what is plotted.
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
        <li class="flex items-center gap-1.5 text-xs text-(--text-secondary)">
          <span class="size-2.5 shrink-0 rounded-full {{ swatch(item.slot) }}" aria-hidden="true">
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
