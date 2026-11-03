import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Private row threads between the two endpoint companies (AECI-1535,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15).
 *
 * One thread per data row (`claims.id`), created on the first message. Only the two
 * companies' seats and AECi read it. Nothing here reaches a public read, a count or a
 * ranking input (§15.3). The tables are `claim_threads`, `claim_thread_messages` and
 * `claim_thread_reads` (`DATABASE_SCHEMA.md` §8.10). The routes are in
 * `API_CONTRACTS.md` §6.14 ("Private row threads").
 *
 * i18n note: framework-agnostic package (no `$localize`). The portal renders its own
 * copy for every state below.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Why a thread closed (§15.10). Mirrored by the D1 CHECK
 * `claim_threads_closed_reason_check` in migration `0100`. A closed thread never
 * reopens.
 */
export const THREAD_CLOSED_REASONS = [
  'retired',
  'withdrawn',
  'claim_removed',
  'not_attestable',
] as const;

export const ThreadClosedReasonSchema = z.enum(THREAD_CLOSED_REASONS);
export type ThreadClosedReason = z.infer<typeof ThreadClosedReasonSchema>;

/** §15.4: plain text, 1 to 2,000 characters after trim. The review-reply rule. */
export const THREAD_MESSAGE_BODY_MAX = 2000;

// ─── Request ─────────────────────────────────────────────────────────────────

/** `POST /api/vendor/claims/:claimId/thread/messages`. An empty or over-long body is
 *  `400 VALIDATION_FAILED` with `field: 'body'`. */
export const PostThreadMessageSchema = z.object({
  body: z.string().trim().min(1).max(THREAD_MESSAGE_BODY_MAX),
});
export type PostThreadMessage = z.infer<typeof PostThreadMessageSchema>;

// ─── Response ────────────────────────────────────────────────────────────────

/** A company on a thread: one of its two endpoint vendors. */
export const ThreadCompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type ThreadCompany = z.infer<typeof ThreadCompanySchema>;

/**
 * One message, as a vendor seat reads it.
 *
 * - `author_vendor` is stamped at post time, so the line reads "{Company} · {date}"
 *   even after the author leaves the seat (§15.4).
 * - `author_removed` is true when the author's account was erased. The portal shows
 *   "Former member of {Company}" (§15.5). No profile id reaches the other company.
 * - `is_own` is true when the caller wrote it AS ITS CURRENT COMPANY: the profile
 *   and the stamped `author_vendor` both match the session. A person re-seated at
 *   another company does not own their old company's messages. Only the author may
 *   delete it (§15.4).
 * - `body` is `null` once deleted, and `deleted_at` says when. The text stays in D1
 *   for AECi until the 2-year delete, but it leaves every vendor read (§15.4).
 */
