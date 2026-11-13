/**
 * Who a billing email goes to (`VENDOR_SIGNUP_PROCESS.md` decision 16): every
 * unbanned seat, plus the billing account's billing email when one is set, each
 * address once, compared trimmed and case-insensitively.
 *
 * Shared by the admin license routes (`licenses-granted`, `managed-ended` on revoke),
 * the term-end lapse (`managed-ended` on lapse, AECI-1404) and the 45-day notice
 * (`entitlement-expiring`, AECI-1406). Seat addresses come from
 * `loadVendorSeatRecipients` (`lib/vendor-seat-recipients.ts`); this module adds the
 * billing email and the dedupe.
 *
 * {@link ownerAndBillingAddresses} is the owner-only variant for one vendor: its owner
 * seats and every billing email its accounts carry. The suspension notices (AECI-1623)
 * and the Managed plan change notice (`legal-terms-change`, AECI-1620) use it.
 */

import { eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts } from '../db/schema';
import type { Env } from '../env';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** Billing account ids per lookup. D1 caps bound parameters per query. */
const BILLING_LOOKUP_CHUNK = 50;

/**
 * Seat addresses first, then the billing email, each address once. Blank entries are
 * dropped. The first spelling of an address wins, trimmed.
 */
export function mergeRecipientAddresses(
  seatEmails: readonly string[],
  billingEmail: string | null | undefined,
): string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  for (const address of [...seatEmails, billingEmail ?? '']) {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    addresses.push(trimmed);
  }
  return addresses;
}

/**
 * The billing email of each billing account, keyed by account id. An account with no
 * billing email maps to `null`; an unknown id is absent. Throws only on a D1 error.
 */
export async function loadBillingEmails(
  db: Db,
  billingAccountIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(billingAccountIds)];
  const out = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += BILLING_LOOKUP_CHUNK) {
    const ids = unique.slice(i, i + BILLING_LOOKUP_CHUNK);
    const rows = await db
      .select({ id: billingAccounts.id, billingEmail: billingAccounts.billingEmail })
      .from(billingAccounts)
      .where(inArray(billingAccounts.id, ids));
    for (const row of rows) out.set(row.id, row.billingEmail ?? null);
  }
  return out;
}

/** Every billing email the vendor's accounts carry. Throws only on a D1 error. */
export async function loadVendorBillingEmails(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ billingEmail: billingAccounts.billingEmail })
    .from(billingAccounts)
    .where(eq(billingAccounts.vendorId, vendorId));
  return rows.flatMap((r) => (r.billingEmail ? [r.billingEmail] : []));
}

/**
 * The owner seats and the billing emails of one vendor, each address once. Throws when
 * D1 throws, and when `fetchSeatEmails` throws: the legal notice passes a strict lookup
 * that throws on an Auth outage, so no partial list goes out.
 */
export async function ownerAndBillingAddresses(
  env: Env,
  db: Db,
  vendorId: string,
  fetchSeatEmails: FetchSeatEmails,
): Promise<string[]> {
  const [owners, billing] = await Promise.all([
    loadVendorOwnerRecipients(db, env, vendorId, fetchSeatEmails),
    loadVendorBillingEmails(db, vendorId),
  ]);
  return mergeRecipientAddresses([...owners.map((o) => o.email), ...billing], null);
}
