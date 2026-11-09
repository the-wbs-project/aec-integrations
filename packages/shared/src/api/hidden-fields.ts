import { z } from 'zod';

/**
 * The read side of the AECI-1238 value hide (§11d.7). A leaf module: `./vendor`,
 * `./vendor-attestations` and the public shapes import it, and `./field-hides`
 * re-exports it.
 */

/**
 * One hidden field on a vendor read (`hidden_fields`): which field, AECi's
 * vendor-visible reason, when, and the public source AECi received. Never the internal
 * note. `field` is the wire name the record's own PATCH uses. The field stays
 * editable: saving a change to it ends the hide.
 */
export const HiddenFieldSchema = z.object({
  field: z.string(),
  reason: z.string(),
  set_at: z.string(),
  source_url: z.string(),
});
export type HiddenField = z.infer<typeof HiddenFieldSchema>;

/**
 * `hidden_fields` on `VendorAccount`, `VendorProduct` and the two integration entries.
 * Optional so a client still parses an API that predates AECI-1238; absent reads as
 * "nothing hidden".
 */
export const HiddenFieldsSchema = z.array(HiddenFieldSchema).optional();

/** The hide on `field`, or `undefined`. Tolerates an absent list. */
export function hiddenField(
  hidden: readonly HiddenField[] | undefined,
  field: string,
): HiddenField | undefined {
  return hidden?.find((entry) => entry.field === field);
}

/**
 * `under_review` on the public shapes: the wire names of the fields AECi has hidden
 * while it checks them. Each one's value is `null` on the same payload, and the page
 * renders the "Under review" marker in its slot. Nothing else of the hide is public: no
 * reason, note, source or date. Sorted, so a cached page is byte-stable. Optional for
 * SSR/API deploy skew: absent reads as nothing under review.
 */
export const UnderReviewSchema = z.array(z.string()).optional();
