/**
 * AECI-668 / Phase 8.3 — the counts-over-time table on `/admin/catalog` (§5.5).
 *
 * Extracted from `catalog-coverage.html` when the section became a Daily /
 * Monthly tabbed panel: both tabs render exactly the same four branches
 * (loading / failed / empty / table) over the same four `catalog.*` series, and
 * differ only in how the bucket column is worded. Two copies of that markup in
 * one template is how the two views drift apart.
 *
 * Purely presentational: it fetches nothing, owns no window, and holds no
 * granularity state of its own. The parent decides which window to request and
 * hands over the already-bucketed rows.
 *
 * ─── The banner is load-bearing ──────────────────────────────────────────────
 *
 * `notes` is rendered ABOVE the table on every branch, including the empty one.
 * Since AECI-686 the parent requests `basis=net`, so the banner carries
 * `catalog_series_is_surviving_rows`: these are the records in the catalog now,
 * counted against the period they arrived in, which is why the columns reconcile
 * with the totals cards and why an earlier period's figure can fall later. On
 * `catalog.claims_created` it also carries the caveat that promote rewrites
 * claims, so their dates are last-promote dates.
 *
 * None of that is hardcoded here — the API derives each note from the window it
 * actually served, so a note retires itself when it stops being true. Do not drop
 * the banner, and do not hoist it above the tabs: the windows differ and so do
 * their caveats.
 */
import { Component, computed, input, output } from '@angular/core';

import type { AdminNote } from '@aeci/shared';

import { AdminNotes } from '../admin-notes';
import { CONSOLE_PANEL_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { AecButton } from '../../shared/button/button';

let nextId = 0;

/** Which bucket the rows are keyed by. Drives wording only. */
export type AdditionsGranularity = 'day' | 'month';

/** One row of an additions table: a UTC bucket key and the series' values, in
 *  the parent's `SERIES_METRICS` order. `bucket` is `YYYY-MM-DD` at day
 *  granularity and `YYYY-MM` at month granularity, so it sorts lexically either
 *  way and needs no separate sort key. */
export interface AdditionsRow {
  bucket: string;
  values: readonly number[];
}

@Component({
  selector: 'aec-additions-table',
  imports: [AdminNotes, AecButton],
  template: `
    <aec-admin-notes [notes]="notes()" />

    @if (loading()) {
      <p class="mt-4 text-t-16 text-(--text-secondary)" i18n="@@admin.catalog.additions.loading">
        Loading additions…
      </p>
    } @else if (failed()) {
      <div [class]="panelClass" class="mt-4">
        <p
          class="text-t-16 font-semibold text-(--text-primary)"
          role="alert"
          i18n="@@admin.catalog.additions.loadFailed"
        >
          We couldn't load the additions series.
        </p>
        <button
          aecButton
          variant="secondary"
          class="mt-4"
          (click)="retry.emit()"
          i18n="@@admin.catalog.additions.retry"
        >
          Try again
        </button>
      </div>
    } @else if (empty()) {
      <p [class]="t.empty" class="mt-4" i18n="@@admin.catalog.additions.emptyNet">
        Nothing currently in the catalog was added in this window.
      </p>
    } @else {
      <div
        [class]="t.region"
        class="mt-4"
        role="region"
        tabindex="0"
        [attr.aria-labelledby]="captionId"
      >
        <table [class]="t.table" class="min-w-[32rem]">
          <caption [id]="captionId" [class]="t.caption">
            {{
              caption()
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col" [class]="t.head">{{ bucketHeading() }}</th>
              @for (label of seriesLabels(); track label) {
                <th scope="col" [class]="t.headNum">{{ label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.bucket) {
              <tr [class]="t.row">
                <th scope="row" [class]="bucketClass">{{ row.bucket }}</th>
                @for (v of row.values; track $index) {
                  <td [class]="t.num">{{ v }}</td>
                }
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" [class]="footHeadClass" i18n="@@admin.catalog.additions.totalNet">
                In catalog from this window
              </th>
              @for (t of totals(); track $index) {
                <td [class]="footNumClass">{{ t }}</td>
              }
            </tr>
          </tfoot>
        </table>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdditionsTable {
  readonly granularity = input.required<AdditionsGranularity>();
  /** Column headers, in the same order as every row's `values`. */
  readonly seriesLabels = input.required<readonly string[]>();
  readonly rows = input.required<readonly AdditionsRow[]>();
  readonly notes = input.required<readonly AdminNote[]>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();
  readonly retry = output<void>();

  /** The console recipe (AECI-2125). */
  protected readonly t = CONSOLE_TABLE;
  protected readonly panelClass = CONSOLE_PANEL_CLASS;
  /** The bucket is a date key: never wrapped, tabular. */
  protected readonly bucketClass = `${CONSOLE_TABLE.rowHead} whitespace-nowrap tabular-nums`;
  /** The footer row sits under a strong rule and reads at 600, as before. */
  protected readonly footHeadClass =
    'px-3 py-2 text-start font-semibold text-(--text-primary) border-t-2 border-(--border-strong)';
  protected readonly footNumClass =
    'px-3 py-2 text-end font-semibold tabular-nums lining-nums whitespace-nowrap text-(--text-primary) border-t-2 border-(--border-strong)';
  /** Both tabs render this table, so each caption needs its own id. */
  protected readonly captionId = `admin-catalog-additions-caption-${nextId++}`;

  /** Column totals, so the table has a footer an operator can read at a glance. */
  protected readonly totals = computed<readonly number[]>(() => {
    const rows = this.rows();
    const width = rows[0]?.values.length ?? this.seriesLabels().length;
    return Array.from({ length: width }, (_, i) =>
      rows.reduce((acc, r) => acc + (r.values[i] ?? 0), 0),
    );
  });

  /** True when nothing was added in the whole window. Common on a quiet catalog
   *  and worth saying, rather than showing rows of zeros. */
  protected readonly empty = computed(() => this.totals().every((v) => v === 0));

  protected readonly bucketHeading = computed(() =>
    this.granularity() === 'month'
      ? $localize`:@@admin.catalog.additions.month:Month (UTC)`
      : $localize`:@@admin.catalog.additions.day:Day (UTC)`,
  );

  /** The monthly caption is where the partial current month is stated. That is a
   *  structural fact of the view rather than a claim about the data, so it lives
   *  here and not in a hand-written note: the API's own `partial_day` caveat
   *  still rides in the banner above. */
  protected readonly caption = computed(() =>
    this.granularity() === 'month'
      ? $localize`:@@admin.catalog.additions.captionMonthNet:Records now in the catalog, by type, counted against the calendar month they were added in, over the last 12 UTC months. The current month is still filling.`
      : $localize`:@@admin.catalog.additions.captionNet:Records now in the catalog, by type, counted against the day they were added, over the last 30 UTC days.`,
  );
}
