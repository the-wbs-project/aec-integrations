/**
 * The `portal-thread-message` notification (AECI-1535,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.8): one `notification.sent` ledger row per
 * message, addressed to the OTHER company on the thread, written in the SAME
 * `db.batch` as the message and its audit row. Like `claim_added`, it is an event,
 * not a detector, and nothing is emailed: the portal feed and the daily digest line
 * (AECI-1537) are the whole delivery.
 *
 * **The row never carries the message.** `audit_log` rows outlive the 2-year thread
 * delete and are forwarded to PostHog Logs, so a body here would escape both
 * (§15.7, ruled 2026-10-29). The row carries ids, the row's name and the sender's
 * company. The portal reads the text live from the thread read, under its own guard.
 *
 * `GET /api/vendor/notifications` maps these rows to `kind: 'thread_message'`
 * (AECI-1539), and the portal's notification list renders them with a link to the
 * integration page.
 */

import { orderedPairSlugs } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import type { PortalNotificationId } from './notifications/registry';

/** `metadata.kind` on the `notification.sent` row a thread message writes. */
export const THREAD_MESSAGE_NOTIFICATION_KIND = 'thread_message';

/** `audit_log.entity_type` for a thread and for one of its messages (§15.7). */
export const THREAD_ENTITY_TYPE = 'claim_thread';
export const THREAD_MESSAGE_ENTITY_TYPE = 'claim_thread_message';

/** The §15.7 actions this module's routes write. `thread.closed` and
 *  `thread.retention_deleted` are in `./claim-thread-lifecycle` (AECI-1536). */
export const THREAD_ACTIONS = {
  posted: 'thread.message.posted',
  deleted: 'thread.message.deleted',
  helpRequested: 'thread.help_requested',
} as const;

/**
 * What a `thread_message` row records. `vendorId` is the RECIPIENT, which is what
 * the feed's `json_extract(metadata, '$.vendorId')` filter matches. Every field is a
 * snapshot taken at post time. There is deliberately no `body` key.
 */
export interface ThreadMessageNotificationMetadata {
  kind: typeof THREAD_MESSAGE_NOTIFICATION_KIND;
  notificationId: Extract<PortalNotificationId, 'portal-thread-message'>;
  vendorId: string;
  fromVendorId: string;
  fromVendorName: string | null;
  threadId: string;
  messageId: string;
  claimId: string;
  integrationId: string;
  dataObject: { slug: string; name: string };
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one company that the other wrote on a
 * thread. `entity_type` is `claim_thread_message` and `entity_id` the message id.
 */
export function threadMessageNotificationAudit(
  notification: Extract<PortalNotificationId, 'portal-thread-message'>,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<ThreadMessageNotificationMetadata, 'kind' | 'notificationId'>,
): AuditLogEntry {
  const full: ThreadMessageNotificationMetadata = {
    kind: THREAD_MESSAGE_NOTIFICATION_KIND,
    notificationId: notification,
    vendorId: metadata.vendorId,
    fromVendorId: metadata.fromVendorId,
    fromVendorName: metadata.fromVendorName,
    threadId: metadata.threadId,
    messageId: metadata.messageId,
    claimId: metadata.claimId,
    integrationId: metadata.integrationId,
    dataObject: metadata.dataObject,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: THREAD_MESSAGE_ENTITY_TYPE,
    entityId: metadata.messageId,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: metadata.vendorId,
    metadata: full,
  };
}
