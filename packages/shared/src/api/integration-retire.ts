import { z } from 'zod';

/**
 * Integration retire and restore (AECI-1010 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 *   POST /api/vendor/integrations/:id/retire  — the owner withdraws the row (200).
 *   POST /api/vendor/integrations/:id/restore — the owner brings it back (200).
 *
 * Retire is not retract (ADR 0030). Nothing is deleted: the row, its claims and its
 * attestations all stay, so a restore is lossless. A retired row counts nowhere, is
 * in no search index, and renders on no public page. Both endpoint vendors still see
 * it in the portal, marked retired.
 *
 * Four rules the shapes encode:
 *
 * 1. **No body.** The server decides ownership from the session and the row.
 * 2. **Owner only, and only once claimed.** The owner is `built_by_vendor_id` and
 *    the row must carry `claimed_at` (AECI-1005). A seat is the whole gate, with no
 *    capability check (AECI-1003 decision 15). Connector-powered rows are refused
 *    with `403 INTEGRATION_CONNECTOR_POWERED` (decision 9, v1).
 * 3. **Idempotent by refusal.** Retiring a retired row answers
 *    `409 INTEGRATION_RETIRED`; restoring a live row answers
 *    `409 INTEGRATION_NOT_RETIRED`. Neither writes anything.
 * 4. **Retire closes open contests on the row as withdrawn.** Restore does not
 *    reopen them. `withdrawn_contest_ids` lists what the retire closed.
 *
 * i18n note: framework-agnostic package (no `$localize`).
 */

/** The row as the retire or restore left it. Timestamps are ISO-8601. */
export const RetiredIntegrationStateSchema = z.object({
  id: z.string().uuid(),
  /** Set by retire, `null` after restore. */
  retired_at: z.string().nullable(),
  updated_at: z.string(),
});
export type RetiredIntegrationState = z.infer<typeof RetiredIntegrationStateSchema>;

export const RetireIntegrationResponseSchema = z.object({
  integration: RetiredIntegrationStateSchema,
  /** Contests the retire closed as `withdrawn`. Always `[]` on a restore. */
  withdrawn_contest_ids: z.array(z.string().uuid()),
});
export type RetireIntegrationResponse = z.infer<typeof RetireIntegrationResponseSchema>;

/** What happened, on the notification row. */
export const INTEGRATION_RETIRE_EVENTS = ['retired', 'restored'] as const;
export type IntegrationRetireEvent = (typeof INTEGRATION_RETIRE_EVENTS)[number];

/**
 * One retire or restore addressed to this vendor (`kind: 'integration_retire'`) on
 * `GET /api/vendor/notifications`.
 *
 * Written in the SAME batch as the retire or restore, as a `notification.sent` audit
 * row, to every vendor of either endpoint product other than the owner. A snapshot
 * like every other row in the feed: names as they were at the time.
 */
export const VendorIntegrationRetireNotificationSchema = z.object({
  kind: z.literal('integration_retire'),
  id: z.string().uuid(),
  event: z.enum(INTEGRATION_RETIRE_EVENTS),
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  owner_name: z.string().nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorIntegrationRetireNotification = z.infer<
  typeof VendorIntegrationRetireNotificationSchema
>;
