import { HttpErrorResponse } from '@angular/common/http';

/** Which Billing tab license action failed (AECI-1391, E5.5). The generic copy names it. */
export type VendorLicenseAction = 'assign' | 'release' | 'request';

/** The error envelope's `code`, or `null` when the failure carried none. */
export function licenseActionErrorCode(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  return (err.error as { error?: { code?: string } } | null)?.error?.code ?? null;
}

/**
 * Whether a refusal means our copy of the license is out of date (a `409` or a
 * `404`). The caller re-reads billing so the table shows the server's state.
 */
export function licenseActionIsStale(err: unknown): boolean {
  return err instanceof HttpErrorResponse && (err.status === 409 || err.status === 404);
}

/**
 * Map a license write's refusal onto copy that says what happened and what to do
 * (`API_CONTRACTS.md` §4 and §6.14). One table for the three Billing tab actions,
 * so the same code always reads the same.
 */
export function licenseActionErrorMessage(err: unknown, action: VendorLicenseAction): string {
  const status = err instanceof HttpErrorResponse ? err.status : null;
  const code = licenseActionErrorCode(err);
  switch (code) {
    case 'LICENSE_NOT_LIVE':
      return $localize`:@@vendor.billing.error.notLive:This license has ended, so it cannot go on a product.`;
    case 'LICENSE_ALREADY_ASSIGNED':
      return $localize`:@@vendor.billing.error.alreadyAssigned:This license is already on a product. The table now shows where.`;
    case 'PRODUCT_ALREADY_LICENSED':
      return $localize`:@@vendor.billing.error.productLicensed:That product already holds a license, possibly from a co-owner. Pick another product.`;
    case 'LICENSE_NOT_ASSIGNED':
      return $localize`:@@vendor.billing.error.notAssigned:This license is no longer on a product, or it has ended.`;
    case 'RELEASE_REQUEST_OPEN':
      return $localize`:@@vendor.billing.error.requestOpen:An early unassign request for this license is already open. AEC Integrations will answer it.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.billing.error.rate:Too many changes in a short time. Try again in a minute.`;
  }
  switch (status) {
    case 429:
      return $localize`:@@vendor.billing.error.rate:Too many changes in a short time. Try again in a minute.`;
    case 403:
      return $localize`:@@vendor.billing.error.forbidden:Only an account owner can manage licenses.`;
    case 404:
      return $localize`:@@vendor.billing.error.notFound:That license or product is no longer on your account. The table has been refreshed.`;
    case 400:
      return action === 'request'
        ? $localize`:@@vendor.billing.error.reason:Give a reason of up to 1,000 characters.`
        : $localize`:@@vendor.billing.error.invalid:That request was not valid. Refresh the page and try again.`;
  }
  switch (action) {
    case 'assign':
      return $localize`:@@vendor.billing.error.assignGeneric:Could not assign the license. Try again.`;
    case 'release':
      return $localize`:@@vendor.billing.error.releaseGeneric:Could not save the setting. It has not changed. Try again.`;
    case 'request':
      return $localize`:@@vendor.billing.error.requestGeneric:Could not send the request. Try again.`;
  }
}
