/**
 * Vendor create: the pieces the route, the notification feed and the specs share
 * (AECI-1011 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7). The duplicate rule is
 * `./integration-twins`.
 */

import { orderedPairSlugs } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';

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
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<CreateNotificationMetadata, 'kind'>,
): AuditLogEntry {
  const full: CreateNotificationMetadata = {
    kind: CREATE_NOTIFICATION_KIND,
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: 'integration',
    entityId: metadata.integrationId,
    metadata: full,
  };
}
