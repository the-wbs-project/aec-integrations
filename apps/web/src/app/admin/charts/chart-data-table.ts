import { Component, computed, input } from '@angular/core';

import { formatThousands } from './format';
import type { NullableChartSeries } from './chart-types';

/**
 * The visually-hidden data table every chart carries — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §8: *"Each chart is `role="img"` with a descriptive
 * `aria-label`, plus a visually-hidden `<table>` carrying the same series. Charts
 * are never the only representation of a number."*
 *
 * ─── The placement rule this component exists to enforce ─────────────────────
 *
 * **The table must be a SIBLING of the `role="img"` element, never a
 * descendant.** `role="img"` makes an element's subtree presentational to
 * assistive technology — the accessible name replaces the content wholesale. A
 * table nested inside the `<svg role="img">` is therefore invisible to exactly
 * the reader it was written for, while still passing axe (which has no way to
 * know the table was meant to be reachable). Every chart in this directory
 * renders `<svg role="img">` and `<aec-chart-data-table>` as siblings inside the
 * `<figure>` for that reason, and each chart's spec asserts the table's contents
 * so the regression is caught in CI rather than by a screen-reader user.
 *
 * One implementation, not five: the table is the single place where "the chart's
 * numbers" are re-expressed, so a chart cannot ship a subtly different table.
 */
@Component({
  selector: 'aec-chart-data-table',
  // The wrapper carries sr-only, not the table: a table never shrinks to sr-only's
  // 1px box, so on its own a long series widened the page at 320px (AECI-2125, the
  // same fix `stacked-bar-chart.ts` took in AECI-1813). The wrapper clips it, and a
  // screen reader still reads it.
  template: `
    <div class="sr-only">
      <table>
        <caption>
          {{
            caption()
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ categoryHeader() }}</th>
            @for (s of series(); track s.key) {
              <th scope="col">{{ s.label }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.label; let i = $index) {
            <tr>
              <th scope="row">{{ row.label }}</th>
              @for (cell of row.cells; track $index) {
                <td>{{ cell }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [':host { display: contents; }'],
})
export class ChartDataTable {
  /** Names what the table is — screen-reader users land on this first. */
  readonly caption = input.required<string>();
  /** The row-header column's name ("Day", "Source", "Country"). */
  readonly categoryHeader = input.required<string>();
  /** Row headers, index-aligned to every series' `values`. Already localized. */
  readonly categories = input.required<readonly string[]>();
  readonly series = input.required<readonly NullableChartSeries[]>();
  /**
   * What a `null` cell says (AECI-822). A `null` value means nothing was
   * recorded there, so it must never print as `0`. Only `LineChart` passes
   * `null`, and it always passes a label with it.
   */
  readonly gapLabel = input('');
  /** Formats a recorded value. `index` is the row, so a caller can qualify one
   *  cell (an open cohort's "so far"). Defaults to the thousands format every
   *  existing chart uses. */
  readonly format = input<(value: number, index: number) => string>((value) =>
    formatThousands(value),
  );

  /**
   * Rows are built here rather than indexed in the template so a series shorter
   * than `categories` renders `0` instead of an empty cell. An empty `<td>` in a
   * data table is ambiguous — it reads as "no value", which is a different claim
   * from "zero", and every series on this page is zero-filled by the API.
   *
   * An explicit `null` is that other claim, made on purpose (AECI-822): it
   * prints {@link gapLabel}, never `0`. A missing index still prints `0`, so
   * every chart that passes plain numbers renders exactly as before.
   */
  protected readonly rows = computed(() => {
    const series = this.series();
    const format = this.format();
    const gap = this.gapLabel();
    return this.categories().map((label, i) => ({
      label,
      cells: series.map((s) => {
        const value = s.values[i];
        return value === null ? gap : format(value ?? 0, i);
      }),
    }));
  });
}
