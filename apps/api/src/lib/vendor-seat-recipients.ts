/**
 * The email addresses of a vendor's seats, for mail that every seat must get.
 *
 * A seat is an unbanned `vendor_admin` profile with that `vendor_id`. A banned seat
 * cannot act on anything it is told (every `/api/vendor/*` call fails the ban
 * check), so it gets no mail. `profiles` holds no email, so the addresses come from
 * Supabase `auth.users` through the privileged seam. Without
 * `SUPABASE_SERVICE_ROLE_KEY` (local dev) the seam returns nothing and
 * every vendor resolves to no recipients, which the senders report as `skipped`.
 *
 * Shared by the entitlement-expiry sweep (AECI-613) and the protest emails
 * (AECI-1205). It applies NO mute. The attestation digest has its own seat read in
 * `lib/attestation-notify.ts`, because the per-seat nudge mute (AECI-1204) has to
 * filter the seats before their addresses are fetched. A deadline email must not
 * honour that mute, so it reads here.
 *
 * {@link loadVendorOwnerRecipients} (AECI-1368) is the OWNER-only variant: the
 * owner seats of one vendor, by the shared owner predicate (`lib/owner-seat.ts`).
 * The `claim-owner-review` email carries a claimant's contact details, so it goes
 * to the seats that may act on it and to no one else.
 */

import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { unbannedOwnerSeatsOf } from './owner-seat';
import { fetchAuthUserEmails } from './supabase-admin';
import type { Db } from '../db/client';
import type { Env } from '../env';

/** The privileged `auth.users` email seam, injected so specs never touch it. */
export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

/** One seat with an address on file. */
export interface SeatRecipient {
  profileId: string;
  email: string;
}

/** Vendor ids per seat lookup. D1 caps bound parameters per query. */
const SEAT_LOOKUP_CHUNK = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every seat with an address, per vendor, in the order `profiles` returned them. A
 * vendor with no such seat is absent from the map. Throws only on a D1 error.
 */
export async function loadVendorSeatRecipients(
  db: Db,
  env: Env,
  vendorIds: readonly string[],
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
): Promise<Map<string, SeatRecipient[]>> {
  const unique = [...new Set(vendorIds)];
  if (unique.length === 0) return new Map();

  const seats: Array<{ id: string; vendorId: string | null }> = [];
  for (const batch of chunk(unique, SEAT_LOOKUP_CHUNK)) {
    seats.push(
      ...(await db.query.profiles.findMany({
        columns: { id: true, vendorId: true },
        where: (p, { and: andOp, eq: eqOp, inArray: inArrayOp, isNull: isNullOp }) =>
          andOp(
            inArrayOp(p.vendorId, batch),
            eqOp(p.role, VENDOR_ADMIN_ROLE),
            isNullOp(p.bannedAt),
          ),
      })),
    );
  }
  if (seats.length === 0) return new Map();

  const emails = await fetchSeatEmails(
    env,
    seats.map((s) => s.id),
  );

  const byVendor = new Map<string, SeatRecipient[]>();
  for (const seat of seats) {
    const email = emails.get(seat.id);
    if (!seat.vendorId || !email) continue;
    const list = byVendor.get(seat.vendorId);
    const recipient = { profileId: seat.id, email };
    if (list) list.push(recipient);
    else byVendor.set(seat.vendorId, [recipient]);
  }
  return byVendor;
}

/**
 * The unbanned OWNER seats of one vendor that have an address on file (AECI-1368).
 * Same predicate as claim routing and `has_seats` (`unbannedOwnerSeatsOf`), so a vendor that
 * routes a claim is a vendor this returns owners for, unless GoTrue has no address
 * for them (or the service-role key is absent, which returns nothing).
 */
export async function loadVendorOwnerRecipients(
  db: Db,
  env: Env,
  vendorId: string,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
): Promise<SeatRecipient[]> {
  const owners = await db.query.profiles.findMany({
    columns: { id: true },
    where: unbannedOwnerSeatsOf(vendorId),
  });
  if (owners.length === 0) return [];
  const emails = await fetchSeatEmails(
    env,
    owners.map((o) => o.id),
  );
  const out: SeatRecipient[] = [];
  for (const owner of owners) {
    const email = emails.get(owner.id);
    if (email) out.push({ profileId: owner.id, email });
  }
  return out;
}
