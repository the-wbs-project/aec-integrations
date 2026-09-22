import {
  CONTEST_URL_FIELDS,
  CONTEST_VALUE_MAX_LENGTH,
  INTEGRATION_CONTEST_FIELDS,
  contestValueProblem,
  type ContestNotificationEvent,
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

/**
 * The notification archive's title for a contest event. The recipient is always
 * the OTHER side (§11b.8): `submitted` and `withdrawn` reach the owner, the two
 * decisions and a retire's close (AECI-1010) reach the submitter, so each
 * sentence is written from that seat.
 */
export function contestNotificationTitle(event: ContestNotificationEvent): string {
  switch (event) {
    case 'submitted':
      return $localize`:@@vendor.contest.notify.submitted:Another vendor contested a field on your integration`;
    case 'withdrawn':
      return $localize`:@@vendor.contest.notify.withdrawn:A contest on your integration was withdrawn`;
    case 'accepted':
      return $localize`:@@vendor.contest.notify.accepted:Your contest was accepted`;
    case 'declined':
      return $localize`:@@vendor.contest.notify.declined:Your contest was declined`;
    case 'closed_by_retire':
      return $localize`:@@vendor.contest.notify.closedByRetire:Your contest was closed because the owner retired the integration`;
  }
}

/**
 * The one sentence under a contest event's title that says what it means for the
 * recipient, or `null` when the title already says it all (AECI-1023).
 *
 * `accepted` carries no note on purpose. What an accept changes depends on who
 * decided and whether the row was claimed (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.6), and the event does not say which, so any sentence about when the page
 * changes would be wrong for some rows. `declined` says the value stays, and
 * nothing more: a protest to AECi (AECI-1009) is designed, not built, so the
 * note must not offer one.
 */
export function contestNotificationNote(event: ContestNotificationEvent): string | null {
  switch (event) {
    case 'submitted':
      return $localize`:@@vendor.contest.notify.note.submitted:Accept or decline it under Field contests in Messages. Until you decide, the public page keeps the value on record.`;
    case 'declined':
      return $localize`:@@vendor.contest.notify.note.declined:The value on record stays as it is.`;
    case 'closed_by_retire':
      return $localize`:@@vendor.contest.notify.note.closedByRetire:Restoring the integration does not reopen your contest. If it comes back and you still want the change, send a new one.`;
    case 'withdrawn':
    case 'accepted':
      return null;
  }
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
    case 'RATE_LIMITED':
      return $localize`:@@vendor.contest.submit.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.contest.submit.error.generic:Could not send your contest. Try again.`;
  }
}
