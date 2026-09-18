/**
 * The operator console's queue counters, in one place (AECI-922, extended
 * by AECI-946).
 *
 * `GET /api/admin/summary` (the `/admin` SSR resolver's gate and the in-shell
 * badge feed) and `GET|PATCH /api/account` (the header's one-round-trip role
 * probe, AECI-617) both serve these numbers, and the web side renders them as
 * ONE total on the Operations trigger and on the account-menu badge. Two
 * implementations of "how many things are waiting" would let those two surfaces
 * disagree about the same number, so there is one.
 *
 * ── THE THREE QUEUES ARE DISJOINT, AND THAT IS LOAD-BEARING ─────────────────
 * The Operations trigger renders `reviews + requests + claims`. That sum is only
 * honest because the three sets do not overlap:
 *
 *   pending_reviews   reviews.status = 'pending'
 *   pending_requests  vendor_requests.status = 'open' AND kind = 'correction'
 *   pending_claims    vendor_requests.status = 'open' AND kind = 'claim'
 *
 * Requests and claims are the SAME TABLE split by `kind` — `/admin/requests` and
 * `/admin/claims` are two screens over `vendor_requests`. Counting requests
 * without the `kind` predicate would count every open claim twice in the total,
 * which is why `pendingRequests` is corrections-only and why `/admin/requests`
 * no longer offers a claims filter (`request-queue.ts`). If a third `kind` is
 * ever added, it needs its own counter and its own screen, or it silently
 * vanishes from the console's only live signal.
 *
 * `pending_reindex` (AECI-946) is disjoint from all three for the easy reason:
 * it is a different table entirely. It needs no predicate at all, because a row
 * in `gsc_recrawl_queue` IS a pending item — the Done button deletes rather than
 * flagging, precisely so that "is it waiting" never becomes a column whose
 * predicate this file would have to keep in step with a screen.

`pending_contests` (AECI-1008) is a different table too
(`integration_field_challenges`), counted as `routed_to = 'aeci' AND status =
'open'`, so it is disjoint from all four. The console does not sum it into the
Operations trigger until the `/admin/contests` screen exists (AECI-1008 PR C).
 *
 * ── WHY `open` AND NOT `open + in_review` ───────────────────────────────────
 * `vendor_requests.status` allows `open | in_review | resolved | rejected`, and
 * `in_review` is real: the inbound Linear webhook moves an actively-worked issue
 * there. It is deliberately NOT counted. Both queue screens default their status
 * filter to `open`, so a badge that counted `in_review` would nag about rows the
 * screen does not show — and the `status.moderation` depths on
 * `GET /api/admin/overview` are already `status = 'open'`, so counting it here
 * would make the badge and the dashboard disagree about the same backlog.
 *
 * That dashboard calls THIS function for its two request depths, for the other
 * half of the same reason: its "requests open" figure linked to `/admin/requests`,
 * which is corrections-only, so an all-kinds count named a number that page cannot
 * show. Its `pending_reviews` deliberately stays on the digest's own aggregate so
 * the tile and the 05:00 email lead with one number.
 */

import { and, count, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { gscRecrawlQueue, integrationFieldChallenges, reviews, vendorRequests } from '../db/schema';

/** The five counters, in the wire shape both endpoints return. */
export interface AdminQueueCounts {
  pending_reviews: number;
  pending_requests: number;
  pending_claims: number;
  pending_reindex: number;
  pending_contests: number;
}

/**
 * All five counts in ONE D1 round trip. `db.batch` rather than `Promise.all`
 * because five trivial `COUNT(*)`s are not worth five binding calls, and this
 * runs on the header probe of every signed-in admin page load.
 */
export async function readAdminQueueCounts(db: Db): Promise<AdminQueueCounts> {
  const [reviewRows, requestRows, claimRows, reindexRows, contestRows] = await db.batch([
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    db
      .select({ value: count() })
      .from(vendorRequests)
      .where(and(eq(vendorRequests.status, 'open'), eq(vendorRequests.kind, 'correction'))),
    db
      .select({ value: count() })
      .from(vendorRequests)
      .where(and(eq(vendorRequests.status, 'open'), eq(vendorRequests.kind, 'claim'))),
    // No `where`: every row here is pending by construction. See the header.
    db.select({ value: count() }).from(gscRecrawlQueue),
    // AECI-1008: the AECi queue only. Owner-routed contests are decided by a
    // vendor, so counting them would nag an operator about work that is not theirs.
    db
      .select({ value: count() })
      .from(integrationFieldChallenges)
      .where(
        and(
          eq(integrationFieldChallenges.routedTo, 'aeci'),
          eq(integrationFieldChallenges.status, 'open'),
        ),
      ),
  ]);

  return {
    pending_reviews: reviewRows[0]?.value ?? 0,
    pending_requests: requestRows[0]?.value ?? 0,
    pending_claims: claimRows[0]?.value ?? 0,
    pending_reindex: reindexRows[0]?.value ?? 0,
    pending_contests: contestRows[0]?.value ?? 0,
  };
}
