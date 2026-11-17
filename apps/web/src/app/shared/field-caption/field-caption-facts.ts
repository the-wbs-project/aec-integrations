/**
 * Pure picks over the caption payload, Angular-free so a plain Vitest spec can use them.
 *
 * AECI-1666 moved every caption and correction into the page's one "About this listing"
 * panel. The panel still names only what the page renders (§4.5.8): a correction on a field
 * the page never shows, or a removal whose slot something else fills, points at nothing.
 * {@link correctionsInSlots} and {@link countUnderReview} hold that rule for every page.
 */
import type { FieldCorrection } from '@aeci/shared';

/**
 * The corrections a page can point at (AECI-1666, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8).
 * `slots` names every field the page renders a slot for, and says whether its value shows
 * now. A correction that set a value is listed while the value shows. One that cleared it
 * (`cleared`) is listed while the slot is empty. A field missing from `slots` has no slot
 * on the page, so it is left out. Leave out a slot that something else fills, such as a
 * curated link a vendor's own link replaces.
 */
export function correctionsInSlots(
  corrections: readonly FieldCorrection[] | null | undefined,
  slots: Readonly<Record<string, boolean>>,
): FieldCorrection[] {
  return (corrections ?? []).filter(
    (correction) =>
      Object.hasOwn(slots, correction.field) && slots[correction.field] !== !!correction.cleared,
  );
}

/**
 * How many hidden values the page marks "Under review" (AECI-1666). `marked` is the list
 * of fields the page mounts an `aec-under-review` marker for. A hidden field the page never
 * renders has no marker, so the panel's count leaves it out.
 */
export function countUnderReview(
  underReview: readonly string[] | null | undefined,
  marked: readonly string[],
): number {
  return (underReview ?? []).filter((field) => marked.includes(field)).length;
}

/**
 * Whether AECi has hidden `field` on this record while it checks it (AECI-1238, §11d.7).
 * The API sends the value as `null` and lists the field in `under_review`. Tolerates an
 * absent list, which an older API sends.
 */
export function isUnderReview(
  underReview: readonly string[] | null | undefined,
  field: string,
): boolean {
  return !!underReview?.includes(field);
}
