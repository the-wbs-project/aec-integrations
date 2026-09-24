import {
  CONTEST_URL_FIELDS,
  CONTEST_VALUE_MAX_LENGTH,
  integrationEditValueProblem,
  type IntegrationEditField,
} from '@aeci/shared';

import { readVendorApiError } from '../vendor-api-error';

/**
 * Vendor-facing copy for integration ownership: the claim (AECI-1005) and the
 * owner's edit (AECI-1006, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6). Field names
 * come from `vendor-contest-labels.ts`, because the edit form and the contest
 * form name the same eleven fields and two spellings would drift.
 *
 * The wording is AECI-1023's and matches `/methodology` "Who owns an integration":
 * the owner is the "Offered by" vendor, a claim stops AECi's catalogue updates,
 * and an `owner` contest always goes to AEC Integrations.
 */

/**
 * Why a value cannot be saved yet, in the vendor's words, or `null` when it can.
 * Runs the SAME shared rule the server applies (`integrationEditValueProblem`)
 * and only chooses the sentence, so the form can never accept what the API
 * refuses for shape.
 */
export function editValueMessage(field: IntegrationEditField, value: string | null): string | null {
  if (integrationEditValueProblem(field, value) === null) return null;
  if (value === null) {
    return $localize`:@@vendor.integrationEdit.error.required:This field cannot be empty.`;
  }
  if (value.length > CONTEST_VALUE_MAX_LENGTH[field]) {
    return $localize`:@@vendor.integrationEdit.error.tooLong:That value is too long.`;
  }
  if (CONTEST_URL_FIELDS.has(field)) {
    return $localize`:@@vendor.integrationEdit.error.url:Enter a full web address that starts with http:// or https://.`;
  }
  return $localize`:@@vendor.integrationEdit.error.invalid:That value is not valid for this field.`;
}

/** The refusals `PATCH /api/vendor/integrations/:id` can answer, mapped to what
 *  to do next. */
export function editSaveErrorMessage(err: unknown): string {
  switch (readVendorApiError(err)?.code) {
    case 'INTEGRATION_NOT_CLAIMED':
      return $localize`:@@vendor.integrationEdit.save.error.notClaimed:Claim this integration before you edit it. Reload the page to see its current state.`;
    case 'INTEGRATION_RETIRED':
      return $localize`:@@vendor.integrationEdit.save.error.retired:This integration was retired, so nothing was saved. Restore it to edit its details.`;
    case 'INTEGRATION_CHANGED_WHILE_SAVING':
      return $localize`:@@vendor.integrationEdit.save.error.changed:This integration changed while you were saving. Reload and try again.`;
    case 'INTEGRATION_NOT_OWNER':
      return $localize`:@@vendor.integrationEdit.save.error.notOwner:Your company is no longer recorded as the owner of this integration, so nothing was saved.`;
    case 'INTEGRATION_CONNECTOR_POWERED':
      return $localize`:@@vendor.integrationEdit.save.error.connector:Connector-delivered integrations cannot be edited yet, so nothing was saved.`;
    case 'INTEGRATION_INVALID_VALUE':
      return $localize`:@@vendor.integrationEdit.save.error.invalid:One of the values is not valid for its field. Check the form and try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.integrationEdit.save.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.integrationEdit.save.error.generic:Could not save your changes. Try again.`;
  }
}

/** The refusals `POST /api/vendor/integrations/:id/claim` can answer. */
export function claimErrorMessage(err: unknown): string {
  switch (readVendorApiError(err)?.code) {
    case 'INTEGRATION_ALREADY_CLAIMED':
      return $localize`:@@vendor.integrationClaim.error.already:Your company has already claimed this integration. Reload the page to edit it.`;
    case 'INTEGRATION_NOT_OWNER':
      return $localize`:@@vendor.integrationClaim.error.notOwner:Another company is now recorded as the owner of this integration, so it was not claimed.`;
    case 'INTEGRATION_CONNECTOR_POWERED':
      return $localize`:@@vendor.integrationClaim.error.connector:Connector-delivered integrations cannot be claimed yet.`;
    case 'INTEGRATION_CHANGED_WHILE_SAVING':
      return $localize`:@@vendor.integrationClaim.error.changed:This integration changed while you were claiming it, so it was not claimed. Reload and try again.`;
    case 'INTEGRATION_ENTITLEMENT_REQUIRED':
      return $localize`:@@vendor.integrationClaim.error.entitlement:Claiming an integration delivered through a connector needs an active plan, so it was not claimed. Contact AEC Integrations to activate or renew it.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.integrationClaim.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.integrationClaim.error.generic:Could not claim this integration. Try again.`;
  }
}
