import { z } from 'zod';

/**
 * Vendor replies to reviews (AECI-1173, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c).
 *
 * A seat on a vendor that owns a product answers one approved review of it, in
 * public. AECi approves every reply before it shows (pre-moderation). The table
 * is `review_responses` (`DATABASE_SCHEMA.md` §7.3); the wire shapes are in
 * `API_CONTRACTS.md` §6.6, §6.10 and §6.14.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the Angular surfaces render their own copy.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The five reply statuses (§11c.6). Mirrored by the D1 CHECK
 * `review_responses_status_check`, written once at table creation;
 * `migration-0058.spec.ts` in the API Worker asserts the two agree. `removed` is
 * final.
 */
export const REVIEW_RESPONSE_STATUSES = [
  'pending',
  'published',
  'rejected',
  'withdrawn',
  'removed',
] as const;

export const ReviewResponseStatusSchema = z.enum(REVIEW_RESPONSE_STATUSES);
export type ReviewResponseStatus = z.infer<typeof ReviewResponseStatusSchema>;
