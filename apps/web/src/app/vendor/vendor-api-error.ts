import { HttpErrorResponse } from '@angular/common/http';

/**
 * The parts of the API's error envelope the vendor dashboard actually branches
 * on (AECI-606).
 *
 * The envelope is `{ error: { code, message, field?, details? }, trace_id }`
 * (`ApiErrorSchema`), which arrives on `HttpErrorResponse.error`. Reading it
 * inline at each call site produced four different half-correct casts on the
 * attestation tab, and one of them has to be exactly right: the duplicate-claim
 * `400` carries `details.claim_id`, and the whole point of that id is that the
 * UI routes the vendor to the existing lane rather than dead-ending them.
 *
 * Structural, never `instanceof` on the envelope: the same reasoning as
 * `vendor-me.resolver.ts` — a shape check survives a bundle boundary, a class
 * identity check does not.
 */
export interface VendorApiErrorInfo {
  readonly status: number;
  readonly code: string | null;
  /** The field a `VALIDATION_FAILED` names, e.g. `data_object`. */
  readonly field: string | null;
  /** `details.claim_id` on the duplicate-claim 400, `null` on every other error. */
  readonly claimId: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read an API error envelope off a failed `VendorApi` call, or `null` when the
 * rejection is not one (an offline `HttpErrorResponse` with a `ProgressEvent`
 * body, a thrown `TypeError`, …). A `null` return means "no structured
 * information" and callers should fall back to their generic retry notice.
 */
export function readVendorApiError(err: unknown): VendorApiErrorInfo | null {
  if (!(err instanceof HttpErrorResponse)) return null;

  const envelope = err.error as { error?: Record<string, unknown> } | null | undefined;
  const inner = envelope?.error;
  if (typeof inner !== 'object' || inner === null) {
    // Still useful: the status alone distinguishes a 403 (verification flipped
    // mid-session) from a network failure.
    return { status: err.status, code: null, field: null, claimId: null };
  }

  const details = inner['details'];
  const claimId =
    typeof details === 'object' && details !== null
      ? str((details as Record<string, unknown>)['claim_id'])
      : null;

  return {
    status: err.status,
    code: str(inner['code']),
    field: str(inner['field']),
    claimId,
  };
}
