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
 * It carries the API's `catalog_series_is_additions_only` caveat, which §4 shows
 * is the difference between reading this table correctly and reading it as a
 * running total (827 `integration.created` events back 496 live rows). It is
 * never hardcoded prose: it retires itself the day the daily snapshot (P2.1)
 * makes exact totals available. Do not drop it, and do not hoist it above the
 * tabs, because the windows differ and so do their caveats.
 */
import { Component, computed, input, output } from '@angular/core';

import type { AdminNote } from '@aeci/shared';

import { AdminNotes } from '../admin-notes';

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
  imports: [AdminNotes],
  template: `
    <aec-admin-notes [notes]="notes()" />

    @if (loading()) {
      <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@admin.catalog.additions.loading">
        Loading additions…
      </p>
    } @else if (failed()) {
      <div class="mt-4 space-y-3">
        <p
          class="text-sm font-medium text-(--text-primary)"
          role="alert"
          i18n="@@admin.catalog.additions.loadFailed"
        >
          We couldn't load the additions series.
        </p>
        <button
          type="button"
          (click)="retry.emit()"
          class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) px-5 py-2.5 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@admin.catalog.additions.retry"
        >
          Try again
        </button>
      </div>
    } @else if (empty()) {
      <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@admin.catalog.additions.empty">
        Nothing was added to the catalog in this window.
      </p>
    } @else {
      <div class="mt-4 overflow-x-auto">
        <table class="w-full min-w-[32rem] border-collapse text-sm">
          <caption class="sr-only">
            {{
              caption()
            }}
          </caption>
          <thead>
            <tr class="border-b border-(--border-strong)">
              <th
                scope="col"
                class="py-2 pe-4 text-start text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
              >
                {{ bucketHeading() }}
              </th>
              @for (label of seriesLabels(); track label) {
                <th
                  scope="col"
                  class="py-2 ps-4 text-end text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
                >
                  {{ label }}
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.bucket) {
              <tr class="border-b border-(--border-default)">
                <th scope="row" class="py-1.5 pe-4 text-start font-medium text-(--text-secondary)">
                  {{ row.bucket }}
                </th>
                @for (v of row.values; track $index) {
                  <td class="py-1.5 ps-4 text-end tabular-nums text-(--text-primary)">{{ v }}</td>
                }
              </tr>
            }
          </tbody>
          <tfoot>
            <tr class="border-t-2 border-(--border-strong)">
              <th
                scope="row"
                class="py-2 pe-4 text-start font-bold text-(--text-primary)"
                i18n="@@admin.catalog.additions.total"
              >
                Added in window
              </th>
              @for (t of totals(); track $index) {
                <td class="py-2 ps-4 text-end font-bold tabular-nums text-(--text-primary)">
                  {{ t }}
                </td>
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
      ? $localize`:@@admin.catalog.additions.captionMonth:Records added per calendar month, by type, over the last 12 UTC months. The current month is still filling.`
      : $localize`:@@admin.catalog.additions.caption:Records added per day, by type, over the last 30 UTC days.`,
  );
}
