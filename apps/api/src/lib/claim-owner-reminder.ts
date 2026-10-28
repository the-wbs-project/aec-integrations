/**
 * The claim owner reminder (AECI-1513 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10).
 *
 * A claim routed to a company's owners waits 7 days for them, then falls back to AECi
 * (`lib/claim-owner-fallback.ts`). The owners get `claim-owner-review` once, at
 * routing. This sweep sends them `claim-owner-review-reminder` when the deadline is at
 * most {@link OWNER_REMINDER_LEAD_DAYS} days away and nobody has decided, the way
 * `contest-protest-reply-reminder` warns of a protest reply deadline.
 *
 * It runs inside the daily `claim_owner_fallback` cron, BEFORE the fallback step. A
 * claim is in the window only while its deadline is still ahead (`> now`), and the
 * fallback takes only claims at or past it, so the two steps never act on one claim.
 *
 * ── THE BOUND CARRIES OVER ──────────────────────────────────────────────────────
 * The first email is capped per vendor per UTC day (`OWNER_REVIEW_DAILY_LIMIT`, the
 * abuse bound on an anonymous route). The reminder must not undo that cap. So an owner
 * is reminded only when their `claim-owner-review:{requestId}:{profileId}` key is held
 * in `notification_sends`. A key is held by a `sent` or `unknown` send only
 * (`lib/notifications/send-ledger.ts`): a bounded claim reserved nothing, and a
 * `failed` send released its key. So an owner the bound skipped, an owner whose first
 * email failed, and an owner seated after routing get no reminder. All of them still
 * see the claim in Seats.
 *
 * **At most once, with no schema change.** Each send carries
 * `claim-owner-review-reminder:{requestId}:{profileId}`. The two daily runs inside the
 * window find the key held and send nothing the second time.
 *
 * **Writes no domain state.** Only the send ledger, which is log-class (ADR 0022). Throws
 * only on a D1 read error, which the cron shell records as a failed run.
 */

import { CLAIM_OWNER_REVIEW_DAYS } from '@aeci/shared';
import { and, asc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { notificationSends, products, vendorRequests, vendors } from '../db/schema';
import { ownerReviewDeadline } from './claim-owner-fallback';
import { ownerReviewKey, UNDECIDED_CLAIM_STATUSES } from './claim-owner-routing';
import { sendClaimOwnerReviewReminderEmail, type EmailContext, type EmailOutcome } from './email';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

const DAY_MS = 86_400_000;

/** How far ahead of the owners' deadline the reminder goes out. */
export const OWNER_REMINDER_LEAD_DAYS = 2;

/** Most claims one run reminds about. A backstop: the next daily run continues. */
export const OWNER_REMINDER_BATCH_CAP = 100;

/** The per-owner send-ledger key. */
export const ownerReminderKey = (requestId: string, profileId: string) =>
  `claim-owner-review-reminder:${requestId}:${profileId}`;

export interface ClaimOwnerReminderDeps {
  fetchSeatEmails?: FetchSeatEmails;
  sendEmail?: typeof sendClaimOwnerReviewReminderEmail;
  now?: Date;
}

export interface ClaimOwnerReminderResult {
  /** Routed, undecided claims whose deadline falls inside the window. */
  due: number;
  /** Claims dropped by {@link OWNER_REMINDER_BATCH_CAP} this run. */
  capped: number;
  /** Per-owner send outcomes. A held reminder key counts as `duplicate`. */
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

/**
 * Remind the owners of every routed, undecided claim whose deadline is after `now` and
 * at most {@link OWNER_REMINDER_LEAD_DAYS} days away.
 */
export async function runClaimOwnerReviewReminderSweep(
  c: EmailContext,
  db: Db,
  deps: ClaimOwnerReminderDeps = {},
): Promise<ClaimOwnerReminderResult> {
  const send = deps.sendEmail ?? sendClaimOwnerReviewReminderEmail;
  const now = deps.now ?? new Date();
  // Deadline = routed_to_owners_at + 7 days. "Deadline in (now, now + 2 days]" is
  // "routed in (now - 7 days, now - 5 days]". ISO-8601 TEXT compares lexically.
  const routedAfter = new Date(now.getTime() - CLAIM_OWNER_REVIEW_DAYS * DAY_MS).toISOString();
  const routedBy = new Date(
    now.getTime() - (CLAIM_OWNER_REVIEW_DAYS - OWNER_REMINDER_LEAD_DAYS) * DAY_MS,
  ).toISOString();

  const rows = await db
    .select({
      id: vendorRequests.id,
      vendorId: vendorRequests.targetId,
      routedToOwnersAt: vendorRequests.routedToOwnersAt,
      submitterEmail: vendorRequests.submitterEmail,
      submitterName: vendorRequests.submitterName,
      submitterRole: vendorRequests.submitterRole,
      submitterLinkedinUrl: vendorRequests.submitterLinkedinUrl,
      body: vendorRequests.body,
      contextProductName: products.name,
      vendorName: vendors.companyName,
      vendorSlug: vendors.slug,
    })
    .from(vendorRequests)
    .leftJoin(vendors, eq(vendors.id, vendorRequests.targetId))
    // LEFT: `context_product_id` has no FK, and the product may have gone since.
    .leftJoin(products, eq(products.id, vendorRequests.contextProductId))
    .where(
      and(
        eq(vendorRequests.kind, 'claim'),
        eq(vendorRequests.targetType, 'vendor'),
        inArray(vendorRequests.status, [...UNDECIDED_CLAIM_STATUSES]),
        isNotNull(vendorRequests.routedToOwnersAt),
        gt(vendorRequests.routedToOwnersAt, routedAfter),
        lte(vendorRequests.routedToOwnersAt, routedBy),
      ),
    )
    .orderBy(asc(vendorRequests.routedToOwnersAt), asc(vendorRequests.id));

  const batch = rows.slice(0, OWNER_REMINDER_BATCH_CAP);
  const result: ClaimOwnerReminderResult = {
    due: rows.length,
    capped: rows.length - batch.length,
    emails: emptyOutcomes(),
  };

  for (const row of batch) {
    const owners = await loadVendorOwnerRecipients(db, c.env, row.vendorId, deps.fetchSeatEmails);
    if (owners.length === 0) continue;
    const held = new Set(
      (
        await db
          .select({ key: notificationSends.dedupeKey })
          .from(notificationSends)
          .where(
            inArray(
              notificationSends.dedupeKey,
              owners.map((o) => ownerReviewKey(row.id, o.profileId)),
            ),
          )
      ).map((r) => r.key),
    );
    // One connection at a time: sequential sends (a handful of owners).
    for (const owner of owners) {
      if (!held.has(ownerReviewKey(row.id, owner.profileId))) continue;
      const outcome = await send(c, {
        to: owner.email,
        dedupeKey: ownerReminderKey(row.id, owner.profileId),
        requestId: row.id,
        vendorName: row.vendorName ?? '',
        vendorSlug: row.vendorSlug ?? null,
        submitterEmail: row.submitterEmail,
        submitterName: row.submitterName,
        submitterRole: row.submitterRole,
        submitterLinkedinUrl: row.submitterLinkedinUrl,
        comments: row.body,
        contextProductName: row.contextProductName ?? null,
        decideBy: ownerReviewDeadline(row.routedToOwnersAt!),
      });
      result.emails[outcome]++;
    }
  }
  return result;
}
