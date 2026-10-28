/**
 * The unassigned-license reminder (AECI-1512 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §7.7,
 * `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 6).
 *
 * A grant lands its licenses in the billing account's pool unassigned. `licenses-granted`
 * says so once. If a week later a license from that grant is still on no product while
 * the vendor owns a product on the Free plan, this sweep sends the vendor's owner seats
 * `license-unassigned-reminder`: only an owner can assign, from Billing.
 *
 * Run by the daily 11:00 UTC `entitlement_expiry` cron, after the expiry sweep.
 *
 * ── WHICH LICENSES ARE DUE ──────────────────────────────────────────────────────
 * A live license (`ended_at IS NULL`) on no product, not set to end at term end, whose
 * `created_at` is {@link REMINDER_AFTER_DAYS} to {@link REMINDER_AFTER_DAYS} +
 * {@link REMINDER_GRACE_DAYS} days old. The grace covers a missed cron. `created_at`,
 * not `starts_at`: the admin grant takes `starts_at` from the operator but stamps
 * `created_at` with the real grant time (`grantLicensesStatements`, the one writer of
 * license rows). A license unassigned later (an approved early unassign, a retraction)
 * is older than the window and is never reminded about here.
 *
 * ── ONE EMAIL PER ACCOUNT PER GRANT DAY ─────────────────────────────────────────
 * Due licenses are grouped by billing account and the UTC day of `created_at`, so one
 * grant of three licenses is one email, and two grants on different days are two. The
 * per-owner key `license-unassigned-reminder:{billingAccountId}:{day}:{profileId}`
 * makes the daily runs inside the window send each one once.
 *
 * ── WHEN NOTHING IS SENT ────────────────────────────────────────────────────────
 * When every product the vendor owns already holds a live license, there is nothing to
 * assign, so nothing is sent. No owner address (no owner seat, or no service-role key
 * locally) sends nothing either.
 *
 * **Writes no domain state.** Only the send ledger, which is log-class (ADR 0022).
 * Throws only on a D1 read error, which the cron shell records as a failed run.
 */

import { compareText } from '@aeci/shared/text-sort';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, licenses, productVendors, products, vendors } from '../db/schema';
import { sendLicenseUnassignedReminderEmail, type EmailContext, type EmailOutcome } from './email';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

const DAY_MS = 86_400_000;

/** How long a granted license may sit on no product before the reminder. */
export const REMINDER_AFTER_DAYS = 7;

/** How long past {@link REMINDER_AFTER_DAYS} a license stays due, for a missed cron. */
export const REMINDER_GRACE_DAYS = 3;

/** Most (account, grant day) groups one run handles. The next run continues. */
export const UNASSIGNED_REMINDER_BATCH_CAP = 100;

/** The per-owner send-ledger key. */
export const unassignedReminderKey = (billingAccountId: string, day: string, profileId: string) =>
  `license-unassigned-reminder:${billingAccountId}:${day}:${profileId}`;

export interface UnassignedReminderDeps {
  fetchSeatEmails?: FetchSeatEmails;
  sendEmail?: typeof sendLicenseUnassignedReminderEmail;
  now?: Date;
}

export interface UnassignedReminderResult {
  /** (account, grant day) groups with a due license. */
  due: number;
  /** Groups dropped by {@link UNASSIGNED_REMINDER_BATCH_CAP} this run. */
  capped: number;
  /** Groups skipped because every owned product already holds a live license. */
  nothingToAssign: number;
  /** Per-owner send outcomes. A held key counts as `duplicate`. */
  emails: Record<EmailOutcome, number>;
}

const emptyOutcomes = (): Record<EmailOutcome, number> => ({
  sent: 0,
  failed: 0,
  unknown: 0,
  skipped: 0,
  suppressed: 0,
  duplicate: 0,
  paused: 0,
});

/** Run one reminder pass. */
export async function runLicenseUnassignedReminderSweep(
  c: EmailContext,
  db: Db,
  deps: UnassignedReminderDeps = {},
): Promise<UnassignedReminderResult> {
  const send = deps.sendEmail ?? sendLicenseUnassignedReminderEmail;
  const now = deps.now ?? new Date();
  // ISO-8601 TEXT compares lexically, so the bounds are strings.
  const createdBy = new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY_MS).toISOString();
  const createdAfter = new Date(
    now.getTime() - (REMINDER_AFTER_DAYS + REMINDER_GRACE_DAYS) * DAY_MS,
  ).toISOString();
  const grantDay = sql<string>`substr(${licenses.createdAt}, 1, 10)`;

  const groups = await db
    .select({
      billingAccountId: licenses.billingAccountId,
      day: grantDay,
      vendorId: billingAccounts.vendorId,
      vendorName: vendors.companyName,
      vendorSlug: vendors.slug,
      count: sql<number>`count(*)`.mapWith(Number),
      endsAt: sql<string | null>`min(${licenses.endsAt})`,
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId))
    .where(
      and(
        isNull(licenses.endedAt),
        isNull(licenses.assignedProductId),
        eq(licenses.cancelAtTermEnd, false),
        gt(licenses.createdAt, createdAfter),
        lte(licenses.createdAt, createdBy),
      ),
    )
    .groupBy(
      licenses.billingAccountId,
      grantDay,
      billingAccounts.vendorId,
      vendors.companyName,
      vendors.slug,
    )
    .orderBy(asc(grantDay), asc(licenses.billingAccountId));

  const batch = groups.slice(0, UNASSIGNED_REMINDER_BATCH_CAP);
  const result: UnassignedReminderResult = {
    due: groups.length,
    capped: groups.length - batch.length,
    nothingToAssign: 0,
    emails: emptyOutcomes(),
  };

  for (const group of batch) {
    const freeProducts = await loadFreeProductNames(db, group.vendorId);
    if (freeProducts.length === 0) {
      result.nothingToAssign++;
      continue;
    }
    const owners = await loadVendorOwnerRecipients(db, c.env, group.vendorId, deps.fetchSeatEmails);
    // One connection at a time: sequential sends (a handful of owners).
    for (const owner of owners) {
      const outcome = await send(c, {
        to: owner.email,
        dedupeKey: unassignedReminderKey(group.billingAccountId, group.day, owner.profileId),
        billingAccountId: group.billingAccountId,
        vendorName: group.vendorName,
        vendorSlug: group.vendorSlug,
        unassignedCount: group.count,
        freeProductNames: freeProducts,
        endsAt: group.endsAt,
      });
      result.emails[outcome]++;
    }
  }
  return result;
}

/**
 * The names of the products the vendor owns (`product_vendors`) that hold no live
 * license from any account, in `compareText` order. The same "licensed" test as
 * `loadOwnedProductLicenseState` (`lib/license.ts`).
 */
async function loadFreeProductNames(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ name: products.name })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        sql`not exists (select 1 from ${licenses} where ${licenses.assignedProductId} = ${productVendors.productId} and ${licenses.endedAt} is null)`,
      ),
    );
  return rows.map((r) => r.name).sort(compareText);
}
