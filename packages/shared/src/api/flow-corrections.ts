import { z } from 'zod';

import { AGREEMENT_STATES } from '../agreement';
import { AdminInternalNoteSchema, AdminReasonSchema } from './admin-reason';
import { HttpsUrlSchema } from './https-url';

/**
 * AECi corrects one data flow on a claimed Sync Service pair (AECI-2139,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §14.10, `ADMIN_PANEL_SPEC.md` §5.12,
 * `API_CONTRACTS.md` §6.15c).
 *
 * The owner of a claimed Sync Service pair maintains its data flows. When a verifiable
 * public source shows one flow is wrong, AECi removes it, or moves it to the right
 * direction. The rest of the integration stays listed. The owner is told why and cannot
 * undo the correction. Only an admin lift ends it.
 */

/** A flow's direction in the row's own A/B frame (`claims.direction`). */
export const FLOW_CORRECTION_DIRECTIONS = ['a_to_b', 'b_to_a', 'both'] as const;
export type FlowCorrectionDirection = (typeof FLOW_CORRECTION_DIRECTIONS)[number];

/** `remove` takes the flow off every public page. `redirect` also lists it the right way. */
export const FLOW_CORRECTION_ACTIONS = ['remove', 'redirect'] as const;
export type FlowCorrectionAction = (typeof FLOW_CORRECTION_ACTIONS)[number];

/**
 * `POST /api/admin/flows/:claimId/correction`. `direction` is required for a
 * `redirect` and refused on a `remove`. The source is the public page AECi read; it is
 * required, as on every AECi correction (§4.5.8).
 */
export const AdminCorrectFlowSchema = z
  .object({
    action: z.enum(FLOW_CORRECTION_ACTIONS),
    direction: z.enum(FLOW_CORRECTION_DIRECTIONS).optional(),
    sourceUrl: HttpsUrlSchema,
    reason: AdminReasonSchema,
    internalNote: AdminInternalNoteSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action === 'redirect' && body.direction === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'Choose the direction the data really flows',
      });
    }
    if (body.action === 'remove' && body.direction !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'A removal takes no direction',
      });
    }
  });
export type AdminCorrectFlowInput = z.input<typeof AdminCorrectFlowSchema>;

/** `POST /api/admin/flow-corrections/:id/lift`: the reason the owner reads. */
export const AdminLiftFlowCorrectionSchema = z.object({ reason: AdminReasonSchema }).strict();
export type AdminLiftFlowCorrectionInput = z.input<typeof AdminLiftFlowCorrectionSchema>;

/** One correction, as the admin panel reads it. The internal note is here. */
export const AdminFlowCorrectionSchema = z.object({
  id: z.string().uuid(),
  claim_id: z.string().uuid(),
  /** The corrected-direction claim, or `null` for a removal. */
  replacement_claim_id: z.string().uuid().nullable(),
  /** The row the flow is on, and which table holds it. */
  anchor_id: z.string().uuid(),
  anchor: z.enum(['integration', 'evidenced_pair']),
  integration_name: z.string().nullable(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  /** The corrected flow's direction, in the row's A/B frame. */
  direction: z.enum(FLOW_CORRECTION_DIRECTIONS),
  /** The replacement's direction, or `null` for a removal. */
  replacement_direction: z.enum(FLOW_CORRECTION_DIRECTIONS).nullable(),
  source_url: z.string(),
  reason: z.string(),
  internal_note: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  retracted_at: z.string().nullable(),
  retracted_by: z.string().nullable(),
  retracted_reason: z.string().nullable(),
});
export type AdminFlowCorrection = z.infer<typeof AdminFlowCorrectionSchema>;

export const AdminFlowCorrectionResponseSchema = z.object({
  correction: AdminFlowCorrectionSchema,
});
export type AdminFlowCorrectionResponse = z.infer<typeof AdminFlowCorrectionResponseSchema>;

/** `GET /api/admin/vendors/:id/flow-corrections`: the live corrections on its rows. */
export const AdminFlowCorrectionsResponseSchema = z.object({
  corrections: z.array(AdminFlowCorrectionSchema),
});
export type AdminFlowCorrectionsResponse = z.infer<typeof AdminFlowCorrectionsResponseSchema>;

/** Why AECi cannot correct a row's flows here, or `null` when it can. */
export const FLOW_CORRECTION_BLOCKS = [
  'not_sync_service',
  'not_claimed',
  'retired',
  'vetoed',
] as const;
export type FlowCorrectionBlock = (typeof FLOW_CORRECTION_BLOCKS)[number];

/** One flow on the row, as the admin form lists it. */
export const AdminFlowSchema = z.object({
  claim_id: z.string().uuid(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  /** In the row's A/B frame. */
  direction: z.enum(FLOW_CORRECTION_DIRECTIONS),
  origin: z.enum(['aeci', 'vendor']),
  /** What the public pair page shows: `isClaimPubliclyBacked`, the owner and AECi joined. */
  public: z.boolean(),
  agreement: z.enum(AGREEMENT_STATES),
  /** The owner's counting answer, or `null`. */
  owner_answer: z.enum(['yes', 'no']).nullable(),
  /** The live correction, or `null`. */
  correction: AdminFlowCorrectionSchema.nullable(),
});
export type AdminFlow = z.infer<typeof AdminFlowSchema>;

/** `GET /api/admin/flows?integrationId=…` or `?pairId=…`. */
export const AdminFlowsQuerySchema = z
  .object({
    integrationId: z.string().uuid().optional(),
    pairId: z.string().uuid().optional(),
  })
  .strict()
  .refine((q) => (q.integrationId === undefined) !== (q.pairId === undefined), {
    message: 'Give exactly one of integrationId or pairId',
    path: ['integrationId'],
  });

export const AdminFlowsResponseSchema = z.object({
  anchor_id: z.string().uuid(),
  anchor: z.enum(['integration', 'evidenced_pair']),
  name: z.string().nullable(),
  product_a: z.object({ id: z.string(), name: z.string() }),
  product_b: z.object({ id: z.string(), name: z.string() }),
  /** Why AECi cannot correct this row's flows here, or `null`. */
  blocked: z.enum(FLOW_CORRECTION_BLOCKS).nullable(),
  flows: z.array(AdminFlowSchema),
});
export type AdminFlowsResponse = z.infer<typeof AdminFlowsResponseSchema>;

/**
 * The correction as the owner reads it on its flows panel (AECI-2139). No internal
 * note: that is never shown to a vendor.
 */
export const OwnedFlowCorrectionSchema = z.object({
  reason: z.string(),
  source_url: z.string(),
  created_at: z.string(),
});
export type OwnedFlowCorrection = z.infer<typeof OwnedFlowCorrectionSchema>;
