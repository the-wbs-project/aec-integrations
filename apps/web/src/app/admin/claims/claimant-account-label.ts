import type { AdminClaim } from '@aeci/shared';

/**
 * The "Claimant account" reviewer signal (AECI-527), worded for the claim's
 * status (AECI-1278). Shared by `/admin/claims` and `/admin/claims/:id` so the
 * two screens cannot describe the same claim differently.
 *
 * `has_auth_account` is a LIVE GoTrue lookup at read time, not a snapshot from
 * approve time. Once a claim is approved the account exists whether approve
 * linked it or provisioned it, so the resolved wording must not claim either.
 * It also must not claim the seat: the lookup never reads `profiles`, and a
 * seat can be revoked after approve.
 * A rejected claim only says whether an account exists. `in_review` is still
 * pending an approve, so it keeps the open wording.
 *
 * `null` is UNKNOWN (absent creds or a failed lookup) and is never rendered as
 * "no account" (`STAGE_2_VENDOR_PORTAL_SPEC.md` §2).
 */
export function claimantAccountLabel(status: AdminClaim['status'], value: boolean | null): string {
  if (value === null) {
    return $localize`:@@admin.claims.account.unknown:Account status unknown`;
  }
  switch (status) {
    case 'resolved':
      return value
        ? $localize`:@@admin.claims.account.resolved.exists:Account exists (claim granted)`
        : $localize`:@@admin.claims.account.resolved.none:No account found`;
    case 'rejected':
      return value
        ? $localize`:@@admin.claims.account.rejected.exists:Existing account`
        : $localize`:@@admin.claims.account.rejected.none:No account`;
    default:
      return value
        ? $localize`:@@admin.claims.account.open.exists:Existing account: approve links it`
        : $localize`:@@admin.claims.account.open.none:No account: approve provisions one`;
  }
}
