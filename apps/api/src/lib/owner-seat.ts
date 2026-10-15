/**
 * The one owner predicate (AECI-1367, AECI-1368): **a vendor "has seats" when it has
 * an unbanned owner seat**, that is a `profiles` row with `vendor_id = <vendor>`,
 * `seat_owner = 1` and `banned_at IS NULL`.
 *
 * Three readers share it, so they can never disagree:
 *
 * 1. The claim grant (`lib/vendor-grant.ts` `firstOwnerSql`): a grant makes an owner
 *    only when the vendor has none.
 * 2. Claim routing (`routes/requests.ts`): a claim on a vendor that has one is routed
 *    to its owners first (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10).
 * 3. `has_seats` on `GET /api/requests/claim-target/:type/:slug`, which tells the
 *    claim form before submit whether the claim will be routed.
 *
 * The subquery is aliased (`owner_seat`) so its columns can never bind to an outer
 * `profiles` row, which is what the grant's upsert needs.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles } from '../db/schema';

/** `EXISTS (…)`: true when the vendor has an unbanned owner seat. */
export function ownerSeatExistsSql(vendorId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM "profiles" AS "owner_seat" WHERE "owner_seat"."vendor_id" = ${vendorId} AND "owner_seat"."seat_owner" = 1 AND "owner_seat"."banned_at" IS NULL)`;
}

/** The same predicate as a `WHERE` on `profiles` itself: the UNBANNED owner seats of
 *  a vendor. Used to read the predicate and to list the owners to notify. Not
 *  `ownerSeatsOf` in `routes/vendor-shared.ts`, which is decision 10's billing
 *  predicate and counts a banned owner too. */
export function unbannedOwnerSeatsOf(vendorId: string) {
  return and(
    eq(profiles.vendorId, vendorId),
    eq(profiles.seatOwner, true),
    isNull(profiles.bannedAt),
  );
}

/** Read the predicate for one vendor. One indexed D1 read. */
export async function vendorHasOwnerSeat(db: Db, vendorId: string): Promise<boolean> {
  const row = await db.query.profiles.findFirst({
    columns: { id: true },
    where: unbannedOwnerSeatsOf(vendorId),
  });
  return row !== undefined;
}
