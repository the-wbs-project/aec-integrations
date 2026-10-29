/**
 * Who may see a private row thread (AECI-1535, `STAGE_2_ATTESTATIONS_SPEC.md` §15.3).
 *
 * Ruled 2026-10-29: access is decided by the two companies STAMPED on the thread
 * (`vendor_a_id` / `vendor_b_id`), not by who owns the claim's products today. A
 * caller whose vendor is one of the pair may read. A write needs that AND a current
 * endpoint of the claim (`resolveClaimAuthority`), which the route checks. Anyone
 * else gets the 404 the vendor surface answers instead of a 403.
 *
 * This is the one definition. The SQL form scopes a query to the caller's threads
 * (the `threads` cursor scope, AECI-1538, and any list). The in-memory form checks a
 * row already loaded. Keep the two in lockstep.
 */

import { eq, or, type SQL } from 'drizzle-orm';

import { claimThreads } from '../db/schema';

/** `claim_threads` rows the caller's vendor is one of the two companies on. */
export function threadParticipantWhere(vendorId: string): SQL {
  return or(eq(claimThreads.vendorAId, vendorId), eq(claimThreads.vendorBId, vendorId))!;
}

/** The in-memory twin of {@link threadParticipantWhere}. */
export function isThreadParticipant(
  thread: { readonly vendorAId: string; readonly vendorBId: string },
  vendorId: string,
): boolean {
  return thread.vendorAId === vendorId || thread.vendorBId === vendorId;
}
