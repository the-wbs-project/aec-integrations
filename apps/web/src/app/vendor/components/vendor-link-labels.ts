import { HttpsUrlSchema } from '@aeci/shared';

import { readVendorApiError } from '../vendor-api-error';

/**
 * Copy and the value rule for a company's own per-side links (AECI-1007,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7). Moved out of the retired
 * `vendor-integration-links-form.ts` by AECI-1156: the integration detail page's
 * "Integration links" section (§6.17.5) is the one editor now.
 */

/** Why a typed value cannot be saved, or `null` when it can. Blank is valid: it
 *  means "remove this link". Uses the server's own schema, so the two agree. */
export function linkValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return HttpsUrlSchema.safeParse(trimmed).success
    ? null
    : $localize`:@@vendor.links.error.url:Use a full link that starts with https://, such as https://example.com/integrations.`;
}

/** The save error, worded for the vendor. */
export function linkSaveErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'INTEGRATION_CONNECTOR_POWERED':
      return $localize`:@@vendor.links.error.connector:This integration is delivered through a connector product, so it cannot take your own links yet.`;
    case 'INTEGRATION_RETIRED':
      return $localize`:@@vendor.links.error.retired:This integration was retired by its owner, so its links cannot change until it is restored.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.links.error.invalid:One of the links is not valid. Check it and try again.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.links.error.notFound:Your company no longer lists this product, so you cannot set its links. Reload the page.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.links.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.links.error.generic:Could not save your links. Try again.`;
  }
}
