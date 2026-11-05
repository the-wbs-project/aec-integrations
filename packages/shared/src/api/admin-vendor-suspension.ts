import { z } from 'zod';

import { AdminReasonSchema } from './admin-reason';

/**
 * Suspend, then terminate (AECI-1623, ruling 1 of 2026-11-05,
 * `VENDOR_SIGNUP_PROCESS.md` §2; `ADMIN_PANEL_SPEC.md` §5.7), behind `requireAdmin()`:
 *
 *   GET  /api/admin/vendors/:id/suspension                 state, history, refund preview
 *   POST /api/admin/vendors/:id/suspend                    locks every seat, sends the notice
 *   POST /api/admin/vendors/:id/suspension/resend-notice   retries an unconfirmed notice
 *   POST /api/admin/vendors/:id/suspension/stage-2         false-claim finding, second notice
 *   POST /api/admin/vendors/:id/suspension/cost-log        appends one cost entry
 *   POST /api/admin/vendors/:id/suspension/cost-log/:entryId/void
 *   POST /api/admin/vendors/:id/suspension/lift            cured or wrong
 *   POST /api/admin/vendors/:id/suspension/terminate       ends subscriptions, refunds
 *   POST /api/admin/vendors/:id/suspension/refunds/retry   retries failed refunds
 */

/**
 * Each stage's window, in business days (Monday to Friday, US federal holidays excluded),
 * from the first confirmed send of that stage's notice. No early path.
 */
export const VENDOR_SUSPENSION_WINDOW_BUSINESS_DAYS = 7;

/** Staff time on the abuse cost: $150 an hour is exactly 250 cents a minute. */
export const ABUSE_STAFF_CENTS_PER_MINUTE = 250;

export const VENDOR_SUSPENSION_KINDS = ['breach', 'false_claim'] as const;
export type VendorSuspensionKind = (typeof VENDOR_SUSPENSION_KINDS)[number];

export const VENDOR_SUSPENSION_RULE_MAX = 500;
export const VENDOR_SUSPENSION_EVIDENCE_MAX = 4000;

export const SuspendVendorRequestSchema = z.object({
  kind: z.enum(VENDOR_SUSPENSION_KINDS),
  /** Vendor-facing: named in the notice. */
  rule: z.string().trim().min(1).max(VENDOR_SUSPENSION_RULE_MAX),
  /** Vendor-facing: named in the notice. */
  evidence: z.string().trim().min(1).max(VENDOR_SUSPENSION_EVIDENCE_MAX),
  /** Internal. Never sent to the vendor. */
  reason: AdminReasonSchema,
});
export type SuspendVendorRequest = z.infer<typeof SuspendVendorRequestSchema>;

export const LiftVendorSuspensionRequestSchema = z.object({ reason: AdminReasonSchema });
export type LiftVendorSuspensionRequest = z.infer<typeof LiftVendorSuspensionRequestSchema>;

const costDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const costDescription = z.string().trim().min(1).max(300);

/**
 * One entry for the abuse cost log (counsel's Q13 follow-up): written at the time, by
 * task, and only for costs the breach caused. `recovery` is money recovered elsewhere,
 * credited against the cost. The server stamps when it was logged.
 */
export const AbuseCostEntryRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('staff'),
    work_date: costDate,
    description: costDescription,
    minutes: z.number().int().positive().max(100_000),
  }),
  z.object({
    kind: z.literal('third_party'),
    work_date: costDate,
    description: costDescription,
    amount_cents: z.number().int().positive().max(100_000_000),
  }),
  z.object({
    kind: z.literal('recovery'),
    work_date: costDate,
    description: costDescription,
    amount_cents: z.number().int().positive().max(100_000_000),
  }),
]);
export type AbuseCostEntryRequest = z.infer<typeof AbuseCostEntryRequestSchema>;

export const VoidAbuseCostEntryRequestSchema = z.object({ reason: AdminReasonSchema });
export type VoidAbuseCostEntryRequest = z.infer<typeof VoidAbuseCostEntryRequestSchema>;

export const AbuseCostEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['staff', 'third_party', 'recovery']),
  work_date: z.string(),
  description: z.string(),
  minutes: z.number().int().nullable(),
  amount_cents: z.number().int().nullable(),
  /** What the line counts for. Staff time at $150 an hour. A recovery is negative. */
  cents: z.number().int(),
  logged_at: z.string(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
});
export type AbuseCostEntry = z.infer<typeof AbuseCostEntrySchema>;

/** Opens stage 2: the false-claim finding stage 1 did not resolve. Vendor-facing. */
export const StartSuspensionStage2RequestSchema = z.object({
  finding: z.string().trim().min(1).max(VENDOR_SUSPENSION_EVIDENCE_MAX),
});
export type StartSuspensionStage2Request = z.infer<typeof StartSuspensionStage2RequestSchema>;

