import type { AdminClassificationPoint, AdminTrafficClass } from '@aeci/shared';

import type { NotComparableReason } from './stat-tile';

/**
 * AECI-1346 — the four D19 traffic classes as the Overview draws them, in one
 * place so the classes card and the 30-day chart cannot disagree on order, name
 * or colour.
 *
 * **Order** is `ADMIN_PANEL_SPEC.md` §13 D19(b)'s: identified automation,
 * suspected automation, browser activity with supporting human evidence,
 * unresolved. The chart stacks in the same order, series 0 on the baseline.
 */
export const TRAFFIC_CLASS_ORDER: readonly AdminTrafficClass[] = [
  'identified_automation',
  'suspected_automation',
  'browser_with_human_evidence',
  'unresolved',
];

/**
 * One fill per class, from existing brand tokens rather than the `.aec-charts`
 * series palette, whose slots 1 and 2 are reserved for human and bot.
 *
 * Contrast, measured (WCAG relative luminance) against `--surface-base` #FFFFFF
 * and `--surface-raised` #FAFAFA, and between each pair that touches in a stack:
 *
 * | Class | Token | On white | On raised |
 * |---|---|---|---|
 * | identified automation | `--text-secondary` #52525B | 7.73 | 7.41 |
 * | suspected automation | `--border-input` #8A8A93 | 3.42 | 3.28 |
 * | human evidence | `--accent-primary` #1E3A2F | 12.34 | 11.82 |
 * | unresolved | `--accent-secondary-deep` #A14D22 | 5.83 | 5.59 |
 *
 * Adjacent pairs: identified/suspected 2.26 (same hue, lightness step),
 * suspected/human 3.61 (neutral against green, lightness step), human/unresolved
 * 2.12 (green against clay, lightness step). Every pair differs in hue or
 * lightness, so no pair rests on colour perception alone, and the visible legend
 * plus the hidden table carry every number regardless.
 *
 * The two automation classes share the neutral family on purpose: they are the
 * traffic the operator discounts. Forest marks the class the brand cares about,
 * and Clay-deep, the warning hue, marks what is still unexplained.
 */
export const TRAFFIC_CLASS_FILLS: Readonly<Record<AdminTrafficClass, string>> = {
  identified_automation: 'var(--text-secondary)',
  suspected_automation: 'var(--border-input)',
  browser_with_human_evidence: 'var(--accent-primary)',
  unresolved: 'var(--accent-secondary-deep)',
};

/** The localized name of a class. Whole names, one message each. */
export function trafficClassLabel(cls: AdminTrafficClass): string {
  switch (cls) {
    case 'identified_automation':
      return $localize`:@@admin.overview.classes.identified:Identified automation`;
    case 'suspected_automation':
      return $localize`:@@admin.overview.classes.suspected:Suspected automation`;
    case 'browser_with_human_evidence':
      return $localize`:@@admin.overview.classes.humanEvidence:Browser activity with supporting human evidence`;
    case 'unresolved':
      return $localize`:@@admin.overview.classes.unresolved:Unresolved`;
  }
}

/**
 * Why the class `delta_day`s are null, read from the 30-day series (AECI-1346).
 * The API nulls them for three reasons and does not say which. The series does:
 * the reported day and the prior day are its last two points.
 *
 * Checked in the order the API's `classDeltaBlocker` treats them as decisive: an
 * unclassified prior day has nothing to compare, a version change makes the two
 * days different measurements, and a non-comparable §3d row counts different
 * rows. Returns undefined when the series cannot tell, so the line says only "Not
 * comparable" rather than guessing a cause.
 */
export function classDeltaReason(
  series: readonly AdminClassificationPoint[],
  day: string,
): NotComparableReason | undefined {
  const i = series.findIndex((p) => p.day === day);
  if (i < 1) return undefined;
  const today = series[i]!;
  const prior = series[i - 1]!;
  if (prior.classifier_version === null) return 'prior_not_classified';
  if (today.classifier_version !== prior.classifier_version) return 'classifier_changed';
  if (
    today.method_change?.arrivals_comparable === false ||
    prior.method_change?.arrivals_comparable === false
  ) {
    return 'method_changed';
  }
  return undefined;
}
