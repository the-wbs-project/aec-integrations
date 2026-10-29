import { z } from 'zod';

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
 * `claim_threads_closed_reason_check` in migration `0098`. A closed thread never
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
 * - `is_own` is true when the caller wrote it. Only the author may delete it.
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

/** `GET /api/vendor/claims/:claimId/thread`. `thread` is `null` until the first
 *  message. */
export const GetVendorThreadResponseSchema = z.object({
  thread: VendorThreadSchema.nullable(),
});
export type GetVendorThreadResponse = z.infer<typeof GetVendorThreadResponseSchema>;

/** Every thread write answers with the thread as it now stands. */
export const VendorThreadResultSchema = z.object({
  thread: VendorThreadSchema,
});
export type VendorThreadResult = z.infer<typeof VendorThreadResultSchema>;
