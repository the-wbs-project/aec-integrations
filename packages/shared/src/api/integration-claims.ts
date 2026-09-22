import { z } from 'zod';

/**
 * Integration ownership claims (AECI-1005 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5).
 *
 *   POST /api/vendor/integrations/:id/claim — the recorded owner claims (200).
 *
 * The owner of an integration is the vendor in `built_by_vendor_id` (AECI-1003's
 * definition: the vendor the customer pays for it or gets it from). Claiming is
 * the act that turns "AECi recorded you as the owner" into "you own this row":
 * it stamps `claimed_at`, and from then on promote writes nothing to the row.
 *
 * Three rules the shapes encode:
 *
 * 1. **No body.** Nothing the client sends decides who owns what. The server
 *    compares the session's vendor with `built_by_vendor_id`.
 * 2. **A seat is the whole gate** (AECI-1003 decision 15). No capability and no
 *    entitlement check, like contests.
 * 3. **One claim per row, ever.** A second claim answers
 *    `409 INTEGRATION_ALREADY_CLAIMED`. Only an AECi admin reassignment (an
 *    accepted `owner` contest naming someone else) clears a claim.
 *
 * i18n note: framework-agnostic package (no `$localize`).
 */

/** The row as the claim left it. Timestamps are ISO-8601. */
export const ClaimedIntegrationSchema = z.object({
  id: z.string().uuid(),
  /** The owner's vendor id, which is the caller's. */
  owner_vendor_id: z.string(),
  claimed_at: z.string(),
  /** Always `'vendor'` after a claim (§13.9's maintenance transfer). */
  maintained_by: z.literal('vendor'),
  last_reviewed_at: z.string(),
});
export type ClaimedIntegration = z.infer<typeof ClaimedIntegrationSchema>;

export const ClaimIntegrationResponseSchema = z.object({
  integration: ClaimedIntegrationSchema,
});
export type ClaimIntegrationResponse = z.infer<typeof ClaimIntegrationResponseSchema>;

/**
 * One claim event addressed to this vendor (`kind: 'integration_claim'`) on
 * `GET /api/vendor/notifications`.
 *
 * Written in the SAME batch as the claim, as a `notification.sent` audit row, to
 * every vendor of either endpoint product other than the owner. It is how the
 * other side learns that a row on its own product is now vendor-owned, and the
 * contest (AECI-1008) is its recourse if the owner is wrong.
 */
export const VendorIntegrationClaimNotificationSchema = z.object({
  kind: z.literal('integration_claim'),
  id: z.string().uuid(),
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  /** The owner that claimed it, by name as it was at claim time. */
  owner_name: z.string().nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorIntegrationClaimNotification = z.infer<
  typeof VendorIntegrationClaimNotificationSchema
>;
