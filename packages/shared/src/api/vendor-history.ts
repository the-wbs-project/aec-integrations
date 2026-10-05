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
 * The `kind` filter selects by WHO acted, matching `actor_kind`. `vendor` keeps
 * `your_team` rows, `aeci` keeps `aeci` rows, and `all` keeps everything,
 * `system` rows included. The action is not consulted: an AECi admin's
 * `product.updated` shows under `aeci`, not `vendor`.
 */
export const VENDOR_HISTORY_KINDS = ['all', 'vendor', 'aeci'] as const;
export const VendorHistoryKindSchema = z.enum(VENDOR_HISTORY_KINDS);
export type VendorHistoryKind = z.infer<typeof VendorHistoryKindSchema>;

/** A real calendar day. The round-trip rejects `2026-13-01` and `2026-02-31`,
 *  which the shape regex alone lets through (one throws, one rolls over). */
const isRealUtcDay = (d: string): boolean => {
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
};
const utcDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealUtcDay, 'Not a real calendar day');

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

// ─── Search follow-up (AECI-1160) ──────────────────────────────────────────

/**
 * `GET /api/vendor/history/follow-up?ids=<audit id>,<audit id>,…` (AECI-1160,
 * `API_CONTRACTS.md` §6.14 "Change history: search follow-up").
 *
 * What the search follow-up of each change on one history page is, keyed by the
 * page's audit ids. One request per page. The read joins the recrawl cause rows
 * (AECI-1184) on `audit_log_id`, scoped by the cause's `vendor_id`, so an id that
 * is not one of the caller's own edits returns nothing.
 */

/** Most audit ids one follow-up read takes: one history page at the API's cap. */
export const VENDOR_HISTORY_FOLLOW_UP_MAX_IDS = 100;

/** Comma-separated audit ids. Blank entries are dropped; duplicates collapse. */
export const VendorHistoryFollowUpQuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => [
      ...new Set(
        raw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().max(64)).min(1).max(VENDOR_HISTORY_FOLLOW_UP_MAX_IDS)),
});
export type VendorHistoryFollowUpQuery = z.infer<typeof VendorHistoryFollowUpQuerySchema>;

/**
 * The two search channels, as the vendor reads them. `indexnow` is the daily
 * IndexNow send (Bing, Yandex and others). `google` is the Google worklist an AECi
 * operator works by hand in Search Console (ADR 0031).
 */
export const VENDOR_SEARCH_CHANNELS = ['indexnow', 'google'] as const;
export const VendorSearchChannelSchema = z.enum(VENDOR_SEARCH_CHANNELS);
export type VendorSearchChannel = z.infer<typeof VendorSearchChannelSchema>;

/**
 * One URL's state on one channel. Each says what WE did, never what a search
 * engine did with it:
 *
 * - `queued`: waiting for the next IndexNow send, or on the Google worklist;
 * - `submitted`: IndexNow accepted the URL (a 2xx);
 * - `failed`: IndexNow refused the URL or did not answer. `retrying` says whether
 *   it is still queued for another try;
 * - `requested`: an AECi operator recorded that they asked Google to re-crawl it.
 *   Clearing a worklist row without that answer is never shown as `requested`.
 *
 * "Not eligible" is not a server state. The page derives it from the row's plan
 * snapshot, because a Free write never queues anything to report on.
 */
export const VENDOR_SEARCH_FOLLOW_UP_STATES = [
  'queued',
  'submitted',
  'failed',
  'requested',
] as const;
export const VendorSearchFollowUpStateSchema = z.enum(VENDOR_SEARCH_FOLLOW_UP_STATES);
export type VendorSearchFollowUpState = z.infer<typeof VendorSearchFollowUpStateSchema>;

/** One (change, URL, channel) and where it stands. */
export const VendorHistoryFollowUpSchema = z.object({
  /** The history row's `id`. */
  audit_log_id: z.string(),
  /** The absolute public URL. */
  url: z.string(),
  channel: VendorSearchChannelSchema,
  state: VendorSearchFollowUpStateSchema,
  /** When the state began: the send or request time, or when the change queued
   *  the URL for `queued`. ISO 8601 UTC. */
  at: z.string(),
  /** The IndexNow HTTP status on `submitted` and `failed`; `null` otherwise and on
   *  a transport failure. */
  http_status: z.number().int().nullable(),
  /** `failed` only: the URL is still queued and will be sent again. */
  retrying: z.boolean(),
});
export type VendorHistoryFollowUp = z.infer<typeof VendorHistoryFollowUpSchema>;

/** Unpaginated: bounded by the ids asked for. Ordered by audit id, URL, channel. */
export const ListVendorHistoryFollowUpResponseSchema = z.object({
  data: z.array(VendorHistoryFollowUpSchema),
});
export type ListVendorHistoryFollowUpResponse = z.infer<
  typeof ListVendorHistoryFollowUpResponseSchema
>;
