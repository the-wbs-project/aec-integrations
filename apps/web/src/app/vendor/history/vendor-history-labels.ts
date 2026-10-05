import type { VendorHistoryActorKind, VendorHistoryKind, VendorHistoryPlan } from '@aeci/shared';

import { planLabel } from '../vendor-plan';

/**
 * The vendor-facing words for the Changes page (AECI-1160,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.19).
 *
 * Modelled on `admin/audit/audit-action-labels.ts`, but written for the vendor,
 * not the operator: every phrase says what happened to THEIR listing, in plain
 * words, with no internal token on screen.
 *
 * ── THE FALLBACK IS LOAD-BEARING ─────────────────────────────────────────────
 * `VendorHistoryItem.action` is a plain string on the wire. The server filters to
 * the `receipt: true` actions of `@aeci/shared/audit-vendor-actions`, but a newer
 * API can add one before this build knows it. An unmapped action therefore
 * renders through {@link humanizeAction}. Never make this map a closed union.
 * `vendor-history-labels.component.spec.ts` holds every registry receipt action to a label.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  // ── The company and product records ──────────────────────────────────────
  'vendor.updated': $localize`:@@vendor.history.action.vendorUpdated:Company profile updated`,
  'vendor.reviewed': $localize`:@@vendor.history.action.vendorReviewed:Company profile marked as looking right`,
  'product.updated': $localize`:@@vendor.history.action.productUpdated:Product listing updated`,
  'product.reviewed': $localize`:@@vendor.history.action.productReviewed:Product listing marked as looking right`,
  'product.integrations_reviewed': $localize`:@@vendor.history.action.productIntegrationsReviewed:Product integrations marked as looking right`,
  'product_version.created': $localize`:@@vendor.history.action.productVersionCreated:Product version added`,
  'product_version.updated': $localize`:@@vendor.history.action.productVersionUpdated:Product version updated`,
  'product_version.deleted': $localize`:@@vendor.history.action.productVersionDeleted:Product version removed`,

  // ── Integrations ─────────────────────────────────────────────────────────
  'claim.created': $localize`:@@vendor.history.action.claimCreated:Integration claim made`,
  'attestation.created': $localize`:@@vendor.history.action.attestationCreated:Integration confirmed`,
  'attestation.retracted': $localize`:@@vendor.history.action.attestationRetracted:Integration confirmation withdrawn`,
  'integration.created': $localize`:@@vendor.history.action.integrationCreated:Integration added`,
  'integration.claimed': $localize`:@@vendor.history.action.integrationClaimed:Integration taken over`,
  'integration.updated': $localize`:@@vendor.history.action.integrationUpdated:Integration updated`,
  'integration.link_set': $localize`:@@vendor.history.action.integrationLinkSet:Integration link added`,
  'integration.link_removed': $localize`:@@vendor.history.action.integrationLinkRemoved:Integration link removed`,
  'integration.retired': $localize`:@@vendor.history.action.integrationRetired:Integration retired`,
  'integration.restored': $localize`:@@vendor.history.action.integrationRestored:Integration restored`,
  'connector_mapping.updated': $localize`:@@vendor.history.action.connectorMappingUpdated:Connector catalogue entry updated`,

  // ── AECi corrections with a lock (AECI-1237) ─────────────────────────────
  'vendor.field_overridden': $localize`:@@vendor.history.action.vendorFieldOverridden:Company profile detail corrected and locked by AECi`,
  'vendor.override_lifted': $localize`:@@vendor.history.action.vendorOverrideLifted:Lock lifted on a company profile detail`,
  'product.field_overridden': $localize`:@@vendor.history.action.productFieldOverridden:Product listing detail corrected and locked by AECi`,
  'product.override_lifted': $localize`:@@vendor.history.action.productOverrideLifted:Lock lifted on a product listing detail`,
  'integration.field_overridden': $localize`:@@vendor.history.action.integrationFieldOverridden:Integration detail corrected and locked by AECi`,
  'integration.override_lifted': $localize`:@@vendor.history.action.integrationOverrideLifted:Lock lifted on an integration detail`,

  // ── Field contests and protests ──────────────────────────────────────────
  'integration.contest.submitted': $localize`:@@vendor.history.action.contestSubmitted:Field contest sent`,
  'integration.contest.withdrawn': $localize`:@@vendor.history.action.contestWithdrawn:Field contest withdrawn`,
  'integration.contest.accepted': $localize`:@@vendor.history.action.contestAccepted:Field contest accepted`,
  'integration.contest.declined': $localize`:@@vendor.history.action.contestDeclined:Field contest declined`,
  'integration.contest.protested': $localize`:@@vendor.history.action.contestProtested:Contest decision sent to AECi`,
  'integration.contest.protest_replied': $localize`:@@vendor.history.action.contestProtestReplied:Reply added to a protest`,
  'integration.contest.protest_withdrawn': $localize`:@@vendor.history.action.contestProtestWithdrawn:Protest withdrawn`,
  'integration.contest.protest_upheld': $localize`:@@vendor.history.action.contestProtestUpheld:AECi upheld a protest`,
  'integration.contest.protest_rejected': $localize`:@@vendor.history.action.contestProtestRejected:AECi turned down a protest`,
  'integration.contest.lapsed': $localize`:@@vendor.history.action.contestLapsed:Field contest closed with no answer`,
  'integration.contest.rerouted': $localize`:@@vendor.history.action.contestRerouted:Field contest passed to the new owner`,
  'integration.contest.seat_stamp_cleared': $localize`:@@vendor.history.action.contestSeatStampCleared:Contest sender cleared after a seat left`,

  // ── Replies to reviews ───────────────────────────────────────────────────
  'review_response.submitted': $localize`:@@vendor.history.action.reviewResponseSubmitted:Review reply sent for approval`,
  'review_response.edited': $localize`:@@vendor.history.action.reviewResponseEdited:Review reply edited`,
  'review_response.withdrawn': $localize`:@@vendor.history.action.reviewResponseWithdrawn:Review reply withdrawn`,
  'review_response.approved': $localize`:@@vendor.history.action.reviewResponseApproved:Review reply approved`,
  'review_response.rejected': $localize`:@@vendor.history.action.reviewResponseRejected:Review reply not approved`,
  'review_response.removed': $localize`:@@vendor.history.action.reviewResponseRemoved:Review reply removed`,

  // ── Seats ────────────────────────────────────────────────────────────────
  'vendor_seat.invited': $localize`:@@vendor.history.action.seatInvited:Colleague invited`,
  'vendor_seat.invite_resent': $localize`:@@vendor.history.action.seatInviteResent:Invitation sent again`,
  'vendor_seat.invite_revoked': $localize`:@@vendor.history.action.seatInviteRevoked:Invitation cancelled`,
  'vendor_seat.invite_accepted': $localize`:@@vendor.history.action.seatInviteAccepted:Invitation accepted`,
  'vendor_seat.provisioned': $localize`:@@vendor.history.action.seatProvisioned:Seat added by AECi`,
  'vendor_claim.granted': $localize`:@@vendor.history.action.vendorClaimGranted:Company claim approved`,
  'vendor_claim.seat_revoked': $localize`:@@vendor.history.action.vendorClaimSeatRevoked:Seat removed by AECi`,
  'vendor_admin.banned': $localize`:@@vendor.history.action.vendorAdminBanned:Seat suspended`,
  'vendor_admin.unbanned': $localize`:@@vendor.history.action.vendorAdminUnbanned:Seat restored`,

  // ── The plan ─────────────────────────────────────────────────────────────
  'vendor_entitlement.set': $localize`:@@vendor.history.action.entitlementSet:Plan changed`,
  'vendor_entitlement.granted': $localize`:@@vendor.history.action.entitlementGranted:Plan started`,
  'vendor_entitlement.renewed': $localize`:@@vendor.history.action.entitlementRenewed:Plan renewed`,
  'vendor_entitlement.cleared': $localize`:@@vendor.history.action.entitlementCleared:Plan ended`,
  'vendor_entitlement.expiry_warned': $localize`:@@vendor.history.action.entitlementExpiryWarned:Plan end reminder sent`,

  // ── Connector catalogues ─────────────────────────────────────────────────
  'connector_catalog.managed_by_vendor': $localize`:@@vendor.history.action.catalogManagedByVendor:Connector catalogue handed to your team`,
  'connector_catalog.managed_by_review': $localize`:@@vendor.history.action.catalogManagedByReview:Connector catalogue taken back by AECi`,
};

/** `vendor_seat.invite_resent` → "Vendor seat invite resent". Never guesses meaning. */
function humanizeAction(action: string): string {
  const words = action.replace(/[._]+/g, ' ').trim();
  if (!words) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What happened, in plain words. Never throws and never returns an empty string. */
export function describeHistoryAction(action: string): string {
  return ACTION_LABELS[action] ?? humanizeAction(action);
}

/** True when this build has a written label for the action. For the coverage spec. */
export function hasHistoryActionLabel(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, action);
}

