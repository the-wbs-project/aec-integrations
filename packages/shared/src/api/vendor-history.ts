import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * The vendor change history (AECI-1194, `API_CONTRACTS.md` §6.14 "Change history").
 *
 * `GET /api/vendor/history` and `GET /api/vendor/history.csv` read `audit_log`
 * rows whose `vendor_id` is the session vendor and whose `action` is a
 * `receipt: true` entry in `@aeci/shared/audit-vendor-actions`. Each row is an
 * ALLOW-LIST projection: no actor id, no email, no raw before/after values, no
 * internal note. Field names below are the whole wire contract.
 */

/** Who made the change, from the reader's point of view. */
export const VENDOR_HISTORY_ACTOR_KINDS = ['your_team', 'aeci', 'system'] as const;
export const VendorHistoryActorKindSchema = z.enum(VENDOR_HISTORY_ACTOR_KINDS);
export type VendorHistoryActorKind = z.infer<typeof VendorHistoryActorKindSchema>;

/**
 * The `kind` filter. `vendor` and `aeci` match the registry `kind` of the row's
 * action (`vendor-edit`, `aeci-override`); `system` rows show under `all` only.
 */
export const VENDOR_HISTORY_KINDS = ['all', 'vendor', 'aeci'] as const;
export const VendorHistoryKindSchema = z.enum(VENDOR_HISTORY_KINDS);
export type VendorHistoryKind = z.infer<typeof VendorHistoryKindSchema>;

const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const filterShape = {
  kind: VendorHistoryKindSchema.default('all'),
  from: utcDate.optional(),
  to: utcDate.optional(),
};
const rangeInOrder = (q: { from?: string; to?: string }) => !q.from || !q.to || q.from <= q.to;
const rangeMessage = { message: '`from` must not be after `to`', path: ['from'] };

/** The filters both routes share. `from` and `to` are inclusive UTC days. */
export const VendorHistoryFilterSchema = z.object(filterShape).refine(rangeInOrder, rangeMessage);
export type VendorHistoryFilter = z.infer<typeof VendorHistoryFilterSchema>;

/** `GET /api/vendor/history` query: the filters plus `page` / `perPage`. */
export const VendorHistoryQuerySchema = PageQuerySchema.extend(filterShape).refine(
  rangeInOrder,
  rangeMessage,
);
export type VendorHistoryQuery = z.infer<typeof VendorHistoryQuerySchema>;

/** The vendor's plan when the row was written. `null` on a row with no snapshot. */
export const VendorHistoryPlanSchema = z.object({
  tier: z.string(),
  status: z.string().nullable(),
});
export type VendorHistoryPlan = z.infer<typeof VendorHistoryPlanSchema>;

/** One history row. */
export const VendorHistoryItemSchema = z.object({
  id: z.string(),
  /** `audit_log.created_at`, ISO 8601 UTC. */
  at: z.string(),
  actor_kind: VendorHistoryActorKindSchema,
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  /** The entity's CURRENT name, or `null` when it has none or is gone. */
  entity_name: z.string().nullable(),
  /** Key names of the row's `after_state`. Never the values. */
  fields: z.array(z.string()),
  plan: VendorHistoryPlanSchema.nullable(),
  /** AECi's vendor-facing reason. Present only when the writer marked it
   *  `metadata.reasonVisibility = 'vendor'` (AECI-1159). */
  reason: z.string().optional(),
});
export type VendorHistoryItem = z.infer<typeof VendorHistoryItemSchema>;

export const ListVendorHistoryResponseSchema = paginatedResponseSchema(VendorHistoryItemSchema);
export type ListVendorHistoryResponse = z.infer<typeof ListVendorHistoryResponseSchema>;

/** Most rows one CSV export carries. */
export const VENDOR_HISTORY_CSV_MAX_ROWS = 10_000;

/** Set to `true` on a CSV response that stopped at {@link VENDOR_HISTORY_CSV_MAX_ROWS}. */
export const VENDOR_HISTORY_CSV_TRUNCATED_HEADER = 'X-AECI-Truncated';
/** Every CSV response carries the full match count, so a client can say "10,000 of N". */
export const VENDOR_HISTORY_CSV_TOTAL_HEADER = 'X-AECI-Total-Rows';

/** CSV column order. One column per item field; `plan` splits in two. */
export const VENDOR_HISTORY_CSV_COLUMNS = [
  'id',
  'at',
  'actor_kind',
  'action',
  'entity_type',
  'entity_id',
  'entity_name',
  'fields',
  'plan_tier',
  'plan_status',
  'reason',
] as const;
