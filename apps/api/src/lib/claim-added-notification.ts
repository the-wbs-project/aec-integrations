/**
 * The `claim_added` notification (AECI-1153 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.6):
 * the pieces the claim route, the notification feed and the specs share.
 *
 * When one endpoint vendor adds a data row (`POST /api/vendor/claims`), every
 * vendor of the OTHER endpoint gets one `notification.sent` ledger row, written in
 * the SAME `db.batch` as the claim, its attestations and their audit rows. It is an
 * event like `integration_create`, not a detector: it has no `detector` key, so the
 * §7 sweep's `loadSuppressed` skips it and it suppresses nothing. Nothing is
 * emailed; the portal feed is the whole delivery.
 *
 * **The row never carries the note.** The added row's note is private to the other
 * company and AEC Integrations (§5.2, AECI-1139), and `audit_log` rows are
 * forwarded to PostHog Logs. The portal reads the note live from
 * `counterparty.note`, under the attestation read's own authorization.
 */

import { orderedPairSlugs, type ContextDirection } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import type { PortalNotificationId } from './notifications/registry';

/** `metadata.kind` on the `notification.sent` row an added claim writes. */
export const CLAIM_ADDED_NOTIFICATION_KIND = 'claim_added';

/**
 * What a `claim_added` row records. `vendorId` is the RECIPIENT, which is what the
 * feed's `json_extract(metadata, '$.vendorId')` filter matches. Every field is a
 * snapshot taken at add time. There is deliberately no `note` key.
 */
export interface ClaimAddedNotificationMetadata {
  kind: typeof CLAIM_ADDED_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). Absent on rows written before it. */
  notificationId: Extract<PortalNotificationId, 'portal-claim-added'>;
  vendorId: string;
  addedByVendorId: string;
  addedByName: string | null;
  integrationId: string;
  integrationName: string | null;
  claimId: string;
  dataObject: { slug: string; name: string };
  /** Caller-relative, framed against the RECIPIENT's own product. */
  direction: ContextDirection;
  /** The adding vendor's product, which is "the other product" to the recipient. */
  counterpartProduct: { slug: string; name: string } | null;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one vendor that another vendor added a data
 * row to an integration on its product. `entity_type` is `claim`, like the §7
 * detector rows, and `entity_id` is the claim id.
 */
export function claimAddedNotificationAudit(
  notification: Extract<PortalNotificationId, 'portal-claim-added'>,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<ClaimAddedNotificationMetadata, 'kind' | 'notificationId'>,
): AuditLogEntry {
  const full: ClaimAddedNotificationMetadata = {
    kind: CLAIM_ADDED_NOTIFICATION_KIND,
    notificationId: notification,
    vendorId: metadata.vendorId,
    addedByVendorId: metadata.addedByVendorId,
    addedByName: metadata.addedByName,
    integrationId: metadata.integrationId,
    integrationName: metadata.integrationName,
    claimId: metadata.claimId,
    dataObject: metadata.dataObject,
    direction: metadata.direction,
    counterpartProduct: metadata.counterpartProduct,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: 'claim',
    entityId: metadata.claimId,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: metadata.vendorId,
    metadata: full,
  };
}
