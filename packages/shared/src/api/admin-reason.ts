import { z } from 'zod';

/**
 * The reason an admin gives for a write that changes vendor-held state
 * (AECI-1191): the logo overwrite and the seat revoke. Recorded in the audit
 * row's `metadata.reason`, in the same batch as the change. AECI-1159 shows it
 * to the vendor, so it is written for them to read.
 *
 * Same cap and shape as the retire reason (`ADMIN_RETIRE_REASON_MAX`). Trimmed,
 * so a whitespace-only reason is refused as blank.
 */
export const ADMIN_REASON_MAX = 1000;

export const AdminReasonSchema = z.string().trim().min(1).max(ADMIN_REASON_MAX);
