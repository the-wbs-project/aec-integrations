import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { AdminDelta } from '@aeci/shared';

import { Sparkline } from '../charts/sparkline';

/** A delta plus the period it covers. The period picks the localized phrasing;
 *  the arithmetic is entirely the API's (`computeDelta`, shared with the digest
 *  email's `deltaText` — §6 P1.1 note 1). Nothing is re-derived here. */
export interface StatTileDelta {
  /** Null when the API declined to compare the two periods (AECI-1346). Rendered
   *  as a "Not comparable" line, never dropped and never drawn as no change. */
  delta: AdminDelta | null;
  period: 'day' | 'week';
  /** Why `delta` is null, when the page can tell. Absent = say only that the two
   *  periods are not comparable. Ignored when `delta` is present. */
  notComparable?: NotComparableReason;
}

/**
 * Why a delta is null (AECI-1346). Each is a different fact about the data, so the
 * line names it: the email's "not comparable with the prior day (classifier
 * changed)" wording, localized.
 *
 * - `classifier_changed`: the two days carry different classifier versions (D19(c)).
 * - `method_changed`: a non-comparable `POST_LAUNCH_MONITORING.md` §3d
 *   collection-method change falls between them.
 * - `prior_not_classified`: the prior day has no classified rows to compare with.
 */
export type NotComparableReason = 'classifier_changed' | 'method_changed' | 'prior_not_classified';

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
 * `deltas` renders only what the API actually returned. A delta the API
 * returned as null (AECI-1346) renders as a "Not comparable" line with its reason. The P1.1 payload carries a
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
      <p class="text-sm text-pretty text-(--text-secondary)">{{ label() }}</p>

      <p class="font-display text-4xl font-semibold tabular-nums text-(--accent-primary)">
        {{ value() | number }}
      </p>

      @if (sparklineValues().length > 0) {
        <aec-sparkline [values]="sparklineValues()" [label]="sparklineLabel()" />
      }

      @if (deltaLines().length > 0) {
        <ul role="list" class="space-y-0.5">
          @for (d of deltaLines(); track d.period) {
            <li class="text-sm text-pretty tabular-nums text-(--text-secondary)">{{ d.text }}</li>
          }
        </ul>
      }

      <p class="mt-auto pt-1 text-xs leading-relaxed text-pretty text-(--text-secondary)">
        {{ caption() }}
      </p>
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
    this.deltas().map((d) => ({ period: d.period, text: statDeltaText(d) })),
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
export function statDeltaText({ delta, period, notComparable }: StatTileDelta): string {
  if (delta === null) return notComparableText(period, notComparable);
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

/**
 * The "Not comparable" line for a null delta (AECI-1346). One message per reason
 * and period rather than an interpolated reason, so a translator sees whole
 * sentences. Only the reasons that can occur for a period have a variant: a
 * 7-day delta is only ever suppressed by a collection-method change.
 */
function notComparableText(period: 'day' | 'week', reason?: NotComparableReason): string {
  if (period === 'week') {
    return reason === 'method_changed'
      ? $localize`:@@admin.stat.delta.notComparable.week.method:Not comparable with the prior 7 days (collection method changed)`
      : $localize`:@@admin.stat.delta.notComparable.week:Not comparable with the prior 7 days`;
  }
  switch (reason) {
    case 'classifier_changed':
      return $localize`:@@admin.stat.delta.notComparable.day.classifier:Not comparable with the prior day (classifier changed)`;
    case 'method_changed':
      return $localize`:@@admin.stat.delta.notComparable.day.method:Not comparable with the prior day (collection method changed)`;
    case 'prior_not_classified':
      return $localize`:@@admin.stat.delta.notComparable.day.priorNotClassified:Not comparable with the prior day (prior day not classified)`;
    default:
      return $localize`:@@admin.stat.delta.notComparable.day:Not comparable with the prior day`;
  }
}
