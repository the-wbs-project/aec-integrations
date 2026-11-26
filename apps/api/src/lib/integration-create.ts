/**
 * Vendor create: the pieces the route, the notification feed and the specs share
 * (AECI-1011 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7). The duplicate rule is
 * `./integration-twins`. The endpoint check and the duplicate read below are shared
 * by the create and its pre-check read (AECI-1953), so the warning shown before a
 * create and the one in the 201 cannot disagree.
 */

import {
  effectiveRetiredBy,
  orderedPairSlugs,
  type PossibleDuplicateIntegration,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, productVendors } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { findStrongMatches, type StrongMatchRow } from './integration-twins';
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

/** The registry entries a create notification may name. */
export type CreateNotificationId = Extract<
  PortalNotificationId,
  'portal-integration-create' | 'portal-sync-service-pair-create'
>;

/** What a create `notification.sent` row records. `vendorId` is the RECIPIENT,
 *  which is what the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface CreateNotificationMetadata {
  kind: typeof CREATE_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). Absent on rows written before it. Since AECI-2040
   *  a Sync Service's new pair writes its own entry with the same `kind`, so the feed
   *  renders both alike. */
  notificationId: CreateNotificationId;
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
 * `entity_type` is `integration`, like the claim, retire and edit notifications, or
 * `connector_evidenced_pair` for a Sync Service's new pair (AECI-2040), as the claim,
 * edit and retire notifications write it on that table.
 */
export function createNotificationAudit(
  notification: CreateNotificationId,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<CreateNotificationMetadata, 'kind' | 'notificationId'>,
  anchor: 'integration' | 'evidenced_pair' = 'integration',
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
    entityType: anchor === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration',
    entityId: metadata.integrationId,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: metadata.vendorId,
    metadata: full,
  };
}

/** Is this a promoted product, and (when `vendorId` is given) one that vendor
 *  holds? `false` for both misses, which both callers answer with the same 404. */
export async function visibleProduct(
  db: Db,
  productId: string,
  vendorId?: string,
): Promise<boolean> {
  if (vendorId) {
    const hit = await db
      .select({ id: products.id })
      .from(products)
      .innerJoin(
        productVendors,
        and(eq(productVendors.productId, products.id), eq(productVendors.vendorId, vendorId)),
      )
      .where(and(eq(products.id, productId), eq(products.promotionStatus, 'promoted')))
      .limit(1);
    return hit.length > 0;
  }
  const hit = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.promotionStatus, 'promoted')))
    .limit(1);
  return hit.length > 0;
}

/** One strong match on the wire. `orientation` is framed against `ownProductId`. */
export function toPossibleDuplicate(
  row: StrongMatchRow,
  ownProductId: string,
): PossibleDuplicateIntegration {
  return {
    id: row.id,
    name: row.name,
    mechanism_kind: row.mechanismKind as PossibleDuplicateIntegration['mechanism_kind'],
    mechanism_name: row.mechanismName,
    orientation: row.sourceProductId === ownProductId ? 'same' : 'reversed',
    owner:
      row.builtByVendorId && row.ownerName
        ? { id: row.builtByVendorId, name: row.ownerName }
        : null,
    claimed: row.claimedAt !== null,
    retired: row.retiredAt !== null,
    retired_by: effectiveRetiredBy({ retired_at: row.retiredAt, retired_by: row.retiredBy }),
  };
}

/**
 * The create's duplicate warning for the pair `ownProductId` and `otherProductId`,
 * as the caller would add it: no connector (decision 9), no kind in the key, the
 * caller as owner. ONE strong-match query, oldest first. Never a refusal.
 */
export async function findPossibleDuplicates(
  db: Db,
  vendorId: string,
  ownProductId: string,
  otherProductId: string,
): Promise<PossibleDuplicateIntegration[]> {
  const rows = await findStrongMatches(db, {
    productIds: [ownProductId, otherProductId],
    poweredByProductId: null,
    ownerVendorId: vendorId,
  });
  return rows.map((row) => toPossibleDuplicate(row, ownProductId));
}
