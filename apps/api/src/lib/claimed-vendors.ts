/**
 * "Is this vendor claimed?" — the single definition (AECI-520 / Stage 2).
 *
 * A vendor is CLAIMED once AECi has granted at least one vendor-portal seat for
 * it: a `profiles` row with `role = 'vendor_admin'` AND `vendor_id = <vendor>`
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §3 — the grant flow writes exactly that row).
 *
 * Why seat-existence and not `vendors.verified`: `verified` is the paid
 * entitlement bit and used to be writable by the Airtable review app through
 * `POST /api/promote`. Seat existence can only be produced by an AECi-side
 * grant, so it is the trustworthy signal for "this row is now vendor-owned".
 *
 * The one consumer today is the promote claimed-vendor block (`routes/promote.ts`)
 * — the review app may not overwrite a claimed vendor or any product joined to
 * it. AECI-519 (grant) and AECI-521 (admin claim review) need the same predicate;
 * they share this helper rather than re-deriving it.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles } from '../db/schema';

/** `profiles.role` value that marks a vendor-portal seat. */
export const VENDOR_ADMIN_ROLE = 'vendor_admin';

/**
 * Narrow `candidateIds` to those that have at least one `vendor_admin` seat.
 *
 * Returns an empty set for an empty candidate list without touching D1 — the
 * caller decides the candidate list, and a promote that only creates rows has
 * nothing to check. (Drizzle's `inArray` with `[]` emits degenerate SQL, so the
 * short-circuit is required, not just an optimization.)
 */
export async function loadClaimedVendorIds(
  db: Db,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(candidateIds)];
  if (unique.length === 0) return new Set();

  const rows = await db.query.profiles.findMany({
    columns: { vendorId: true },
    where: and(eq(profiles.role, VENDOR_ADMIN_ROLE), inArray(profiles.vendorId, unique)),
  });

  const claimed = new Set<string>();
  for (const row of rows) if (row.vendorId) claimed.add(row.vendorId);
  return claimed;
}
