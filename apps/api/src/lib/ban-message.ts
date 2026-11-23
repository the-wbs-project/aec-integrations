/**
 * What a banned account reads in its 403 (AECI-1973, ruled 2026-11-20). The reason an
 * admin types on the ban form is an internal note: it is stored on
 * `profiles.ban_reason` and in the audit row, and is never sent to the banned person.
 * The one vendor-facing reason is Terminate's, which the code writes itself.
 */
export const BANNED_ACCOUNT_MESSAGE = 'Account suspended';

/** The `ban_reason` Terminate writes on every seat it bans. Vendor-facing by design. */
export const TERMINATED_SEAT_BAN_REASON = "This company's vendor account has ended.";

/** The 403 message for a banned profile. The admin's reason never passes through. */
export function bannedAccountMessage(banReason: string | null): string {
  return banReason === TERMINATED_SEAT_BAN_REASON
    ? TERMINATED_SEAT_BAN_REASON
    : BANNED_ACCOUNT_MESSAGE;
}
