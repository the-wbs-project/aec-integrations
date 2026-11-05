import { ApiErrorCode } from '@aeci/shared';

import { isStatus } from './http-status';

/**
 * The vendor a `409 VENDOR_LAST_SEAT_USE_SUSPEND` names, or `null` for any other error
 * (AECI-1623). Every surface that bans an account uses this: the refusal must point at
 * Suspend on the vendor page, because retrying can never succeed. Structural, as
 * `isStatus` is: the admin area is lazily chunked.
 */
export function lastSeatRefusalVendorId(err: unknown): string | null {
  if (!isStatus(err, 409)) return null;
  const inner = (
    err as { error?: { error?: { code?: unknown; details?: { vendor_id?: unknown } } } }
  ).error?.error;
  if (inner?.code !== ApiErrorCode.VENDOR_LAST_SEAT_USE_SUSPEND) return null;
  const vendorId = inner.details?.vendor_id;
  return typeof vendorId === 'string' ? vendorId : null;
}
