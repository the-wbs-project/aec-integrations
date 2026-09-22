import {
  CONTEST_URL_FIELDS,
  CONTEST_VALUE_MAX_LENGTH,
  INTEGRATION_CONTEST_FIELDS,
  contestValueProblem,
  type ContestNotificationEvent,
  type ContestProtestStatus,
  type ContestRoute,
  type ContestStatus,
  type ContextDirection,
  type IntegrationContestField,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { readVendorApiError } from '../vendor-api-error';

/**
 * Vendor-facing copy for integration field contests (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b), kept in one file for the same reason
 * `vendor-attestation-labels.ts` is: the contest form, the Messages lists and the
 * notification archive all name the same fields and states, and three spellings
 * of one field would drift.
 *
 * Every `switch` is total over its shared enum, so adding a field, a status or
 * an event is a compile error here rather than a blank label on a vendor's
 * screen.
 */

/** The field's name as a vendor reads it. */
export function contestFieldLabel(field: IntegrationContestField): string {
  switch (field) {
    case 'name':
      return $localize`:@@vendor.contest.field.name:Name`;
    case 'mechanism_kind':
      return $localize`:@@vendor.contest.field.mechanismKind:Integration type`;
    case 'mechanism_name':
      return $localize`:@@vendor.contest.field.mechanismName:Mechanism name`;
    case 'direction':
      return $localize`:@@vendor.contest.field.direction:Direction`;
    case 'description':
      return $localize`:@@vendor.contest.field.description:Description`;
    case 'listing_url':
      return $localize`:@@vendor.contest.field.listingUrl:Listing link`;
    case 'docs_url':
      return $localize`:@@vendor.contest.field.docsUrl:Documentation link`;
    case 'website':
      return $localize`:@@vendor.contest.field.website:Website`;
    case 'mechanism_url':
      return $localize`:@@vendor.contest.field.mechanismUrl:Mechanism link`;
    case 'pricing_model':
      return $localize`:@@vendor.contest.field.pricingModel:Pricing`;
    case 'maturity':
      return $localize`:@@vendor.contest.field.maturity:Maturity`;
    case 'owner':
      return $localize`:@@vendor.contest.field.integrationOwner:Owner`;
  }
}

/** A field name from the notification feed, which types it as a plain string
 *  (a snapshot that may predate a vocabulary change). Unknown names render
 *  as-is rather than blank. */
export function contestFieldLabelLoose(field: string): string {
  return isContestField(field) ? contestFieldLabel(field) : field;
}

const FIELDS: ReadonlySet<string> = new Set<string>(INTEGRATION_CONTEST_FIELDS);

function isContestField(field: string): field is IntegrationContestField {
  return FIELDS.has(field);
}

/** "Neither endpoint vendor", the `owner` field's `null` proposal. */
export function noOwnerLabel(): string {
  return $localize`:@@vendor.contest.owner.none:Neither endpoint vendor`;
}

/**
 * One value, as a vendor reads it.
 *
 * `label` is the server's display name for an `owner` value (a vendor id is not
 * readable). `direction` is caller-relative on every vendor read, so it renders
 * as the pair page's own sentence against the other product.
 */
export function contestValueDisplay(
  field: IntegrationContestField,
  value: string | null,
  label: string | null,
  otherProductName: string,
): string {
  if (field === 'owner') {
    if (value === null) return noOwnerLabel();
    return label ?? value;
  }
  if (value === null || value === '') {
    return $localize`:@@vendor.contest.value.none:Not on record`;
  }
  if (field === 'mechanism_kind') return mechanismKindLabel(value) || value;
  if (field === 'direction' && isContextDirection(value)) {
    return directionHeading(value, otherProductName);
  }
  return value;
}

function isContextDirection(value: string): value is ContextDirection {
  return value === 'inbound' || value === 'outbound' || value === 'both';
}

export function contestStatusLabel(status: ContestStatus): string {
  switch (status) {
    case 'open':
      return $localize`:@@vendor.contest.status.open:Open`;
    case 'accepted':
      return $localize`:@@vendor.contest.status.accepted:Accepted`;
    case 'declined':
      return $localize`:@@vendor.contest.status.declined:Declined`;
    case 'withdrawn':
      return $localize`:@@vendor.contest.status.withdrawn:Withdrawn`;
  }
}

/** Who decides an open contest, from the submitter's side. */
export function contestRouteLabel(route: ContestRoute): string {
  switch (route) {
    case 'owner':
      return $localize`:@@vendor.contest.route.owner:With the owner`;
    case 'aeci':
      return $localize`:@@vendor.contest.route.aeci:With AEC Integrations`;
  }
}

/** The fields of a contest notification the title and note read. */
export interface ContestNotificationLike {
  readonly event: ContestNotificationEvent;
  readonly recipient_role?: 'submitter' | 'owner' | null;
  readonly protest_closes_at?: string | null;
  readonly reply_due_at?: string | null;
  readonly cooldown_until?: string | null;
  /** AECI-1046: who retired the integration, on a `closed_by_retire` row. */
  readonly retired_by?: 'owner' | 'aeci' | null;
}

/**
 * The notification archive's title for a contest event. The recipient is always
 * the OTHER side (§11b.8): `submitted` and `withdrawn` reach the owner, the two
 * decisions and a retire's close (AECI-1010) reach the submitter, so each
 * sentence is written from that seat. The two protest decisions (AECI-1009) reach
 * BOTH sides, told apart by `recipient_role`.
 *
 * The `default` branch is the deploy-skew fallback: a web build older than the
 * API meets an event it does not know, and must still render a title.
 */
export function contestNotificationTitle(notification: ContestNotificationLike): string {
  const owner = notification.recipient_role === 'owner';
  switch (notification.event) {
    case 'submitted':
      return $localize`:@@vendor.contest.notify.submitted:Another vendor contested a field on your integration`;
    case 'withdrawn':
      return $localize`:@@vendor.contest.notify.withdrawn:A contest on your integration was withdrawn`;
    case 'accepted':
      return $localize`:@@vendor.contest.notify.accepted:Your contest was accepted`;
    case 'declined':
      return $localize`:@@vendor.contest.notify.declined:Your contest was declined`;
    case 'closed_by_retire':
      // AECI-1046: an admin retire names AEC Integrations, not the owner.
      return notification.retired_by === 'aeci'
        ? $localize`:@@vendor.contest.notify.closedByAeciRetire:Your contest was closed because AEC Integrations retired the integration`
        : $localize`:@@vendor.contest.notify.closedByRetire:Your contest was closed because the owner retired the integration`;
    case 'protested':
      return $localize`:@@vendor.contest.notify.protested:A vendor asked AEC Integrations to review a contest on your integration`;
    case 'protest_replied':
      return $localize`:@@vendor.contest.notify.protestReplied:The owner replied to your review request`;
    case 'protest_withdrawn':
      return $localize`:@@vendor.contest.notify.protestWithdrawn:A review request on your integration was withdrawn`;
    case 'protest_upheld':
      return owner
        ? $localize`:@@vendor.contest.notify.protestUpheld.owner:AEC Integrations agrees with a contest on your integration`
        : $localize`:@@vendor.contest.notify.protestUpheld.submitter:AEC Integrations agrees with your contest`;
    case 'protest_rejected':
      return owner
        ? $localize`:@@vendor.contest.notify.protestRejected.owner:AEC Integrations agrees with your decision`
        : $localize`:@@vendor.contest.notify.protestRejected.submitter:AEC Integrations agrees with the owner`;
    default:
      return $localize`:@@vendor.contest.notify.fallback:An update on a field contest`;
  }
}

/**
 * The one sentence under a contest event's title that says what it means for the
 * recipient, or `null` when the title already says it all (AECI-1023).
 *
 * `accepted` carries no note on purpose. What an accept changes depends on who
 * decided and whether the row was claimed (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.6), and the event does not say which, so any sentence about when the page
 * changes would be wrong for some rows.
 *
 * `declined` offers a review by AEC Integrations (AECI-1009) only when the row
 * carries `protest_closes_at`, which the server sets on an OWNER decline alone. An
 * AECi decline, and every row written before AECI-1009, says the value stays and
 * nothing more. `formatDate` renders the dates in the page's locale.
 */
export function contestNotificationNote(
  notification: ContestNotificationLike,
  formatDate: (iso: string) => string,
): string | null {
  const owner = notification.recipient_role === 'owner';
  switch (notification.event) {
    case 'submitted':
      return $localize`:@@vendor.contest.notify.note.submitted:Accept or decline it under Field contests in Messages. Until you decide, the public page keeps the value on record.`;
    case 'declined': {
      const closes = notification.protest_closes_at;
      if (closes) {
        const date = formatDate(closes);
        return $localize`:@@vendor.contest.notify.note.declinedProtestable:The value on record stays as it is. If you disagree, you can ask AEC Integrations to review it until ${date}:DATE:, from Field contests in Messages.`;
      }
      return $localize`:@@vendor.contest.notify.note.declined:The value on record stays as it is.`;
    }
    case 'closed_by_retire':
      if (notification.retired_by === 'aeci') {
        return $localize`:@@vendor.contest.notify.note.closedByAeciRetire:Only AEC Integrations can restore the integration, and restoring it does not reopen your contest. If it comes back and you still want the change, send a new one.`;
      }
      return $localize`:@@vendor.contest.notify.note.closedByRetire:Restoring the integration does not reopen your contest. If it comes back and you still want the change, send a new one.`;
    case 'protested': {
      const due = notification.reply_due_at;
      if (!due) {
        return $localize`:@@vendor.contest.notify.note.protestedNoDate:You can reply once, under Field contests in Messages. Nothing about it is public.`;
      }
      const date = formatDate(due);
      return $localize`:@@vendor.contest.notify.note.protested:You can reply once, by ${date}:DATE:, under Field contests in Messages. Nothing about it is public.`;
    }
    case 'protest_upheld':
      return owner
        ? $localize`:@@vendor.contest.notify.note.protestUpheld.owner:This is advice. The value on record stays unless you change it.`
        : $localize`:@@vendor.contest.notify.note.protestUpheld.submitter:The owner has not changed the field. Only the owner can change it, so the value on record stays until it does.`;
    case 'protest_rejected': {
      if (owner) return null;
      const until = notification.cooldown_until;
      if (!until) return null;
      const date = formatDate(until);
      return $localize`:@@vendor.contest.notify.note.protestRejected:You can't contest this field again until ${date}:DATE:, unless its value changes.`;
    }
    default:
      return null;
  }
}

// ─── Protests (AECI-1009 / §11b.12) ──────────────────────────────────────────

/** A protest's state, as the pill beside it reads. */
export function protestStatusLabel(status: ContestProtestStatus): string {
  switch (status) {
    case 'open':
      return $localize`:@@vendor.protest.status.open:With AEC Integrations`;
    case 'upheld':
      return $localize`:@@vendor.protest.status.upheld:AEC Integrations agreed with the contest`;
    case 'rejected':
      return $localize`:@@vendor.protest.status.rejected:AEC Integrations agreed with the owner`;
    case 'withdrawn':
      return $localize`:@@vendor.protest.status.withdrawn:Review request withdrawn`;
  }
}

/** The refusals the three protest routes can answer, mapped to what to do next. */
export function protestErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'PROTEST_NOT_AVAILABLE': {
      const reason = info.details?.['reason'];
      if (reason === 'window_closed') {
        return $localize`:@@vendor.protest.error.windowClosed:The 30 days to ask for a review of this contest have passed.`;
      }
      if (reason === 'owner_not_silent_yet') {
        return $localize`:@@vendor.protest.error.notYet:The owner still has time to answer this contest.`;
      }
      if (reason === 'contest_open') {
        return $localize`:@@vendor.protest.error.contestOpen:You have an open contest on this field of this integration. Withdraw it, or wait for its answer, before you ask for a review.`;
      }
      if (reason === 'already_protested') {
        return $localize`:@@vendor.protest.error.already:This contest already has a review request.`;
      }
      return $localize`:@@vendor.protest.error.changed:This contest changed, for example the owner answered it. The list now shows where it stands.`;
    }
    case 'CONTEST_VALUE_STALE':
      return $localize`:@@vendor.protest.error.stale:The owner changed this field since. Contest the new value instead.`;
    case 'CONTEST_INTEGRATION_CHANGED':
      return $localize`:@@vendor.protest.error.newOwner:This integration has a new owner. Contest it again to reach them.`;
    case 'PROTEST_NOT_OPEN':
      return $localize`:@@vendor.protest.error.notOpen:This review request was already decided or withdrawn. The list now shows where it stands.`;
    case 'PROTEST_REPLY_EXISTS':
      return $localize`:@@vendor.protest.error.replyExists:A reply is already on file for this review request.`;
    case 'PROTEST_REPLY_CLOSED':
      return $localize`:@@vendor.protest.error.replyClosed:The time to reply has passed.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.protest.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.protest.error.invalid:Check the reason and the links. Each link must be a full web address.`;
    default:
      return $localize`:@@vendor.protest.error.generic:Could not save that. Try again.`;
  }
}

