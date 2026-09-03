/**
 * `audit_log.action` rendered in English (AECI-694).
 *
 * The audit trail printed the raw token (`vendor_entitlement.expiry_warned`) in
 * monospace and nothing else, which made the platform's only ledger readable
 * exclusively by someone who already knew the vocabulary. This maps the ~40
 * strings actually written by the API to a short sentence-case phrase. The raw
 * token stays on screen underneath it: an operator correlating a row against a
 * log line or a `db.batch` still needs the exact value.
 *
 * ── THE FALLBACK IS LOAD-BEARING, NOT POLITENESS ─────────────────────────────
 * `AdminAuditRowSchema.action` is a plain `z.string()` and `entity_type` carries
 * no CHECK, both on purpose: a new writer anywhere in the API must not turn this
 * screen into a 500 (`packages/shared/src/api/admin-vendors.ts`). On top of that
 * `audit_log` is hard-excluded from the retention prune, so today's reader is
 * parsing rows written by code that no longer exists. An unmapped action
 * therefore has to render as something sensible, which is what
 * {@link humanizeAction} does. Never convert this map to a closed union.
 *
 * ── WHAT THIS CANNOT SAY, AND WHY ────────────────────────────────────────────
 * `metadata` is NOT on the wire. `GET /api/admin/vendors/:id/audit` selects
 * `before_state` / `after_state` and deliberately omits `metadata`, so `source`,
 * `vendor_id`, the changed `fields` array and any operator `reason` are all
 * invisible here. Descriptions must be derivable from `action` alone; anything
 * richer ("changed 3 fields", "via the vendor portal") needs the handler and the
 * response schema to carry metadata first, which is a separate API change.
 *
 * Two action families are TEMPLATED at their call sites and so are expanded
 * here rather than pattern-matched:
 *   - `${entity}.created` for `category` / `audience` / `phase` (promote.ts)
 *   - `${seatRole}.banned|unbanned` for `reviewer` / `vendor_admin`
 *     (admin-reviewers.ts, role-aware since AECI-524)
 */

