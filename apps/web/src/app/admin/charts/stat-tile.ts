import { Component, computed, input } from '@angular/core';

import type { AdminDelta } from '@aeci/shared';

import { ChartDataTable } from './chart-data-table';
import { SeriesSparkline } from './series-sparkline';
import { formatThousands } from './format';
import type { ChartSeries, ChartSlot } from './chart-types';

/**
 * What a tile shows when it has no figure. §5.1: "`null` renders as *Not
 * measured*, never as zero" — and the wording is the spec's own. Module-level so
 * every tile says it identically, and a `$localize` string rather than a glyph
 * so it translates.
 */
const NOT_MEASURED_LABEL = $localize`:@@admin.stat.notMeasured:Not measured`;

/**
 * Stat tile — AECI-578 / Phase 8.3 P1.4. The `dataviz` contract: `label` ·
 * `value` · `delta` · `sparkline`, in that order and no more.
 *
 * The skill's form heuristic says a single current value with a trend is a stat
 * tile, **not a one-bar bar chart** — which is what the §5.3 headline numbers
 * (human views, bot views, unique visitors) are.
 *
 * ─── The delta is structured, and the prose is this component's ──────────────
 *
 * `AdminDelta` crosses the wire as `{ current, prior, diff, pct }` rather than as
 * the digest email's sentence, because §9.4's i18n rule is unconditional — the
 * semantics are shared with the email, the strings belong to the UI
 * (`packages/shared/src/api/admin-panel.ts`). `pct` is null when `prior` is 0,
 * because a percentage against zero is meaningless; the email omits it in the
 * same case and so does this tile.
 *
 * **Direction is never colour-alone.** The delta carries an arrow glyph and a
 * signed number, and its accessible text spells out "up"/"down" in words. Green-
 * for-up would also be wrong on this page: a rise in *bot* traffic is not good
 * news, and the tile has no way to know which measure it is showing. So the delta
 * is rendered in text tokens and states the direction rather than judging it.
 *
 * ─── The caveat slot ─────────────────────────────────────────────────────────
 *
 * `caveat` renders directly beneath the value. §9.8 requires the visitor
 * definition to appear *"next to the number in the UI, not only in the spec"* —
 * this is the slot that obligation lands in, which is why it is a first-class
 * input rather than something the page tacks on afterwards.
 */
@Component({
  selector: 'aec-stat-tile',
  imports: [ChartDataTable, SeriesSparkline],
  template: `
    <div
      class="flex h-full flex-col gap-1 rounded-(--radius-lg) border border-(--border-default)
        bg-(--surface-raised) p-4"
    >
      <p class="text-sm text-(--text-secondary)">{{ label() }}</p>

      <p class="font-display text-3xl font-semibold tabular-nums text-(--text-primary)">
        {{ formattedValue() }}
      </p>

      @if (caveat()) {
        <p class="text-xs leading-snug text-(--text-secondary)">{{ caveat() }}</p>
      }

      @if (delta(); as d) {
        <p class="mt-0.5 flex items-baseline gap-1 text-xs text-(--text-secondary)">
          <span aria-hidden="true">{{ deltaGlyph() }}</span>
          <span aria-hidden="true" class="font-semibold tabular-nums text-(--text-primary)">{{
            deltaText()
          }}</span>
          <span class="sr-only">{{ deltaAccessibleText() }}</span>
          <span>{{ deltaSuffix() }}</span>
        </p>
      }

      @if (series().length > 0) {
        <div class="mt-auto pt-3">
          <aec-series-sparkline [values]="series()" [slot]="slot()" />
        </div>
        <!-- The sparkline is aria-hidden (it restates the value beside it), so
             the series it draws is carried here instead. -->
        <aec-chart-data-table
          [caption]="tableCaption()"
          [categoryHeader]="categoryHeader()"
          [categories]="categories()"
          [series]="tableSeries()"
        />
      }
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class StatTile {
  readonly label = input.required<string>();
  /**
   * The count. `null` means **not measured**, which is not the same claim as
   * zero, and renders as {@link NOT_MEASURED_LABEL} rather than as a figure
   * (§5.1). Words rather than a dash: a glyph is untranslatable and the brand
   * voice bars the em dash outright (PRODUCT.md), so "Not measured" is both the
   * clearer and the only compliant rendering (AECI-586).
   */
  readonly value = input<number | null>(null);
  /**
   * A pre-formatted value that replaces {@link value} entirely. For measures that
   * are not counts — a rate, a percentage — where `formatThousands` would be
   * wrong. The caller owns the formatting *and* its empty case, because only the
   * caller knows whether an absent rate should read as an em dash or as something
   * more specific (AECI-586).
   */
  readonly valueText = input<string>('');
  /** The §9.8-style definition that must sit next to the number. */
  readonly caveat = input<string>('');
  readonly delta = input<AdminDelta | null>(null);
  /** Localized, e.g. "vs. the previous day". */
  readonly deltaSuffix = input<string>('');
  /** Sparkline series; empty hides both the sparkline and its table. */
  readonly series = input<readonly number[]>([]);
  readonly categories = input<readonly string[]>([]);
  readonly categoryHeader = input<string>('');
  readonly tableCaption = input<string>('');
  readonly slot = input<ChartSlot>(1);

  protected readonly formattedValue = computed(() => {
    const override = this.valueText();
    if (override) return override;
    const v = this.value();
    return v === null ? NOT_MEASURED_LABEL : formatThousands(v);
  });

  /** Text tokens only — direction is stated, never judged by colour. */
  protected readonly deltaGlyph = computed(() => {
    const d = this.delta();
    if (!d || d.diff === 0) return '→';
    return d.diff > 0 ? '↑' : '↓';
  });

  protected readonly deltaText = computed(() => {
    const d = this.delta();
    if (!d) return '';
    const magnitude = formatThousands(Math.abs(d.diff));
    // `pct` is null when `prior` is 0 — the same case the digest email omits it,
    // because "+100% of nothing" is not a fact about the world.
    return d.pct === null ? magnitude : `${magnitude} (${Math.abs(d.pct)}%)`;
  });

  /** The glyph is `aria-hidden`, so direction has to reach a screen reader as a
   *  word. Composed in TS rather than the template because an interpolated
   *  `i18n-*` attribute emits no attribute at all in this app (AECI-166). */
  protected readonly deltaAccessibleText = computed(() => {
    const d = this.delta();
    if (!d) return '';
    if (d.diff === 0) return $localize`:@@admin.traffic.delta.flat:unchanged`;
    const amount = this.deltaText();
    return d.diff > 0
      ? $localize`:@@admin.traffic.delta.up:up ${amount}:AMOUNT:`
      : $localize`:@@admin.traffic.delta.down:down ${amount}:AMOUNT:`;
  });

  protected readonly tableSeries = computed<ChartSeries[]>(() => [
    { key: 'value', label: this.label(), slot: this.slot(), values: this.series() },
  ]);
}
