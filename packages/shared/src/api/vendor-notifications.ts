import { z } from 'zod';

import { VendorIntegrationClaimNotificationSchema } from './integration-claims';
import { VendorIntegrationCreateNotificationSchema } from './integration-create';
import {
  IntegrationRetiredBySchema,
  VendorIntegrationRetireNotificationSchema,
} from './integration-retire';
import { VendorIntegrationUpdateNotificationSchema } from './integration-edits';

/**
 * Vendor notification list (`GET /api/vendor/notifications`, AECI-302 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7.2), behind the `requireVendor()` guard.
 *
 * The §7 detector sweep runs daily, emails the vendor's seats, and records every
 * successful send in `audit_log` (`action: 'notification.sent'`). That ledger is
 * the anti-nag suppression store **and** this endpoint's backing table — §7.3's
 * "no separate store". So the shapes below describe *what was sent*, not live
 * state: a row is a historical record of a nudge, and it stays accurate even
 * after the underlying claim is re-curated or the conflict is resolved.
 *
 * Two consequences of reading a ledger rather than a live query:
 *
 * 1. **Every field is a snapshot** taken at send time (product names, the data
 *    object, the pair path). Nothing here is re-joined on read — that is what
 *    makes the list free, and what keeps a year-old notification legible after
 *    the claim it names has moved on.
 * 2. **`vendor_id` never crosses the wire.** As everywhere on `/api/vendor/*`,
 *    the caller's vendor comes from the session and scopes the query server-side.
 *    Ledger rows the sweep wrote for **AECi ops** (the ops halves of
 *    `claim-denied` and `open-conflict`) carry a null vendor and can therefore
 *    never match a vendor caller. That is structural isolation, not a `WHERE`
 *    clause someone has to remember: `claim-denied` writes BOTH an ops row and a
 *    counterparty row, and only the second one is addressed to a vendor id.
 *
 * Since AECI-1008 the same ledger also carries **contest** rows, written by the
 * contest handlers rather than the sweep, so the list is a union on `kind` (see
 * `VendorNotificationSchema` below).
 *
 * i18n note: framework-agnostic package (no `$localize`) — the Angular dashboard
 * (AECI-606) renders its own copy from `detector`.
 */

/**
 * The §7.1 detector kinds. `cross-grain` is deliberately absent: it was **dropped**
 * at build (see §7.1 / §11) because its proposed definition — the same
 * `data_object` claimed with contradictory directions through *different mechanism
 * rows* on the same product pair — fires on legitimate data, since two mechanisms
 * genuinely can move the same object in opposite directions.
 *
 * `claim-denied` was `aeci-denied` until AECI-961, which dropped both halves of
 * that name: the detector is no longer gated on an AECi-seeded claim, and it is
 * no longer ops-only — it now also notifies the counterparty vendor, so its rows
 * DO appear on this endpoint. The rename was taken while production held zero
 * attestation notifications; there were no ledger rows to migrate.
 */
export const ATTESTATION_DETECTORS = [
  'silent-counterparty',
  'open-conflict',
  'stale-version',
  'claim-denied',
] as const;

export type AttestationDetector = (typeof ATTESTATION_DETECTORS)[number];

/** The counterpart product a notification is about, as captured at send time. */
export const NotificationProductRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
});
export type NotificationProductRef = z.infer<typeof NotificationProductRefSchema>;

/**
 * One notification the §7 sweep sent to this vendor (`kind: 'attestation'`).
 *
 * `id` is the `audit_log` row id — stable, so the dashboard can key a list on it.
 * `pair_path` is the site-relative product-pair page
 * (`/products/{context}/integrations/{other}`), or `null` when either product had
 * no slug at send time. `counterpart_product` is null for `stale-version`, which
 * is about the vendor's own assertion rather than about the other side.
 *
 * `kind` is OPTIONAL on this member, and that is deliberate. It was added by
 * AECI-1008 when contest rows joined the feed, and the SSR and API Workers deploy
 * per-commit but not atomically: a client must still read a pre-AECI-1008 row,
 * which carries no `kind`, as an attestation. The server always sends it now.
 */