export const VendorThreadMessageSchema = z.object({
  id: z.string().uuid(),
  author_vendor: ThreadCompanySchema,
  author_removed: z.boolean(),
  is_own: z.boolean(),
  body: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type VendorThreadMessage = z.infer<typeof VendorThreadMessageSchema>;

/**
 * One thread with its messages, oldest first.
 *
 * `vendor_a` is the company on the integration's source product and `vendor_b` the
 * one on its target, stamped when the thread was created (§15.5). `closed_at` and
 * `closed_reason` are set together or not at all. `help_requested_at` is set once
 * a seat asked AECi to look (§15.3).
 */
export const VendorThreadSchema = z.object({
  id: z.string().uuid(),
  claim_id: z.string().uuid(),
  vendor_a: ThreadCompanySchema,
  vendor_b: ThreadCompanySchema,
  closed_at: z.string().nullable(),
  closed_reason: ThreadClosedReasonSchema.nullable(),
  help_requested_at: z.string().nullable(),
  created_at: z.string(),
  messages: z.array(VendorThreadMessageSchema),
});
export type VendorThread = z.infer<typeof VendorThreadSchema>;

/**
 * `GET /api/vendor/claims/:claimId/thread`. `thread` is `null` until the first
 * message.
 *
 * `counterparty` is the company the caller's messages go to, so the heading, the
 * audience line and the composer name the real recipient (§15.3, §15.6). With a
 * thread, it is whichever of the two stamped companies is not the caller's. Before
 * the first message, it is the company the first post would stamp, computed by the
 * same function the post uses. On a co-owned endpoint that is the first vendor on
 * the other side who is not the caller (§15.6, ruled 2026-10-30). It is `null` only
 * when no thread exists and the row is not attestable by two companies (§15.2).
 */
export const GetVendorThreadResponseSchema = z.object({
  thread: VendorThreadSchema.nullable(),
  counterparty: ThreadCompanySchema.nullable(),
});
export type GetVendorThreadResponse = z.infer<typeof GetVendorThreadResponseSchema>;

/**
 * One thread read by its id (AECI-1548), for the thread's permanent portal page
 * (AECI-1551). Every notification about a thread links there. Ruled 2026-10-30: a
 * vendor keeps read access to a thread whose row was deleted.
 *
 * - `claim_id` is `null` once the claim is gone (`claim_removed`, §15.10).
 * - `data_object` names the row: the live claim's data object, else the one in
 *   `anchor_snapshot`. `null` only when neither resolves.
 * - `can_write` is true when the caller may post, delete its own messages and ask
 *   for help here (AECI-1551). The server computes it from the checks the claim
 *   write routes run: the thread is open, its claim exists, the caller's company is
 *   still an endpoint of it, the row is attestable by two companies (§15.2), and
 *   the integration is live. Writes still go through the claim routes, by
 *   `claim_id`. The page never offers a write the server would refuse.
 */
export const VendorThreadByIdSchema = VendorThreadSchema.extend({
  claim_id: z.string().uuid().nullable(),
  data_object: z.object({ slug: z.string(), name: z.string() }).nullable(),
  can_write: z.boolean(),
});
export type VendorThreadById = z.infer<typeof VendorThreadByIdSchema>;

/** `GET /api/vendor/threads/:threadId`. A stranger and a missing thread get one 404. */
export const GetVendorThreadByIdResponseSchema = z.object({
  thread: VendorThreadByIdSchema,
});
export type GetVendorThreadByIdResponse = z.infer<typeof GetVendorThreadByIdResponseSchema>;

/** Every thread write answers with the thread as it now stands. */
export const VendorThreadResultSchema = z.object({
  thread: VendorThreadSchema,
});
export type VendorThreadResult = z.infer<typeof VendorThreadResultSchema>;

/**
 * One thread on an integration's data row, as a summary (AECI-1546). No message
 * text. The portal shows it on the row and loads the messages only when the seat
 * opens the thread, through `GET …/claims/:claimId/thread`.
 *
 * - `counterparty` is the stamped company that is not the caller's, the same rule
 *   as {@link GetVendorThreadResponseSchema}.
 * - `message_count` counts every message, deleted ones included, because each one
 *   still shows as a line in the thread ("Message deleted").
 * - `latest_message_at` is the newest message's `created_at`. `null` only on a
 *   thread with no message, which a first post never leaves.
 */
export const VendorThreadSummarySchema = z.object({
  id: z.string().uuid(),
  claim_id: z.string().uuid(),
  counterparty: ThreadCompanySchema,
  message_count: z.number().int().nonnegative(),
  latest_message_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  closed_reason: ThreadClosedReasonSchema.nullable(),
  help_requested_at: z.string().nullable(),
});
export type VendorThreadSummary = z.infer<typeof VendorThreadSummarySchema>;

/**
 * `GET /api/vendor/integrations/:id/threads` (AECI-1546). One read per integration
 * page, in place of one `GET …/thread` per data row.
 *
 * `threads` lists the threads on this integration's claims that the caller's
 * company is stamped on, ordered by `claim_id`. A claim with no entry has no thread
 * the caller can read. `counterparty` is the company a first post on any of this
 * integration's rows would stamp, from the same function the post uses. It is
 * `null` when the integration's rows are not attestable by two companies (§15.2).
 *
 * This read writes no read marker. A marker is written only when the messages are
 * shown, by `GET …/claims/:claimId/thread` (§15.8).
 */
export const GetVendorIntegrationThreadsResponseSchema = z.object({
  counterparty: ThreadCompanySchema.nullable(),
  threads: z.array(VendorThreadSummarySchema),
});
export type GetVendorIntegrationThreadsResponse = z.infer<
  typeof GetVendorIntegrationThreadsResponseSchema
>;

// ─── The company's conversations (AECI-1551) ─────────────────────────────────

/** The status filter on `GET /api/vendor/threads`. `all` is the default. */
export const VENDOR_THREAD_LIST_STATUSES = ['all', 'open', 'closed'] as const;
export const VendorThreadListStatusSchema = z.enum(VENDOR_THREAD_LIST_STATUSES);
export type VendorThreadListStatus = z.infer<typeof VendorThreadListStatusSchema>;

/** `GET /api/vendor/threads` query: `page` / `perPage` plus the status filter. */
export const VendorThreadListQuerySchema = PageQuerySchema.extend({
  status: VendorThreadListStatusSchema.default('all'),
});
export type VendorThreadListQuery = z.infer<typeof VendorThreadListQuerySchema>;

/**
 * One thread in the company's Conversations list (AECI-1551). No message text.
 *
 * - `counterparty` is the stamped company that is not the caller's.
 * - `data_object` names the row as the by-id read does: the live claim's data
 *   object, else the anchor snapshot's. `null` only when neither resolves.
 * - `last_activity_at` is the newest of the thread's creation, its newest message,
 *   its help ask and its close. The list is ordered by it, newest first.
 */
export const VendorThreadListItemSchema = z.object({
  id: z.string().uuid(),
  claim_id: z.string().uuid().nullable(),
  counterparty: ThreadCompanySchema,
  data_object: z.object({ slug: z.string(), name: z.string() }).nullable(),
  message_count: z.number().int().nonnegative(),
  last_activity_at: z.string(),
  closed_at: z.string().nullable(),
  closed_reason: ThreadClosedReasonSchema.nullable(),
  help_requested_at: z.string().nullable(),
});
export type VendorThreadListItem = z.infer<typeof VendorThreadListItemSchema>;

/**
 * `GET /api/vendor/threads` (AECI-1551). Every thread the caller's company is
 * stamped on, open and closed, its row deleted or not. It outlasts the 90-day
 * notification list. It writes no read marker.
 */
export const ListVendorThreadsResponseSchema = paginatedResponseSchema(VendorThreadListItemSchema);
export type ListVendorThreadsResponse = z.infer<typeof ListVendorThreadsResponseSchema>;
