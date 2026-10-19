/**
 * Who a billing email goes to (`VENDOR_SIGNUP_PROCESS.md` decision 16): every
 * unbanned seat, plus the billing account's billing email when one is set, each
 * address once, compared trimmed and case-insensitively.
 *
 * Shared by the admin license routes (`licenses-granted`, `managed-ended` on revoke),
 * the term-end lapse (`managed-ended` on lapse, AECI-1404) and the 30-day notice
 * (`entitlement-expiring`, AECI-1406). Seat addresses come from
 * `loadVendorSeatRecipients` (`lib/vendor-seat-recipients.ts`); this module adds the
 * billing email and the dedupe.
 */

import { inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts } from '../db/schema';

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