export const VendorAttestationNotificationSchema = z.object({
  kind: z.literal('attestation').optional(),
  id: z.string().uuid(),
  detector: z.enum(ATTESTATION_DETECTORS),
  claim_id: z.string().uuid(),
  integration_id: z.string().uuid(),
  data_object: NotificationProductRefSchema.nullable(),
  counterpart_product: NotificationProductRefSchema.nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorAttestationNotification = z.infer<typeof VendorAttestationNotificationSchema>;

/**
 * What happened to a contest that this row tells the vendor about (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b). The recipient is always "the other side":
 * `submitted` and `withdrawn` go to the owner, the decisions go to the submitter.
 * `closed_by_retire` (AECI-1010) also goes to the submitter: the owner, or since
 * AECI-1046 AEC Integrations, retired the integration, and the retire closed the open
 * contest as withdrawn. `retired_by` on the row says which.
 */
export const CONTEST_NOTIFICATION_EVENTS = [
  'submitted',
  'withdrawn',
  'accepted',
  'declined',
  'closed_by_retire',
  // AECI-1009 protests (§11b.12.10). `protested` and `protest_withdrawn` reach the
  // owner, `protest_replied` the submitter, and the two decisions reach BOTH sides,
  // told apart by `recipient_role`.
  'protested',
  'protest_replied',
  'protest_withdrawn',
  'protest_upheld',
  'protest_rejected',
] as const;
export type ContestNotificationEvent = (typeof CONTEST_NOTIFICATION_EVENTS)[number];

/**
 * One contest event addressed to this vendor (`kind: 'contest'`, AECI-1008).
 *
 * Written by the contest handlers as a `notification.sent` audit row in the SAME
 * batch as the transition, so it is a snapshot like every other row here: the
 * field and the integration's name as they were when the event happened. There is
 * no email behind it; the portal feed is the whole delivery.
 */
export const VendorContestNotificationSchema = z.object({
  kind: z.literal('contest'),
  id: z.string().uuid(),
  event: z.enum(CONTEST_NOTIFICATION_EVENTS),
  contest_id: z.string().uuid(),
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  field: z.string(),
  /**
   * On a `closed_by_retire` row only (AECI-1046): who retired the integration.
   * Absent on every other event, and on a retire close written before AECI-1046,
   * which was always the owner's. The admin's reason is never on this row.
   */
  retired_by: IntegrationRetiredBySchema.optional(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
  /** AECI-1009. Which side this row addresses, on the two protest decisions. */
  recipient_role: z.enum(['submitter', 'owner']).nullable().default(null),
  /** AECI-1009. On an owner `declined`: the last instant a protest may be filed. */
  protest_closes_at: z.string().nullable().default(null),
  /** AECI-1009. On `protested`: the owner's reply deadline. */
  reply_due_at: z.string().nullable().default(null),
  /** AECI-1009. On `protest_rejected`: when the submitter may contest the field again. */
  cooldown_until: z.string().nullable().default(null),
});
export type VendorContestNotification = z.infer<typeof VendorContestNotificationSchema>;

/** One row of the feed. Discriminated on `kind`; see the attestation member for
 *  why its `kind` may be absent. `integration_claim` joined in AECI-1005
 *  (`VendorIntegrationClaimNotificationSchema` in `./integration-claims`), and
 *  `integration_retire` in AECI-1010 (`./integration-retire`), and
 *  `integration_update` in AECI-1006 (`./integration-edits`), and
 *  `integration_create` in AECI-1011 (`./integration-create`). */
export const VendorNotificationSchema = z.union([
  VendorContestNotificationSchema,
  VendorIntegrationClaimNotificationSchema,
  VendorIntegrationRetireNotificationSchema,
  VendorIntegrationUpdateNotificationSchema,
  VendorIntegrationCreateNotificationSchema,
  VendorAttestationNotificationSchema,
]);
export type VendorNotification = z.infer<typeof VendorNotificationSchema>;

/** Narrow a feed row to the attestation member. `kind` absent counts as
 *  attestation, which is what every pre-AECI-1008 row is. Every other member
 *  carries an explicit `kind`, so this names them rather than testing for one. */
export function isAttestationNotification(
  notification: VendorNotification,
): notification is VendorAttestationNotification {
  return (
    notification.kind !== 'contest' &&
    notification.kind !== 'integration_claim' &&
    notification.kind !== 'integration_retire' &&
    notification.kind !== 'integration_update' &&
    notification.kind !== 'integration_create'
  );
}

export const ListVendorNotificationsResponseSchema = z.object({
  notifications: z.array(VendorNotificationSchema),
});
export type ListVendorNotificationsResponse = z.infer<typeof ListVendorNotificationsResponseSchema>;
