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
 *
 * `reason` is set only for the vendor holding the lock, its `vendor_id` (AECI-1668,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5). Any other vendor that sees the record gets
 * `null`, as for a value hide (§11d.7). `source_url` reaches every viewer.
 */
export const LockedFieldSchema = z.object({
  field: z.string(),
  reason: z.string().nullable(),
  set_at: z.string(),
  /** Where AECi read the value (AECI-1614). `null` on an older correction. The public
   *  page shows it too, so the vendor sees what readers see. Optional for deploy skew. */
  source_url: z.string().nullable().optional(),
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