/** True for the refusals after which the list should reload to show the state
 *  that won. A validation or rate-limit error keeps the form as it is. */
export function protestErrorReloads(err: unknown): boolean {
  const code = readVendorApiError(err)?.code;
  return (
    code === 'PROTEST_NOT_AVAILABLE' ||
    code === 'CONTEST_VALUE_STALE' ||
    code === 'CONTEST_INTEGRATION_CHANGED' ||
    code === 'PROTEST_NOT_OPEN' ||
    code === 'PROTEST_REPLY_EXISTS' ||
    code === 'PROTEST_REPLY_CLOSED'
  );
}

/**
 * Why a proposal cannot be sent yet, in the vendor's words, or `null` when it
 * can. Runs the SAME shared rule the server applies (`contestValueProblem`) and
 * only chooses the sentence, so the form can never accept what the API refuses
 * for shape. The server remains the authority on `owner` membership.
 */
export function contestValueMessage(
  field: IntegrationContestField,
  proposed: string | null,
  current: string | null,
): string | null {
  const problem = contestValueProblem(field, proposed);
  if (problem !== null) {
    if (proposed === null || proposed === '') {
      return $localize`:@@vendor.contest.error.required:Enter the value you think is right.`;
    }
    if (proposed.length > CONTEST_VALUE_MAX_LENGTH[field]) {
      return $localize`:@@vendor.contest.error.tooLong:That value is too long.`;
    }
    if (CONTEST_URL_FIELDS.has(field)) {
      return $localize`:@@vendor.contest.error.url:Enter a full web address that starts with http:// or https://.`;
    }
    return $localize`:@@vendor.contest.error.invalid:That value is not valid for this field.`;
  }
  if (proposed === current) {
    return $localize`:@@vendor.contest.error.noChange:That is already the value on record. Change it before you send.`;
  }
  return null;
}

