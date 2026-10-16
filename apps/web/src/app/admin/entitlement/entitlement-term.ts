import { formatTermDate } from '../../shared/term-date/format-term-date';

/**
 * The full term sentence. The date itself goes through `formatTermDate`
 * (`shared/term-date/format-term-date.ts`, Paid Tiers §5.8).
 *
 * A `null` `period_end` is PERPETUAL — what the §2.4 backfill wrote — and never
 * "unknown", so it must not render as a blank.
 */
export function entitlementTermLabel(periodEnd: string | null, locale: string): string {
  if (!periodEnd) return $localize`:@@admin.claims.ent.termPerpetual:No end date on record`;
  const date = formatTermDate(periodEnd, locale);
  return $localize`:@@admin.claims.ent.termEnds:Term ends ${date}:DATE:`;
}
