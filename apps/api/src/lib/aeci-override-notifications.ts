/**
 * Telling a vendor about an AECi override, with the reason (AECI-1159 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d).
 *
 * Three overrides write one `notification.sent` audit row of `metadata.kind =
 * 'aeci_override'` in the SAME batch as the override itself:
 *
 *   - `portal-field-overridden-by-aeci`: an AECi contest accept that overwrote a
 *     field the integration's owner holds. To the displaced owner.
 *   - `portal-logo-overridden-by-aeci`: the admin logo overwrite. To the vendor, or
 *     the product's holding vendor.
 *   - `portal-seat-revoked-by-aeci`: the admin seat revoke. To the vendor, which is
 *     its remaining seats. Not written when no seat remains.
 *
 * The fourth override, the admin retire and restore, keeps its `integration_retire`
 * row and adds the reason to the owner's row (`lib/integration-retire.ts`).
 *
 * **What the row carries.** The reason, and the `reasonVisibility: 'vendor'` marker
 * that the feed mapper requires before it shows one. Never the internal note.
 * `metadata.vendorId` and the `vendor_id` column name the RECIPIENT, as on every
 * other feed row. Every plan gets these rows: there is no tier rule (ruling
 * 2026-10-04).
 */

import {
  REASON_VISIBILITY_VENDOR,
  orderedPairSlugs,
  type AeciOverrideLogoSubject,
  type AeciOverrideNotificationEvent,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import type { PortalNotificationId } from './notifications/registry';

/** `metadata.kind` on every override row. */
export const AECI_OVERRIDE_NOTIFICATION_KIND = 'aeci_override';

/** The registry id each override event records. */
export const AECI_OVERRIDE_NOTIFICATION_IDS = {
  field_overridden: 'portal-field-overridden-by-aeci',
  logo_overridden: 'portal-logo-overridden-by-aeci',
  seat_revoked: 'portal-seat-revoked-by-aeci',
} as const satisfies Record<AeciOverrideNotificationEvent, PortalNotificationId>;

export type AeciOverridePortalNotificationId =
  (typeof AECI_OVERRIDE_NOTIFICATION_IDS)[AeciOverrideNotificationEvent];

/** What an override row records. Every field is a snapshot taken at the write. */
export interface AeciOverrideNotificationMetadata {
  kind: typeof AECI_OVERRIDE_NOTIFICATION_KIND;
  notificationId: AeciOverridePortalNotificationId;
  event: AeciOverrideNotificationEvent;
  /** The RECIPIENT. */
  vendorId: string;
  reason: string;
  reasonVisibility: typeof REASON_VISIBILITY_VENDOR;
  /** `field_overridden` */
  integrationId?: string;
  integrationName?: string | null;
  field?: string;
  pairSlugs?: readonly [string, string] | null;
  /** `logo_overridden` */
  logoSubject?: AeciOverrideLogoSubject;
  /** `seat_revoked` */
  seatUserId?: string;
  seatName?: string | null;
}

type Actor = { actorId: string | null; actorType: AuditLogEntry['actorType'] };

type EventInput =
  | {
      event: 'field_overridden';
      integrationId: string;
      integrationName: string | null;
      field: string;
      pairSlugs: readonly [string, string] | null;
      /** `'connector_evidenced_pair'` on a pair, as every pair write records it. */
      entityType: string;
    }
  | { event: 'logo_overridden'; logoSubject: AeciOverrideLogoSubject; entityId: string }
  | { event: 'seat_revoked'; seatUserId: string; seatName: string | null };

/**
 * The `notification.sent` row for one AECi override, to one vendor. Push it into the
 * override's own batch, after the guarded write, so it commits with it.
 */
export function aeciOverrideNotificationAudit(
  notification: AeciOverridePortalNotificationId,
  actor: Actor,
  input: EventInput & { vendorId: string; reason: string },
): AuditLogEntry {
  if (AECI_OVERRIDE_NOTIFICATION_IDS[input.event] !== notification) {
    throw new Error(`${notification} does not record a ${input.event} event`);
  }
  const base = {
    kind: AECI_OVERRIDE_NOTIFICATION_KIND,
    notificationId: notification,
    event: input.event,
    vendorId: input.vendorId,
    reason: input.reason,
    reasonVisibility: REASON_VISIBILITY_VENDOR,
  } as const;
  let metadata: AeciOverrideNotificationMetadata;
  let entity: Pick<AuditLogEntry, 'entityType' | 'entityId'>;
  switch (input.event) {
    case 'field_overridden':
      metadata = {
        ...base,
        integrationId: input.integrationId,
        integrationName: input.integrationName,
        field: input.field,
        pairSlugs: input.pairSlugs ? orderedPairSlugs(...input.pairSlugs) : null,
      };
      entity = { entityType: input.entityType, entityId: input.integrationId };
      break;
    case 'logo_overridden':
      metadata = { ...base, logoSubject: input.logoSubject };
      entity = { entityType: input.logoSubject.type, entityId: input.entityId };
      break;
    case 'seat_revoked':
      metadata = { ...base, seatUserId: input.seatUserId, seatName: input.seatName };
      entity = { entityType: 'profile', entityId: input.seatUserId };
      break;
  }
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    ...entity,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: input.vendorId,
    ...(input.event === 'logo_overridden' && input.logoSubject.type === 'product'
      ? { productId: input.entityId }
      : {}),
    metadata,
  };
}
