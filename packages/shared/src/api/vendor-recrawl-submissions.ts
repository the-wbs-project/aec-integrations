import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Vendor search-engine submission history (`GET /api/vendor/recrawl-submissions`,
 * AECI-1187), behind the `requireVendor()` guard. Source of truth:
 * `API_CONTRACTS.md` §6.14, `DATABASE_SCHEMA.md` §9.6a and §9.6b.
 *
 * Each row is one URL we sent to a search engine, or asked Google to re-crawl by
 * hand, together with ONE of this vendor's edits that caused it. The backing
 * tables are the append-only `recrawl_submissions` log and its
 * `recrawl_submission_causes` rows; the read joins on the cause's `vendor_id`, so
 * a submission shared with another vendor's edit shows only this vendor's cause.
 *
 * Two shapes a reader must expect:
 *
 * 1. **One submission, several rows.** Two edits by this vendor that queued the
 *    same URL before the drain ran produce one submission with two causes, so
 *    two rows with the same `submission_id`.
 * 2. **One URL, several submissions.** A URL IndexNow refused (or that failed in
 *    transport) stays queued and is sent again the next day, so a URL refused N
 *    times yields N submission rows, each carrying the same cause. That is a
 *    faithful record of N attempts, not a duplicate.
 *
 * Wording: these are submissions and requests. Nothing here says a page was
 * indexed or ranked, because no search engine tells us that.
 *
 * Not entitlement-gated (decision 3, `STAGE_2_PAID_TIERS_SPEC.md` §13.1a): reading
 * your own history is never a capability. A Free vendor sees an empty list or the
 * history from a period when it held a plan.
 */

/** `recrawl_submissions.channel`. */
export const RECRAWL_SUBMISSION_CHANNELS = ['indexnow', 'gsc_manual'] as const;
export const RecrawlSubmissionChannelSchema = z.enum(RECRAWL_SUBMISSION_CHANNELS);
export type RecrawlSubmissionChannel = z.infer<typeof RecrawlSubmissionChannelSchema>;

/**
 * `recrawl_submissions.outcome`. `accepted` (IndexNow 2xx), `refused` (4xx),
 * `failed` (5xx or no response), `requested` (an operator asked Google by hand in
 * Search Console). None of them means "indexed".
 */
export const RECRAWL_SUBMISSION_OUTCOMES = ['accepted', 'refused', 'failed', 'requested'] as const;
export const RecrawlSubmissionOutcomeSchema = z.enum(RECRAWL_SUBMISSION_OUTCOMES);
export type RecrawlSubmissionOutcome = z.infer<typeof RecrawlSubmissionOutcomeSchema>;

/** Query. Ordering is fixed newest-first, so there is no `sort` parameter. */
export const ListVendorRecrawlSubmissionsQuerySchema = PageQuerySchema.extend({
  channel: RecrawlSubmissionChannelSchema.optional(),
});
export type ListVendorRecrawlSubmissionsQuery = z.infer<
  typeof ListVendorRecrawlSubmissionsQuerySchema
>;

/**
 * The vendor edit behind a submission. `audit_log_id` and `action` name the audit
 * row the edit wrote; `action` is an open string, like `audit_log.action`, so a
 * row can outlive the code that wrote it. The product fields are null when the
 * edit touched no product of the vendor's (a profile edit), and the slug and name
 * are null if the product row no longer exists. `queued_at` is when the edit
 * queued the URL.
 */
export const VendorRecrawlSubmissionCauseSchema = z.object({
  audit_log_id: z.string().nullable(),
  action: z.string().nullable(),
  product_id: z.string().nullable(),
  product_slug: z.string().nullable(),
  product_name: z.string().nullable(),
  queued_at: z.string(),
});
export type VendorRecrawlSubmissionCause = z.infer<typeof VendorRecrawlSubmissionCauseSchema>;

/** One (submission, this vendor's cause) pair. `url` is absolute. */
export const VendorRecrawlSubmissionSchema = z.object({
  submission_id: z.number().int().positive(),
  url: z.string(),
  channel: RecrawlSubmissionChannelSchema,
  outcome: RecrawlSubmissionOutcomeSchema,
  submitted_at: z.string(),
  cause: VendorRecrawlSubmissionCauseSchema,
});
export type VendorRecrawlSubmission = z.infer<typeof VendorRecrawlSubmissionSchema>;

export const ListVendorRecrawlSubmissionsResponseSchema = paginatedResponseSchema(
  VendorRecrawlSubmissionSchema,
);
export type ListVendorRecrawlSubmissionsResponse = z.infer<
  typeof ListVendorRecrawlSubmissionsResponseSchema
>;
