/**
 * Machine-readable error codes returned in `ApiError.error.code`. Stable
 * identifiers — messages localize, codes do not. Sourced from the table in
 * docs/API_CONTRACTS.md §4. Keep this in sync with that document.
 */
export const ApiErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVIEW_DUPLICATE: 'REVIEW_DUPLICATE',
  REVIEW_BANNED: 'REVIEW_BANNED',
  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  SLUG_CONFLICT: 'SLUG_CONFLICT',
  GRANT_CONFLICT: 'GRANT_CONFLICT',
  /** A vendor seat invite was addressed to a domain that is not the vendor's own
   *  (AECI-664). Distinct from `VALIDATION_FAILED` — the payload is well-formed
   *  and the address may be perfectly real; this is a POLICY refusal, and the
   *  client renders a specific next step ("ask them to submit a claim") that no
   *  generic validation message could. */
  INVITE_DOMAIN_MISMATCH: 'INVITE_DOMAIN_MISMATCH',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
