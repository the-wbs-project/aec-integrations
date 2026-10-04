/**
 * Vendor create: the pieces the route, the notification feed and the specs share
 * (AECI-1011 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7). The duplicate rule is
 * `./integration-twins`.
 */

import { orderedPairSlugs } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import type { PortalNotificationId } from './notifications/registry';

/**
 * `audit_log.action` for a create. The SAME action promote writes for a new row, on
 * purpose: the catalog "additions" series (`admin-analytics.ts` `CATALOG_ACTION`,
 * `metrics-backfill.ts`) counts `integration.created`, so a vendor create counts as
 * an addition. The actor (`actor_type`, `metadata.source = 'vendor-portal'`) tells
 * the two apart.
 */
export const INTEGRATION_CREATED_ACTION = 'integration.created';

/** `metadata.kind` on the `notification.sent` row a create writes. */
export const CREATE_NOTIFICATION_KIND = 'integration_create';

/** What a create `notification.sent` row records. `vendorId` is the RECIPIENT,
 *  which is what the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface CreateNotificationMetadata {
  kind: typeof CREATE_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). Absent on rows written before it. */
  notificationId: Extract<PortalNotificationId, 'portal-integration-create'>;
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  ownerVendorId: string;
  ownerName: string | null;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one endpoint vendor that another vendor
 * created an integration on its product. Pushed into the SAME batch as the insert.
 * `entity_type` is `integration`, like the claim, retire and edit notifications.
 */
export function createNotificationAudit(
  notification: Extract<PortalNotificationId, 'portal-integration-create'>,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<CreateNotificationMetadata, 'kind' | 'notificationId'>,
): AuditLogEntry {
  const full: CreateNotificationMetadata = {
    kind: CREATE_NOTIFICATION_KIND,
    notificationId: notification,
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: 'integration',
    entityId: metadata.integrationId,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: metadata.vendorId,
    metadata: full,
  };
}
