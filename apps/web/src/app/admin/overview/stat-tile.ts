import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { AdminDelta } from '@aeci/shared';

import { Sparkline } from '../charts/sparkline';

/** A delta plus the period it covers. The period picks the localized phrasing;
 *  the arithmetic is entirely the API's (`computeDelta`, shared with the digest
 *  email's `deltaText` — §6 P1.1 note 1). Nothing is re-derived here. */
export interface StatTileDelta {
  delta: AdminDelta;
  period: 'day' | 'week';
}

/**
 * AECI-576 / Phase 8.3 P1.2 — one Overview stat tile.
 *
 * Purely presentational. Inherits the card vocabulary the home stats cards
 * established (`home/home-stats-cards.ts`): bordered `--surface-raised`, border
 * not shadow, figure in Forest, `tabular-nums`. That is the Anchor-Site Rule doing
 * its job — §9.10 says the console inherits the existing surfaces' visual language
 * rather than picking a new anchor.
 *
 * **Resolution honesty (§9).** `caption` is required, not optional: every tile
 * states the window it covers, and where a figure carries a definitional caveat
 * (unique visitors — §9.8) that definition renders here, next to the number,
 * rather than hiding in a tooltip.
 *
 * `deltas` renders only what the API actually returned. The P1.1 payload carries a
 * 7-day delta for human page views and a day delta for new sign-ins; subscriber
 * and catalog totals are live snapshots with no delta at all. Computing a missing
 * delta client-side would fork the one implementation the email and the panel
 * share, so a tile with no delta simply shows none.
 */
@Component({
  selector: 'aec-stat-tile',
  imports: [DecimalPipe, Sparkline],
  template: `
    <div
      class="flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default)
        bg-(--surface-raised) p-5"
    >
      <p class="text-sm text-(--text-secondary)">{{ label() }}</p>

      <p class="font-display text-4xl font-semibold tabular-nums text-(--accent-primary)">
        {{ value() | number }}
      </p>

      @if (sparklineValues().length > 0) {
        <aec-sparkline [values]="sparklineValues()" [label]="sparklineLabel()" />
      }

      @if (deltaLines().length > 0) {
        <ul role="list" class="space-y-0.5">
          @for (d of deltaLines(); track d.period) {
            <li class="text-sm tabular-nums text-(--text-secondary)">{{ d.text }}</li>
          }
        </ul>
      }

      <p class="mt-auto pt-1 text-xs leading-relaxed text-(--text-secondary)">{{ caption() }}</p>
    </div>
  `,
  styles: [':host { display: block; height: 100%; }'],
})
export class StatTile {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  /** The window this figure covers, plus any definitional caveat. Required — a
   *  number without its resolution is the thing §9 exists to prevent. */
  readonly caption = input.required<string>();
  /** Only the deltas the API returned. Empty is a valid, honest state. */
  readonly deltas = input<readonly StatTileDelta[]>([]);
  /** Oldest-first trend series. Empty renders no sparkline. */
  readonly sparklineValues = input<readonly number[]>([]);
  readonly sparklineLabel = input('');

  protected readonly deltaLines = computed(() =>
    this.deltas().map((d) => ({ period: d.period, text: deltaText(d) })),
  );
}

/**
 * The digest's `deltaText` semantics, localized (§9.4 makes the strings ours; the
 * numbers stay the API's). Percentage is omitted exactly when `pct` is null — i.e.
 * when the prior period was 0 and a percentage would be meaningless — which is the
 * same case the email omits it in.
 *
 * The interpolated `change` fragment is symbols and digits only (`+8 (+18%)`), so
 * composing it into the sentence carries no untranslated words.
 */
function deltaText({ delta, period }: StatTileDelta): string {
  if (delta.diff === 0) {
    return period === 'day'
      ? $localize`:@@admin.stat.delta.none.day:No change vs the prior day`
      : $localize`:@@admin.stat.delta.none.week:No change vs the prior 7 days`;
  }

  const sign = delta.diff > 0 ? '+' : '−';
  const magnitude = Math.abs(delta.diff);
  const change =
    delta.pct === null
      ? `${sign}${magnitude}`
      : `${sign}${magnitude} (${sign}${Math.abs(delta.pct)}%)`;

  return period === 'day'
    ? $localize`:@@admin.stat.delta.day:${change}:CHANGE: vs ${delta.prior}:PRIOR: the prior day`
    : $localize`:@@admin.stat.delta.week:${change}:CHANGE: vs ${delta.prior}:PRIOR: the prior 7 days`;
}
