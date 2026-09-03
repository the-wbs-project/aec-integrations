import { formatDate } from '@angular/common';

/**
 * How an entitlement's term end is rendered, everywhere it is rendered
 * (AECI-694): the control on `/admin/vendors/:id`, the read-only copy on
 * `/admin/claims`, and the Term ends column on `/admin/vendors`.
 *
 * One implementation because those three surfaces show the same value, and the
 * §5.2/§5.3/§5.4 copy invariants around it are exactly the sentences whose
 * divergence produces an incident rather than a typo.
 *
 * ── `period_end` IS OFTEN A CALENDAR DATE, NOT AN INSTANT ────────────────────
 * `EntitlementTermDateSchema` is `z.union([z.string().date(), z.string().datetime()])`
 * and the admin form writes the date-only form, because it is an
 * `<input type="date">`. That distinction is load-bearing: `2027-09-01` handed
 * to `DatePipe` with a `'UTC'` timezone is parsed as LOCAL midnight and then
 * shifted, so west of UTC it renders as 31 August. A term that ends on the 1st
 * displayed as the 31st is a paperwork question nobody wants to have. So a
 * date-only value is pinned to UTC midnight first and a real instant is
 * formatted in UTC as-is, which is how every other timestamp in the console
 * reads.
 *
 * Before this the value was interpolated RAW ("Term ends 2026-11-30T00:00:00.000Z"),
 * so the bug did not exist and neither did the formatting.
 */

/** `YYYY-MM-DD` with no time component. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a term date for display. Falls back to the raw string rather than
 * throwing: `formatDate` throws on unparseable input, and this is a readout, not
 * a validator.
 */
export function formatTermDate(value: string, locale: string): string {
  try {
    const instant = DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value;
    return formatDate(instant, 'mediumDate', locale, 'UTC');
  } catch {
    return value;
  }
}

/**
 * The full term sentence.
 *
 * A `null` `period_end` is PERPETUAL — what the §2.4 backfill wrote — and never
 * "unknown", so it must not render as a blank.
 */
export function entitlementTermLabel(periodEnd: string | null, locale: string): string {
  if (!periodEnd) return $localize`:@@admin.claims.ent.termPerpetual:No end date on record`;
  const date = formatTermDate(periodEnd, locale);
  return $localize`:@@admin.claims.ent.termEnds:Term ends ${date}:DATE:`;
}
