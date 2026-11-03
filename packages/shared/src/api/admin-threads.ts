import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';
import { ThreadClosedReasonSchema } from './vendor-threads';

/**
 * The admin read of private row threads (AECI-1539, `STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.12, `ADMIN_PANEL_SPEC.md` §5.19).
 *
 *   GET /api/admin/threads       — every thread, paginated, with a "Help requested" filter.
 *   GET /api/admin/threads/:id   — one thread with every message.
 *
 * Read-only. AECi writes nothing on a thread in v1 (§15.3). It is a list, not a
 * queue: nothing in it waits on AECi, so it has no badge.
 *
 * **AECi reads the text of soft-deleted messages** (§15.3, §15.4). The vendor read
 * withholds it. This one does not, until the 2-year delete removes the row.
 */

// ─── Request ─────────────────────────────────────────────────────────────────

/** `?help=`: every thread, or only those a seat asked AECi to look at. */
export const ADMIN_THREAD_HELP_FILTERS = ['all', 'requested'] as const;
export type AdminThreadHelpFilter = (typeof ADMIN_THREAD_HELP_FILTERS)[number];

export const AdminThreadsQuerySchema = PageQuerySchema.extend({
  help: z.enum(ADMIN_THREAD_HELP_FILTERS).default('all'),
});
export type AdminThreadsQuery = z.infer<typeof AdminThreadsQuerySchema>;

// ─── Response ────────────────────────────────────────────────────────────────

/** A company on a thread, with its slug so the console can link `/admin/vendors/:id`. */
export const AdminThreadCompanySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type AdminThreadCompany = z.infer<typeof AdminThreadCompanySchema>;

/**
 * One thread on the list.
 *
 * - `claim_id` is `null` once the claim is gone (`claim_removed`, §15.10).
 * - `data_object` comes from the live claim, else from `anchor_snapshot`. It is
 *   `null` when neither names a data object the vocabulary still holds.
 * - `message_count` counts every message, deleted ones included, and
 *   `last_message_at` is the newest message's `created_at`, deleted or not. That is
 *   the instant the 2-year delete measures from (§15.10).
 */
export const AdminThreadRowSchema = z.object({
  id: z.string().uuid(),
  claim_id: z.string().uuid().nullable(),
  data_object: z.object({ slug: z.string(), name: z.string() }).nullable(),
  vendor_a: AdminThreadCompanySchema,
  vendor_b: AdminThreadCompanySchema,
  message_count: z.number().int().min(0),
  last_message_at: z.string().nullable(),
  help_requested_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  closed_reason: ThreadClosedReasonSchema.nullable(),
  created_at: z.string(),
});
export type AdminThreadRow = z.infer<typeof AdminThreadRowSchema>;

/** `GET /api/admin/threads`. Newest activity first. */
export const AdminThreadsResponseSchema = paginatedResponseSchema(AdminThreadRowSchema);
export type AdminThreadsResponse = z.infer<typeof AdminThreadsResponseSchema>;

/**
 * One message as AECi reads it. `body` is always the stored text, deleted or not.
 * `author_profile_id` is `null` once the author's account was erased (§15.5).
 */
export const AdminThreadMessageSchema = z.object({
  id: z.string().uuid(),
  author_vendor: AdminThreadCompanySchema,
  author_profile_id: z.string().uuid().nullable(),
  body: z.string(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type AdminThreadMessage = z.infer<typeof AdminThreadMessageSchema>;

/** One thread with every message, oldest first. */
export const AdminThreadDetailSchema = AdminThreadRowSchema.extend({
  messages: z.array(AdminThreadMessageSchema),
});
export type AdminThreadDetail = z.infer<typeof AdminThreadDetailSchema>;

/** `GET /api/admin/threads/:id`. An unknown id is `404`. */
export const AdminThreadDetailResponseSchema = z.object({
  thread: AdminThreadDetailSchema,
});
export type AdminThreadDetailResponse = z.infer<typeof AdminThreadDetailResponseSchema>;