/** Words kept in capitals when a field name is humanized. */
const ACRONYMS = new Set(['url', 'id', 'api', 'sso', 'csv', 'ifc', 'bim', 'aec']);

/**
 * A changed field's key, readable: `logo_url` → "Logo URL", `primaryCategory` →
 * "Primary category". The wire carries key names only, never values.
 */
export function humanizeField(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  if (words.length === 0) return field;
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(' ');
}

/** Who made the change. */
export function historyActorLabel(kind: VendorHistoryActorKind): string {
  switch (kind) {
    case 'your_team':
      return $localize`:@@vendor.history.actor.yourTeam:Your team`;
    case 'aeci':
      return $localize`:@@vendor.history.actor.aeci:AECi`;
    default:
      return $localize`:@@vendor.history.actor.system:System`;
  }
}

/** The filter's options, in display order. */
export const HISTORY_KIND_ORDER: readonly VendorHistoryKind[] = ['all', 'vendor', 'aeci'];

export function historyKindLabel(kind: VendorHistoryKind): string {
  switch (kind) {
    case 'vendor':
      return $localize`:@@vendor.history.filter.vendor:Your team's edits`;
    case 'aeci':
      return $localize`:@@vendor.history.filter.aeci:AECi changes`;
    default:
      return $localize`:@@vendor.history.filter.all:All changes`;
  }
}

/**
 * The plan the row was written under, as the portal names it: Managed or Free.
 * Same fail-closed rule as `vendor-plan.ts` `isManaged`: only an `active` row
 * over a paid tier is Managed.
 */
export function historyPlanLabel(plan: VendorHistoryPlan): string {
  return planLabel(historyPlanIsManaged(plan) ? 'managed' : 'free');
}

/** Whether a row's plan snapshot is Managed. The rule {@link historyPlanLabel} names. */
export function historyPlanIsManaged(plan: VendorHistoryPlan): boolean {
  return plan.status === 'active' && plan.tier !== 'unclaimed' && plan.tier !== 'none';
}

/**
 * When the change happened, to the minute, in the reader's locale and time zone,
 * with the zone named: "Oct 3, 2026, 11:42 AM EDT" in en-US. The medium date plus
 * the short time, built on `Intl` because Angular's `DatePipe` names a zone only
 * as a GMT offset. A row is read on its own, so each one carries its zone.
 *
 * Runs in the browser only: the list loads after first render, so the server's
 * zone never reaches the page. `timeZone` exists for the specs.
 */
export function historyTimeFormatter(locale: string, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}
