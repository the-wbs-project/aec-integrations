import { z } from 'zod';

import { AdminReasonSchema } from './admin-reason';

/**
 * Litigation holds (AECI-1638, counsel Q23a, ADR 0058). Source of truth:
 * `ADMIN_PANEL_SPEC.md` §5.22b, `API_CONTRACTS.md` §6.10 "Litigation holds",
 * `DATABASE_SCHEMA.md` §8.15 (`litigation_holds`).
 *
 *   GET  /api/admin/litigation-holds               behind `requireAdmin()`. A read: never rate-limited.
 *   POST /api/admin/litigation-holds               behind `requireAdmin()` then `rateLimit('write')`.
 *   POST /api/admin/litigation-holds/:id/release   the same guard and limiter.
 *
 * An open hold stops the legal retention prune (`apps/api/src/lib/legal-retention-prune.ts`).
 * A vendor hold keeps that vendor's `audit_log` rows (`auditRowOfVendor` says which rows are
 * a vendor's) and its acceptance and grant records. Every other row goes on schedule (ruling
 * 55, AECI-1970). A global hold keeps everything. Never public.
 */

// ─── Retention periods (Privacy Policy "Retention") ──────────────────────────

/**
 * `audit_log` rows are kept for four years after the action: 1,461 days, the same span as
 * the R2 `evidence/` lock (ADR 0056). A legal period, so it has no env override.
 */
export const AUDIT_LOG_RETENTION_DAYS = 1461;

/** An acceptance record is kept for six calendar years after the vendor account ends. */
export const ACCEPTANCE_RETENTION_YEARS_AFTER_ACCOUNT_END = 6;

/** A grant and its acceptance are kept for five calendar years after the grant ends. */
export const GRANT_RETENTION_YEARS_AFTER_END = 5;

/**
 * A hold open longer than this many days gets a reminder to the operator (AECI-1638), so a
 * hold nobody remembers does not keep records past their promised period. Sent by the
 * daily legal retention job as `litigation-hold-reminder`.
 */
export const LITIGATION_HOLD_REMINDER_AFTER_DAYS = 90;

/** At most one reminder per hold in this many days. */
export const LITIGATION_HOLD_REMINDER_EVERY_DAYS = 30;

/**
 * The `audit_log` actions the four-year prune never deletes (Chris's ruling 2 of
 * 2026-11-17). Exact actions first, then prefixes. `retention.pruned` rows are read with no
 * date bound by the acceptance chain verify (ADR 0057). The others prove an acceptance
 * record, so they follow it: an `agreement.*` row whose acceptance the legal prune deletes
 * goes in the same batch, and a `terms.*` row goes with its Terms acceptance (AECI-1718).
 * An `agreement.*` or `terms.*` row that no acceptance record names is not kept forever: the
 * legal prune's orphan part deletes it four years after the action (ruling 60, AECI-1971,
 * `orphanAcceptanceAuditPredicate`). These lists exempt it from the four-year part only.
 * Two more actions are exempt on a condition, so they are not in these lists:
 * `vendor.deleted` (AECI-1914), while its vendor row is gone and an acceptance or grant still
 * names that vendor, and `account.deleted` (AECI-1718), while a `terms_acceptances` row still
 * names that profile. `auditPrunePredicate` in `apps/api/src/lib/legal-retention-prune.ts`
 * holds both tests, and {@link isAuditLogPruneExempt} does not.
 */
export const AUDIT_LOG_PRUNE_EXEMPT_ACTIONS = ['retention.pruned'] as const;
export const AUDIT_LOG_PRUNE_EXEMPT_PREFIXES = [
  'litigation_hold.',
  'agreement.',
  'terms.',
] as const;

/** True when the four-year prune keeps this action whatever its age. */
export function isAuditLogPruneExempt(action: string): boolean {
  return (
    (AUDIT_LOG_PRUNE_EXEMPT_ACTIONS as readonly string[]).includes(action) ||
    AUDIT_LOG_PRUNE_EXEMPT_PREFIXES.some((prefix) => action.startsWith(prefix))
  );
}

// ─── The hold ────────────────────────────────────────────────────────────────

export const LITIGATION_HOLD_SCOPES = ['global', 'vendor'] as const;
export const LitigationHoldScopeSchema = z.enum(LITIGATION_HOLD_SCOPES);
export type LitigationHoldScope = z.infer<typeof LitigationHoldScopeSchema>;

export const LITIGATION_HOLD_MATTER_MAX = 200;

const IsoInstant = z.string().datetime();

export const CreateLitigationHoldRequestSchema = z
  .object({
    scope: LitigationHoldScopeSchema,
    /** Required on a `vendor` hold, refused on a `global` one. */
    vendor_id: z.string().trim().min(1).nullable().optional(),
    /** Internal. Why the hold is placed. */
    reason: AdminReasonSchema,
    /** The matter it serves: a Linear issue id, a case number. Optional. */
    matter_reference: z
      .string()
      .trim()
      .max(LITIGATION_HOLD_MATTER_MAX)
      .nullable()
      .optional()
      .transform((value) => (value ? value : null)),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'vendor' && !v.vendor_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['vendor_id'],
        message: 'A vendor hold names the vendor',
      });
    }
    if (v.scope === 'global' && v.vendor_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['vendor_id'],
        message: 'A global hold names no vendor',
      });
    }
  });
export type CreateLitigationHoldRequest = z.infer<typeof CreateLitigationHoldRequestSchema>;

export const ReleaseLitigationHoldRequestSchema = z.object({ reason: AdminReasonSchema });
export type ReleaseLitigationHoldRequest = z.infer<typeof ReleaseLitigationHoldRequestSchema>;

export const LitigationHoldSchema = z.object({
  id: z.string(),
  scope: LitigationHoldScopeSchema,
  vendor_id: z.string().nullable(),
  /** The vendor's company name, or null on a global hold or a vendor row that is gone. */
  vendor_name: z.string().nullable(),
  reason: z.string(),
  matter_reference: z.string().nullable(),
  placed_by: z.string(),
  placed_at: IsoInstant,
  released_at: IsoInstant.nullable(),
  released_by: z.string().nullable(),
  release_reason: z.string().nullable(),
});
export type LitigationHold = z.infer<typeof LitigationHoldSchema>;

/** How many released holds the list returns, newest first. */
export const LITIGATION_HOLDS_RELEASED_LIMIT = 20;

export const LitigationHoldsResponseSchema = z.object({
  generated_at: IsoInstant,
  /** Every open hold, newest first. */
  open: z.array(LitigationHoldSchema),
  /** The {@link LITIGATION_HOLDS_RELEASED_LIMIT} most recently released holds. */
  released: z.array(LitigationHoldSchema),
});
export type LitigationHoldsResponse = z.infer<typeof LitigationHoldsResponseSchema>;

export const LitigationHoldWriteResponseSchema = z.object({ hold: LitigationHoldSchema });
export type LitigationHoldWriteResponse = z.infer<typeof LitigationHoldWriteResponseSchema>;