/**
 * The closed part of an open vocabulary. Keys are exactly the action strings
 * emitted by an `auditInsert` call site in `apps/api/src`; the values are what an
 * operator reads.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  // ── Catalog, written by the promote Workflow (actor: system) ──────────────
  'vendor.created': $localize`:@@admin.audit.action.vendorCreated:Vendor added to the catalog`,
  'vendor.updated': $localize`:@@admin.audit.action.vendorUpdated:Vendor record updated`,
  'product.created': $localize`:@@admin.audit.action.productCreated:Product added to the catalog`,
  'product.updated': $localize`:@@admin.audit.action.productUpdated:Product record updated`,
  'product.extension_created': $localize`:@@admin.audit.action.productExtensionCreated:Product extension created`,
  'integration.created': $localize`:@@admin.audit.action.integrationCreated:Integration added`,
  'integration.updated': $localize`:@@admin.audit.action.integrationUpdated:Integration updated`,
  'category.created': $localize`:@@admin.audit.action.categoryCreated:Category term created`,
  'audience.created': $localize`:@@admin.audit.action.audienceCreated:Audience term created`,
  'phase.created': $localize`:@@admin.audit.action.phaseCreated:Phase term created`,
  'promote.blocked': $localize`:@@admin.audit.action.promoteBlocked:Promote blocked by a guard`,

  // ── Claims and attestations ───────────────────────────────────────────────
  'claim.created': $localize`:@@admin.audit.action.claimCreated:Integration claim recorded`,
  'claim.deleted': $localize`:@@admin.audit.action.claimDeleted:Integration claim removed`,
  'claim.converted': $localize`:@@admin.audit.action.claimConverted:Claim reassigned to the vendor`,
  'attestation.created': $localize`:@@admin.audit.action.attestationCreated:Attestation added`,
  'attestation.retracted': $localize`:@@admin.audit.action.attestationRetracted:Attestation retracted`,

  // ── Product versions, written from the vendor portal ──────────────────────
  'product_version.created': $localize`:@@admin.audit.action.versionCreated:Product version added`,
  'product_version.updated': $localize`:@@admin.audit.action.versionUpdated:Product version updated`,
  'product_version.deleted': $localize`:@@admin.audit.action.versionDeleted:Product version removed`,

  // ── Reviews ───────────────────────────────────────────────────────────────
  'review.submitted': $localize`:@@admin.audit.action.reviewSubmitted:Review submitted`,
  'review.approved': $localize`:@@admin.audit.action.reviewApproved:Review approved`,
  'review.rejected': $localize`:@@admin.audit.action.reviewRejected:Review rejected`,

  // ── Requests (the form to Linear pipeline) ────────────────────────────────
  'vendor_request.created': $localize`:@@admin.audit.action.requestCreated:Request filed`,
  'vendor_request.resolved': $localize`:@@admin.audit.action.requestResolved:Request approved`,
  'vendor_request.rejected': $localize`:@@admin.audit.action.requestRejected:Request rejected`,
  'vendor_request.status_changed': $localize`:@@admin.audit.action.requestStatusChanged:Request status changed in Linear`,

  // ── Claim approval and the seats it grants ────────────────────────────────
  'vendor_claim.granted': $localize`:@@admin.audit.action.claimGranted:Vendor claim approved`,
  'vendor_claim.rejected': $localize`:@@admin.audit.action.claimRejected:Vendor claim rejected`,
  'vendor_claim.seat_revoked': $localize`:@@admin.audit.action.seatRevoked:Portal seat revoked`,
  // AECI-739. These rows carry the operator note in `before_state`/`after_state`,
  // which is what makes the audit trail the note's HISTORY rather than the column.
  // They surface here because `/admin/vendors/:id`'s trail is scoped partly by
  // `entity_type='vendor_request'` over the vendor's claims.
  'vendor_claim.note_updated': $localize`:@@admin.audit.action.claimNoteUpdated:Operator note updated on a claim`,
  'vendor_seat.invited': $localize`:@@admin.audit.action.seatInvited:Seat invitation sent`,
  'vendor_seat.invite_revoked': $localize`:@@admin.audit.action.seatInviteRevoked:Seat invitation revoked`,
  'vendor_seat.invite_accepted': $localize`:@@admin.audit.action.seatInviteAccepted:Seat invitation accepted`,

  // ── Entitlements. `entity_id` on these rows is the VENDOR id, not the
  //    entitlement row id, so the whole trail shares one index key. ──────────
  'vendor_entitlement.set': $localize`:@@admin.audit.action.entitlementSet:Entitlement set`,
  'vendor_entitlement.renewed': $localize`:@@admin.audit.action.entitlementRenewed:Entitlement renewed`,
  'vendor_entitlement.cleared': $localize`:@@admin.audit.action.entitlementCleared:Entitlement cleared`,
  'vendor_entitlement.granted': $localize`:@@admin.audit.action.entitlementGranted:Entitlement granted with a claim approval`,
  'vendor_entitlement.expiry_warned': $localize`:@@admin.audit.action.entitlementExpiryWarned:Entitlement expiry warning sent`,

  // ── Moderation. Role-aware since AECI-524: the same endpoint writes
  //    `reviewer.*` or `vendor_admin.*` depending on the target's role. ──────
  'reviewer.banned': $localize`:@@admin.audit.action.reviewerBanned:Reviewer banned`,
  'reviewer.unbanned': $localize`:@@admin.audit.action.reviewerUnbanned:Reviewer reinstated`,
  'vendor_admin.banned': $localize`:@@admin.audit.action.vendorAdminBanned:Vendor admin banned`,
  'vendor_admin.unbanned': $localize`:@@admin.audit.action.vendorAdminUnbanned:Vendor admin reinstated`,

  // ── Accounts ──────────────────────────────────────────────────────────────
  'profile.created': $localize`:@@admin.audit.action.profileCreated:Account profile created`,
  'profile.updated': $localize`:@@admin.audit.action.profileUpdated:Account profile updated`,
  'account.deleted': $localize`:@@admin.audit.action.accountDeleted:Account deleted by its owner`,

  // ── Connector lane (AECI-720 flips, AECI-714 sync) ────────────────────────
  // The sync row is included deliberately: on `/admin/connectors/:id` it is the
  // durable record of when a vendor's feed last delivered anything, so it must
  // read as prose rather than fall through `humanizeAction` to "Connector
  // catalog synced".
  'connector_catalog.managed_by_vendor': $localize`:@@admin.audit.action.connectorHandedToVendor:Catalogue handed to a vendor (review lane frozen)`,
  'connector_catalog.managed_by_review': $localize`:@@admin.audit.action.connectorReclaimed:Catalogue reclaimed (review lane re-opened)`,
  'connector_catalog.synced': $localize`:@@admin.audit.action.connectorSynced:Catalogue feed delivered`,

  // ── System ────────────────────────────────────────────────────────────────
  'notification.sent': $localize`:@@admin.audit.action.notificationSent:Notification sent`,
  'retention.pruned': $localize`:@@admin.audit.action.retentionPruned:Old records pruned`,
};

/**
 * Turn an unmapped `entity.verb` token into a readable phrase:
 * `data_object.created` becomes "Data object created".
 *
 * Deliberately dumb. It is a graceful degradation for an action this build has
 * never heard of, not a second vocabulary, so it must never guess at meaning.
 */
function humanizeAction(action: string): string {
  const words = action.replace(/[._]+/g, ' ').trim();
  if (!words) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What happened, in English. Never throws and never returns an empty string. */
export function describeAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? humanizeAction(action);
}

/** True when this build recognises the action. Used only by the spec, to assert
 *  the map and the fallback are exercised separately. */
export function isKnownAuditAction(action: string): boolean {
  return action in ACTION_LABELS;
}
