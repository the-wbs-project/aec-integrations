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
  CATALOG_VENDOR_MANAGED: 'CATALOG_VENDOR_MANAGED',
  // AECI-724: the inverse gate. A mapping edit on a catalogue the review app still
  // authors would be overwritten by the next sync page, so it is refused (409).
  CATALOG_REVIEW_MANAGED: 'CATALOG_REVIEW_MANAGED',
  // AECI-724: the edit would collide with another mapping on the same stub — the same
  // product twice, or a second stub-level decision (409).
  MAPPING_CONFLICT: 'MAPPING_CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  // AECI-1008 integration field contests (`API_CONTRACTS.md` §4).
  CONTEST_OWN_INTEGRATION: 'CONTEST_OWN_INTEGRATION',
  CONTEST_DUPLICATE: 'CONTEST_DUPLICATE',
  CONTEST_NOT_OPEN: 'CONTEST_NOT_OPEN',
  CONTEST_ROUTED_TO_OWNER: 'CONTEST_ROUTED_TO_OWNER',
  CONTEST_NO_CHANGE: 'CONTEST_NO_CHANGE',
  CONTEST_INVALID_VALUE: 'CONTEST_INVALID_VALUE',
  // AECI-1005: the integration was claimed, or its owner changed, while an admin
  // decided a contest on it. The whole decision batch rolled back.
  CONTEST_INTEGRATION_CHANGED: 'CONTEST_INTEGRATION_CHANGED',
  // AECI-1006: an AECi accept of a content contest on a claimed row whose column no
  // longer holds the value recorded at submit (usually the owner edited it).
  CONTEST_VALUE_STALE: 'CONTEST_VALUE_STALE',
  // AECI-1009 protests (`API_CONTRACTS.md` §4), all 409. `PROTEST_NOT_AVAILABLE`
  // carries `details.reason`. The two CONTEST_ codes answer a NEW contest: one on a
  // field with an open protest, and one inside a lost protest's 90-day cooldown.
  PROTEST_NOT_AVAILABLE: 'PROTEST_NOT_AVAILABLE',
  PROTEST_NOT_OPEN: 'PROTEST_NOT_OPEN',
  PROTEST_REPLY_EXISTS: 'PROTEST_REPLY_EXISTS',
  PROTEST_REPLY_CLOSED: 'PROTEST_REPLY_CLOSED',
  CONTEST_PROTEST_OPEN: 'CONTEST_PROTEST_OPEN',
  CONTEST_COOLDOWN: 'CONTEST_COOLDOWN',
  // AECI-1005 integration ownership claims (`API_CONTRACTS.md` §4).
  INTEGRATION_NOT_OWNER: 'INTEGRATION_NOT_OWNER',
  INTEGRATION_OWNER_UNKNOWN: 'INTEGRATION_OWNER_UNKNOWN',
  INTEGRATION_ALREADY_CLAIMED: 'INTEGRATION_ALREADY_CLAIMED',
  // AECI-1005 Q1 ruling (2026-09-22): decision 9 blocks the claim too in v1.
  INTEGRATION_CONNECTOR_POWERED: 'INTEGRATION_CONNECTOR_POWERED',
  // AECI-1005: a promote planned against an unclaimed integration that was claimed
  // before its batch committed. The batch rolls back; re-push and the fence skips it.
  INTEGRATION_CLAIMED_DURING_PROMOTE: 'INTEGRATION_CLAIMED_DURING_PROMOTE',
  // AECI-1010 retire/restore (`API_CONTRACTS.md` §4), all 409. `INTEGRATION_RETIRED`
  // answers a retire of a row already retired AND any other vendor write on a retired
  // row (an attestation, a contest, an owner edit). `INTEGRATION_NOT_RETIRED` answers a
  // restore of a live row. `INTEGRATION_NOT_CLAIMED` answers the owner of an unclaimed
  // row: retire, restore and the AECI-1006 owner edit are owner writes, and ownership
  // is taken by the claim.
  INTEGRATION_RETIRED: 'INTEGRATION_RETIRED',
  INTEGRATION_NOT_RETIRED: 'INTEGRATION_NOT_RETIRED',
  INTEGRATION_NOT_CLAIMED: 'INTEGRATION_NOT_CLAIMED',
  // AECI-1010: a retire or restore lost a race (a contest filed, the row changed)
  // and the re-read finds no refusal to give. Nothing was written; reload and retry.
  INTEGRATION_CHANGED_WHILE_SAVING: 'INTEGRATION_CHANGED_WHILE_SAVING',
  // AECI-1046 admin retire/restore. `INTEGRATION_RETIRED_BY_AECI` (403) answers the
  // owner's restore of a row AECi retired: only an admin restores an admin retire.
  // `INTEGRATION_RETIRED_BY_OWNER` (409) answers an admin restore of a row its owner
  // retired: the owner controls its own retire. `INTEGRATION_NOT_VENDOR_HELD` (409)
  // answers an admin retire or restore of an AECi-held row, which promote, the review
  // app and the retraction tools own.
  INTEGRATION_RETIRED_BY_AECI: 'INTEGRATION_RETIRED_BY_AECI',
  INTEGRATION_RETIRED_BY_OWNER: 'INTEGRATION_RETIRED_BY_OWNER',
  INTEGRATION_NOT_VENDOR_HELD: 'INTEGRATION_NOT_VENDOR_HELD',
  // AECI-1006 owner edits (`API_CONTRACTS.md` §4): a value that is wrong for its field.
  INTEGRATION_INVALID_VALUE: 'INTEGRATION_INVALID_VALUE',
  // AECI-1011: a vendor created (or took) a row that strongly matches an integration
  // this promote planned to insert, de-route or update, after the plan read and before
  // the batch. The batch rolls back; re-push and the VENDOR_OWNED_TWIN guard skips
  // that write, unless it is an UPDATE of a row that already matched the new vendor
  // row, which the re-push writes. A claim on the updated row itself is
  // INTEGRATION_CLAIMED_DURING_PROMOTE.
  VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE: 'VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE',
  RATE_LIMITED: 'RATE_LIMITED',
  // AECI-770: a verified session has no `profiles` row and the self-heal could not
  // create one (503). Retryable. Distinct from UNAUTHENTICATED, which says "sign in
  // again" and never helped this user.
  PROFILE_UNAVAILABLE: 'PROFILE_UNAVAILABLE',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
