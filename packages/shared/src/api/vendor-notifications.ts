import { z } from 'zod';

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
 * One notification the sweep sent to this vendor.
 *
 * `id` is the `audit_log` row id — stable, so the dashboard can key a list on it.
 * `pair_path` is the site-relative product-pair page
 * (`/products/{context}/integrations/{other}`), or `null` when either product had
 * no slug at send time. `counterpart_product` is null for `stale-version`, which
 * is about the vendor's own assertion rather than about the other side.
 */
export const VendorNotificationSchema = z.object({
  id: z.string().uuid(),
  detector: z.enum(ATTESTATION_DETECTORS),
  claim_id: z.string().uuid(),
  integration_id: z.string().uuid(),
  data_object: NotificationProductRefSchema.nullable(),
  counterpart_product: NotificationProductRefSchema.nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorNotification = z.infer<typeof VendorNotificationSchema>;

export const ListVendorNotificationsResponseSchema = z.object({
  notifications: z.array(VendorNotificationSchema),
});
export type ListVendorNotificationsResponse = z.infer<typeof ListVendorNotificationsResponseSchema>;