export const TerminateVendorRequestSchema = z.object({
  /** What each invoice-paid subscription actually paid. Stripe cannot say. */
  manual_payments: z
    .array(
      z.object({
        license_id: z.string().uuid(),
        paid_cents: z.number().int().nonnegative().max(100_000_000),
      }),
    )
    .max(500),
  /** The pre-cost refund on Stripe payments that the operator saw in the preview. */
  expected_gross_cents: z.number().int().nonnegative(),
  /** The cost total the operator saw, from the log. */
  expected_cost_cents: z.number().int().nonnegative(),
});
export type TerminateVendorRequest = z.infer<typeof TerminateVendorRequestSchema>;

export const VENDOR_TERMINATION_REFUND_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'manual',
] as const;
export type VendorTerminationRefundStatus = (typeof VENDOR_TERMINATION_REFUND_STATUSES)[number];

/** One payment on the statement. All money is integer cents. */
export const TerminationStatementPaymentSchema = z.object({
  key: z.string(),
  source: z.enum(['stripe', 'invoice']),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  paid_cents: z.number().int(),
  gross_cents: z.number().int(),
  cost_applied_cents: z.number().int(),
  refund_cents: z.number().int(),
});

export const TerminationStatementCostSchema = z.object({
  kind: z.enum(['staff', 'third_party', 'recovery']),
  date: z.string(),
  description: z.string(),
  minutes: z.number().int().nullable(),
  /** A recovery is negative: it is credited against the cost. */
  cents: z.number().int(),
  logged_at: z.string(),
});

/** The itemized statement. `cost_applied_cents` never exceeds `gross_cents`. */
export const TerminationStatementSchema = z.object({
  currency: z.string(),
  period_used_ends: z.string(),
  payments: z.array(TerminationStatementPaymentSchema),
  costs: z.array(TerminationStatementCostSchema),
  gross_cents: z.number().int(),
  cost_total_cents: z.number().int(),
  cost_applied_cents: z.number().int(),
  refund_cents: z.number().int(),
});
export type TerminationStatement = z.infer<typeof TerminationStatementSchema>;

export const VendorTerminationRefundSchema = z.object({
  id: z.string(),
  status: z.enum(VENDOR_TERMINATION_REFUND_STATUSES),
  refund_cents: z.number().int(),
  currency: z.string(),
  stripe_refund_id: z.string().nullable(),
});
export type VendorTerminationRefund = z.infer<typeof VendorTerminationRefundSchema>;

export const VendorSuspensionSchema = z.object({
  id: z.string(),
  kind: z.enum(VENDOR_SUSPENSION_KINDS),
  rule: z.string(),
  evidence: z.string(),
  reason: z.string(),
  suspended_at: z.string(),
  notice_sent_at: z.string().nullable(),
  /** `notice_sent_at` plus the window. Null until the notice is confirmed. */
  window_ends_at: z.string().nullable(),
  stage_2_finding: z.string().nullable(),
  stage_2_notice_sent_at: z.string().nullable(),
  stage_2_ends_at: z.string().nullable(),
  /** Stage 1 has elapsed and stage 2 has not started. */
  can_start_stage_2: z.boolean(),
  /** The applicable stage has elapsed. */
  can_terminate: z.boolean(),
  cost_log: z.array(AbuseCostEntrySchema),
  resolution: z.enum(['lifted', 'terminated']).nullable(),
  resolved_at: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  statement: TerminationStatementSchema.nullable(),
  refunds: z.array(VendorTerminationRefundSchema),
});
export type VendorSuspension = z.infer<typeof VendorSuspensionSchema>;

/** An invoice-paid subscription the operator must type an amount for. */
export const TerminationManualPaymentSchema = z.object({
  license_id: z.string(),
  reference: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
});

export const VendorTerminationPreviewSchema = z.object({
  /** False: Stripe could not be read, so Terminate would refuse. */
  available: z.boolean(),
  currency: z.string(),
  gross_cents: z.number().int(),
  /** The log's total, recoveries credited, floored at zero. */
  cost_total_cents: z.number().int(),
  payments: z.array(TerminationStatementPaymentSchema),
  manual_payments: z.array(TerminationManualPaymentSchema),
});
export type VendorTerminationPreview = z.infer<typeof VendorTerminationPreviewSchema>;

export const VendorSuspensionStateResponseSchema = z.object({
  /** The open suspension, or null. */
  open: VendorSuspensionSchema.nullable(),
  /** Every suspension, newest first, open included. */
  history: z.array(VendorSuspensionSchema),
  /** Present only with an open suspension. */
  preview: VendorTerminationPreviewSchema.nullable(),
});
export type VendorSuspensionStateResponse = z.infer<typeof VendorSuspensionStateResponseSchema>;

/** Every write answers with the suspension it changed. */
export const VendorSuspensionWriteResponseSchema = z.object({
  suspension: VendorSuspensionSchema,
  /** Suspend, stage 2 and resend: was the notice confirmed sent to at least one address? */
  notice_sent: z.boolean().optional(),
});
export type VendorSuspensionWriteResponse = z.infer<typeof VendorSuspensionWriteResponseSchema>;

/** `details` on `403 VENDOR_SUSPENDED`: enough for the portal's notice screen. */
export const VendorSuspendedDetailsSchema = z.object({
  vendor_slug: z.string(),
  vendor_name: z.string(),
});
export type VendorSuspendedDetails = z.infer<typeof VendorSuspendedDetailsSchema>;
