/**
 * Every vendor-scoped `audit_log.action` (AECI-1192, `DATABASE_SCHEMA.md` §8.4).
 *
 * A row with one of these actions is ABOUT a vendor, so its writer must set
 * `audit_log.vendor_id`. `apps/api/src/routes/audit-vendor-id-writers.spec.ts`
 * fails the build when a writer of a listed action omits it, and when a
 * `/api/vendor/*` route writes an audit row without `vendorAuditEntry`.
 *
 * AECI-1194 reuses this list as the allow-list for the vendor change-history
 * read: only `receipt: true` actions are shown to the vendor.
 *
 * `kind` names the usual writer, for the history page's "who" column default:
 *  - `vendor-edit`: a vendor seat changed its own records through the portal;
 *  - `aeci-override`: an AECi operator acted on something the vendor holds;
 *  - `system`: a cron, a sweep or an ops tool, with no human actor.
 * Several actions have more than one writer (`product.updated` is written by a
 * vendor edit, an admin logo override and a seat hand-back). The row's own
 * `actor_type` and `metadata.source` decide which one a given row is. `kind` is
 * only the default.
 *
 * Adding a vendor-scoped action means adding it here. The spec then holds its
 * writer to the `vendor_id` rule.
 */

/** Who usually writes the action. See the module comment. */
export type AuditVendorActionKind = 'vendor-edit' | 'aeci-override' | 'system';

/** One registry entry. `receipt` says whether the vendor's history shows it. */
export interface AuditVendorAction {
  kind: AuditVendorActionKind;
  receipt: boolean;
}

