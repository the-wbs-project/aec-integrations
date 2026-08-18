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
  SLUG_CONFLICT: 'SLUG_CONFLICT',
  GRANT_CONFLICT: 'GRANT_CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
