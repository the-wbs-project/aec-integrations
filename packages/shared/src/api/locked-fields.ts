import { z } from 'zod';

/**
 * The vendor read side of AECI-1237's field locks. A leaf module: `./vendor` and
 * `./vendor-attestations` import it, and `./field-overrides` (which imports
 * `./vendor`) re-exports it.
 */

/**
 * One locked field on a vendor read (`locked_fields`): which field, AECi's
 * vendor-visible reason, and when. Never the internal note. `field` is the wire
 * name the record's own PATCH uses.
 */
export const LockedFieldSchema = z.object({
  field: z.string(),
  reason: z.string(),
  set_at: z.string(),
});
export type LockedField = z.infer<typeof LockedFieldSchema>;

/**
 * `locked_fields` on `VendorAccount`, `VendorProduct` and the two integration
 * entries. Optional so a client still parses an API that predates AECI-1237; absent
 * reads as "nothing locked", and the server refuses a locked write regardless.
 */
export const LockedFieldsSchema = z.array(LockedFieldSchema).optional();

/** The lock on `field`, or `undefined`. Tolerates an absent list. */
export function lockedField(
  locked: readonly LockedField[] | undefined,
  field: string,
): LockedField | undefined {
  return locked?.find((entry) => entry.field === field);
}
