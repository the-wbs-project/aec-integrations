import { z } from 'zod';

/**
 * The reason an admin gives for a write that changes vendor-held state
 * (AECI-1191): the logo overwrite and the seat revoke. Recorded in the audit
 * row's `metadata.reason`, in the same batch as the change.
 *
 * Same cap and shape as the retire reason (`ADMIN_RETIRE_REASON_MAX`). Trimmed,
 * so a whitespace-only reason is refused as blank.
 */
export const ADMIN_REASON_MAX = 1000;

export const AdminReasonSchema = z.string().trim().min(1).max(ADMIN_REASON_MAX);

// ─── AECi overrides: the vendor reason and the internal note (AECI-1159) ─────

/**
 * The marker that makes an audit row's `metadata.reason` readable by a vendor
 * (AECI-1159, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d). **A row without it is never
 * shown to a vendor.** That covers every row written before AECI-1159, whose
 * reasons were written for AECi alone. AECI-1194's change history reads this exact
 * key and value, so neither may be renamed.
 */
export const REASON_VISIBILITY_VENDOR = 'vendor' as const;

/**
 * The optional internal note beside a vendor reason. Never shown to a vendor and
 * never copied onto a notification row. Trimmed; blank or `null` reads as absent.
 */
export const AdminInternalNoteSchema = z
  .string()
  .trim()
  .max(ADMIN_REASON_MAX)
  .nullable()
  .optional()
  .transform((value) => (value ? value : undefined));

/**
 * The body fields of every AECi override of a vendor-held record (AECI-1159): admin
 * retire and restore, the admin logo overwrite and the seat revoke. The contest
 * accept that overwrites an owner's field takes the same pair, with the existing
 * `note` as the reason (`AdminDecideContestSchema`).
 *
 *   - `reason` is required, 1 to 1,000 characters, and shown to the vendor.
 *   - `internalNote` is optional and never shown to the vendor.
 */
export const AdminOverrideReasonSchema = z.object({
  reason: AdminReasonSchema,
  internalNote: AdminInternalNoteSchema,
});
export type AdminOverrideReason = z.infer<typeof AdminOverrideReasonSchema>;

/** What an override's audit row adds to `metadata`, in the same batch as the write. */
export type VendorVisibleReasonMetadata = {
  reason: string;
  reasonVisibility: typeof REASON_VISIBILITY_VENDOR;
  internalNote?: string;
};

/**
 * The `metadata` keys an override writes: the reason, the vendor-visibility marker,
 * and the internal note when one was given. Spread into the audit row's metadata.
 */
export function vendorVisibleReasonMetadata(input: {
  reason: string;
  internalNote?: string | null;
}): VendorVisibleReasonMetadata {
  return {
    reason: input.reason,
    reasonVisibility: REASON_VISIBILITY_VENDOR,
    ...(input.internalNote ? { internalNote: input.internalNote } : {}),
  };
}

/**
 * The reason a vendor may read on a stored row, or `null`. Only a row that carries
 * the {@link REASON_VISIBILITY_VENDOR} marker yields one. Tolerant of any shape,
 * because audit rows outlive the code that wrote them. Never returns the internal
 * note.
 */
export function vendorVisibleReason(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const { reason, reasonVisibility } = metadata as Record<string, unknown>;
  if (reasonVisibility !== REASON_VISIBILITY_VENDOR) return null;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null;
}
