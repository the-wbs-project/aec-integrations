/**
 * How the admin console names a vendor seat (AECI-1277): its display name, else
 * its sign-in email. Used by the claim queue, the claim detail and the vendor
 * seat roster, so the three cannot drift apart.
 *
 * Never "Unnamed seat". Every claimant who signs in with Google starts without a
 * display name, so that label made every such seat look the same and told the
 * reviewer nothing about who held it.
 *
 * When there is no email either, say why, in the three-state form the vendor
 * roster established (AECI-652): `emailsAvailable === false` means the GoTrue
 * seam could not be reached, so a blank says nothing about the account; `true`
 * with no email means that account genuinely has none.
 */
export function seatEmailText(email: string | null, emailsAvailable: boolean): string {
  if (email) return email;
  return emailsAvailable
    ? $localize`:@@admin.seats.emailNone:No email on file`
    : $localize`:@@admin.seats.emailUnavailable:Email unavailable`;
}

/** The seat's display name if it has a non-blank one, else {@link seatEmailText}. */
export function seatLabel(
  seat: { readonly display_name: string | null; readonly email: string | null },
  emailsAvailable: boolean,
): string {
  const name = seat.display_name?.trim();
  return name ? name : seatEmailText(seat.email, emailsAvailable);
}