/** The registry. Keys are `audit_log.action` values. */
export const AUDIT_VENDOR_ACTIONS = {
  // ── The vendor's company and product records ──────────────────────────────
  'vendor.updated': { kind: 'vendor-edit', receipt: true },
  'vendor.reviewed': { kind: 'vendor-edit', receipt: true },
  'product.updated': { kind: 'vendor-edit', receipt: true },
  'product.reviewed': { kind: 'vendor-edit', receipt: true },
  'product.integrations_reviewed': { kind: 'vendor-edit', receipt: true },
  'product_version.created': { kind: 'vendor-edit', receipt: true },
  'product_version.updated': { kind: 'vendor-edit', receipt: true },
  'product_version.deleted': { kind: 'vendor-edit', receipt: true },

  // ── Integrations the vendor owns or attests ───────────────────────────────
  'claim.created': { kind: 'vendor-edit', receipt: true },
  'attestation.created': { kind: 'vendor-edit', receipt: true },
  'attestation.retracted': { kind: 'vendor-edit', receipt: true },
  'integration.created': { kind: 'vendor-edit', receipt: true },
  'integration.claimed': { kind: 'vendor-edit', receipt: true },
  'integration.updated': { kind: 'vendor-edit', receipt: true },
  'integration.link_set': { kind: 'vendor-edit', receipt: true },
  'integration.link_removed': { kind: 'vendor-edit', receipt: true },
  'integration.retired': { kind: 'vendor-edit', receipt: true },
  'integration.restored': { kind: 'vendor-edit', receipt: true },
  'connector_mapping.updated': { kind: 'vendor-edit', receipt: true },

  // ── Field contests and protests ───────────────────────────────────────────
  'integration.contest.submitted': { kind: 'vendor-edit', receipt: true },
  'integration.contest.withdrawn': { kind: 'vendor-edit', receipt: true },
  'integration.contest.accepted': { kind: 'vendor-edit', receipt: true },
  'integration.contest.declined': { kind: 'vendor-edit', receipt: true },
  'integration.contest.protested': { kind: 'vendor-edit', receipt: true },
  'integration.contest.protest_replied': { kind: 'vendor-edit', receipt: true },
  'integration.contest.protest_withdrawn': { kind: 'vendor-edit', receipt: true },
  'integration.contest.protest_upheld': { kind: 'aeci-override', receipt: true },
  'integration.contest.protest_rejected': { kind: 'aeci-override', receipt: true },
  'integration.contest.lapsed': { kind: 'system', receipt: true },
  'integration.contest.rerouted': { kind: 'system', receipt: true },
  'integration.contest.seat_stamp_cleared': { kind: 'system', receipt: true },

  // ── Replies to reviews ────────────────────────────────────────────────────
  'review_response.submitted': { kind: 'vendor-edit', receipt: true },
  'review_response.edited': { kind: 'vendor-edit', receipt: true },
  'review_response.withdrawn': { kind: 'vendor-edit', receipt: true },
  'review_response.approved': { kind: 'aeci-override', receipt: true },
  'review_response.rejected': { kind: 'aeci-override', receipt: true },
  'review_response.removed': { kind: 'aeci-override', receipt: true },

  // ── Seats ─────────────────────────────────────────────────────────────────
  'vendor_seat.invited': { kind: 'vendor-edit', receipt: true },
  'vendor_seat.invite_resent': { kind: 'vendor-edit', receipt: true },
  'vendor_seat.invite_revoked': { kind: 'vendor-edit', receipt: true },
  'vendor_seat.invite_accepted': { kind: 'vendor-edit', receipt: true },
  'vendor_seat.provisioned': { kind: 'aeci-override', receipt: true },
  'vendor_claim.granted': { kind: 'aeci-override', receipt: true },
  'vendor_claim.seat_revoked': { kind: 'aeci-override', receipt: true },
  'vendor_admin.banned': { kind: 'aeci-override', receipt: true },
  'vendor_admin.unbanned': { kind: 'aeci-override', receipt: true },
  // A seat's own mute setting. About the seat, not the listing.
  'notification_preferences.updated': { kind: 'vendor-edit', receipt: false },

  // ── The plan ──────────────────────────────────────────────────────────────
  'vendor_entitlement.set': { kind: 'aeci-override', receipt: true },
  'vendor_entitlement.granted': { kind: 'aeci-override', receipt: true },
  'vendor_entitlement.renewed': { kind: 'aeci-override', receipt: true },
  'vendor_entitlement.cleared': { kind: 'aeci-override', receipt: true },
  'vendor_entitlement.expiry_warned': { kind: 'system', receipt: true },

  // ── AECi field corrections with a lock (AECI-1237, §11d.5) ────────────────
  // `integration.*` covers both anchor tables, as `integration.updated` does; the
  // row's `entity_type` says which.
  'vendor.field_overridden': { kind: 'aeci-override', receipt: true },
  'vendor.override_lifted': { kind: 'aeci-override', receipt: true },
  'product.field_overridden': { kind: 'aeci-override', receipt: true },
  'product.override_lifted': { kind: 'aeci-override', receipt: true },
  'integration.field_overridden': { kind: 'aeci-override', receipt: true },
  'integration.override_lifted': { kind: 'aeci-override', receipt: true },

  // ── Connector catalogues ──────────────────────────────────────────────────
  'connector_catalog.managed_by_vendor': { kind: 'aeci-override', receipt: true },
  'connector_catalog.managed_by_review': { kind: 'aeci-override', receipt: true },

  // ── Not receipts ──────────────────────────────────────────────────────────
  // The Messages ledger. `vendor_id` is the RECIPIENT; the feed is its reader.
  'notification.sent': { kind: 'system', receipt: false },
  // An ops retraction. The vendor no longer exists to read a history.
  'vendor.deleted': { kind: 'system', receipt: false },
} as const satisfies Record<string, AuditVendorAction>;

/** One vendor-scoped action. */
export type AuditVendorActionName = keyof typeof AUDIT_VENDOR_ACTIONS;

/** Every vendor-scoped action, in registry order. */
export const AUDIT_VENDOR_ACTION_NAMES = Object.keys(
  AUDIT_VENDOR_ACTIONS,
) as AuditVendorActionName[];

/** The actions the vendor's change history shows (AECI-1194's allow-list). */
export const AUDIT_VENDOR_RECEIPT_ACTIONS = AUDIT_VENDOR_ACTION_NAMES.filter(
  (action) => AUDIT_VENDOR_ACTIONS[action].receipt,
);

/** Whether an action is vendor-scoped. */
export function isAuditVendorAction(action: string): action is AuditVendorActionName {
  return Object.prototype.hasOwnProperty.call(AUDIT_VENDOR_ACTIONS, action);
}