/** The refusals `POST …/contests` can answer, mapped to what to do next. */
export function contestSubmitErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'CONTEST_DUPLICATE':
      return $localize`:@@vendor.contest.submit.error.duplicate:You already have an open contest on this field. Withdraw it in Messages if you want to send a different value.`;
    case 'CONTEST_NO_CHANGE':
      return $localize`:@@vendor.contest.submit.error.noChange:That is already the value on record, so there is nothing to contest.`;
    case 'CONTEST_INVALID_VALUE':
      return $localize`:@@vendor.contest.submit.error.invalid:That value is not valid for this field. Check it and try again.`;
    case 'CONTEST_OWN_INTEGRATION':
      return $localize`:@@vendor.contest.submit.error.isOwner:Your company is recorded as the owner of this integration, so you cannot contest it.`;
    case 'CONTEST_PROTEST_OPEN':
      return $localize`:@@vendor.contest.submit.error.protestOpen:You asked AEC Integrations to review a contest on this field. Wait for its answer, or withdraw that request in Messages first.`;
    case 'CONTEST_COOLDOWN':
      return $localize`:@@vendor.contest.submit.error.cooldown:AEC Integrations agreed with the owner on this field, so you can't contest it again yet unless its value changes.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.contest.submit.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.contest.submit.error.generic:Could not send your contest. Try again.`;
  }
}
