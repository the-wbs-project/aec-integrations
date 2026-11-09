import type { FieldCaption, FieldCorrection } from '@aeci/shared';

/**
 * Pure picks over the caption payload (AECI-1614), Angular-free so the lane grouping and
 * its plain Vitest spec can use them. The server decides every caption's form and date
 * (`apps/api/src/lib/field-captions.ts`). These only choose which one to show.
 */

/** An unparseable date sorts last, and the component then renders nothing for it. */
function instant(date: string): number {
  const at = Date.parse(date);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** The correction on `field`, or `null`. The API sends at most one per field. */
export function correctionFor(
  corrections: readonly FieldCorrection[] | null | undefined,
  field: string,
): FieldCorrection | null {
  return corrections?.find((c) => c.field === field) ?? null;
}

/**
 * The correction to show in one value's slot (AECI-1628). A correction that set a value
 * sits under that value, so it shows while the value is `present`. One that cleared the
 * value sits in the empty slot, so it shows while the value is absent. The server already
 * drops a correction the live value no longer matches; this keeps a page from captioning
 * a value it did not render, or a gap it filled with something else.
 */
export function correctionInSlot(
  corrections: readonly FieldCorrection[] | null | undefined,
  field: string,
  present: boolean,
): FieldCorrection | null {
  const correction = correctionFor(corrections, field);
  if (!correction) return null;
  return present !== !!correction.cleared ? correction : null;
}

/**
 * The newest correction in the list. A table row may not show the corrected field, so it
 * carries one generic caption. A tie keeps the earlier entry, so the pick is stable.
 */
export function newestCorrection(
  corrections: readonly FieldCorrection[] | null | undefined,
): FieldCorrection | null {
  let newest: FieldCorrection | null = null;
  for (const correction of corrections ?? []) {
    if (!newest || instant(correction.date) > instant(newest.date)) newest = correction;
  }
  return newest;
}

/**
 * The newer of two captions, for a Via row that collapses several edges into one row
 * (`STAGE_1_5_SPEC.md` §13.3). A collapsed row has one line, and the pair page shows each
 * edge's own caption. A tie keeps `a`.
 */
export function newestCaption(
  a: FieldCaption | null | undefined,
  b: FieldCaption | null | undefined,
): FieldCaption | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return instant(b.date) > instant(a.date) ? b : a;
}
