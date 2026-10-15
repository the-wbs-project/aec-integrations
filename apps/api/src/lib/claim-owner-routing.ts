/**
 * Claims routed to a company's owners (AECI-1368 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11a.10, `docs/VENDOR_SIGNUP_PROCESS.md` decision 4).
 *
 * When someone claims a company that already has an unbanned owner seat (the one
 * owner predicate, `lib/owner-seat.ts`), the claim is stored with
 * `routed_to_owners_at` set and stays `open`. The owners accept or decline it from
 * the Seats section. AECi still gets `claim-submitted-alert` and the Linear issue, and
 * steps in after 7 days through the `claim_owner_fallback` cron.
 *
 * This module is the post-commit half: {@link emailOwnersOfRoutedClaim} sends
 * `claim-owner-review` to every unbanned owner seat, one send per owner per claim
 * (`claim-owner-review:{requestId}:{profileId}`).
 *
 * ── THE ABUSE BOUND ──────────────────────────────────────────────────────────
 * The claim route is anonymous, and this is the first thing on it that emails a
 * third party. Zone Rule A caps one IP (`waf-rate-limits.md` §6.2), but a stranger
 * rotating addresses could still fill a company's owners' inboxes. So the fan-out is
 * bounded per vendor per UTC day: once {@link OWNER_REVIEW_DAILY_LIMIT} claims on one
 * vendor have been routed today, later claims still route (they still list in Seats
 * and still fall back after 7 days) but send no owner email. The count is a D1 read
 * over the column this feature already writes, so it needs no counter, no KV and no
 * binding.
 *
 * **Never rejects.** It runs inside `waitUntil` after the claim committed. A read
 * failure warns and sends nothing, and the email layer resolves every send failure to
 * an outcome.
 */

import type { PendingSeatClaim } from '@aeci/shared';
import { and, asc, count, eq, gte, inArray, isNotNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, vendorRequests, vendors } from '../db/schema';
import { logToPosthog } from '../posthog';
import { ownerReviewDeadline } from './claim-owner-fallback';
import { sendClaimOwnerReviewEmail, type EmailContext, type EmailOutcome } from './email';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** Routed claims per vendor per UTC day that email the owners. Later ones still route. */
export const OWNER_REVIEW_DAILY_LIMIT = 5;

/** The per-owner send-ledger key. */
export const ownerReviewKey = (requestId: string, profileId: string) =>
  `claim-owner-review:${requestId}:${profileId}`;

/** The statuses that leave a claim undecided. */
export const UNDECIDED_CLAIM_STATUSES = ['open', 'in_review'] as const;

/**
 * "A claim routed to this vendor's owners that nobody has decided": the predicate the
 * Seats read lists and the owner accept and decline act on, so the list and the write
 * can never disagree about which claims are the owners' to decide.
 */
export function routedClaimsOf(vendorId: string) {
  return and(
    eq(vendorRequests.kind, 'claim'),
    eq(vendorRequests.targetType, 'vendor'),
    eq(vendorRequests.targetId, vendorId),
    inArray(vendorRequests.status, [...UNDECIDED_CLAIM_STATUSES]),
    isNotNull(vendorRequests.routedToOwnersAt),
  );
}

/**
 * The claims waiting on this vendor's owners, oldest first, for
 * `GET /api/vendor/seats` `pending_claims`. The caller returns them to owner seats
 * only: each row carries the claimant's contact details.
 */
export async function loadPendingSeatClaims(db: Db, vendorId: string): Promise<PendingSeatClaim[]> {
  const rows = await db
    .select({
      id: vendorRequests.id,
      submitterName: vendorRequests.submitterName,
      submitterRole: vendorRequests.submitterRole,
      submitterEmail: vendorRequests.submitterEmail,
      submitterLinkedinUrl: vendorRequests.submitterLinkedinUrl,
      body: vendorRequests.body,
      createdAt: vendorRequests.createdAt,
      routedToOwnersAt: vendorRequests.routedToOwnersAt,
      contextProductName: products.name,
    })
    .from(vendorRequests)
    // LEFT: `context_product_id` has no FK, and the product may have gone since.
    .leftJoin(products, eq(products.id, vendorRequests.contextProductId))
    .where(routedClaimsOf(vendorId))
    .orderBy(asc(vendorRequests.createdAt), asc(vendorRequests.id));
  return rows.map((row) => ({
    id: row.id,
    submitter_name: row.submitterName,
    submitter_role: row.submitterRole,
    submitter_email: row.submitterEmail,
    submitter_linkedin_url: row.submitterLinkedinUrl,
    comments: row.body,
    created_at: row.createdAt,
    routed_to_owners_at: row.routedToOwnersAt!,
    context_product_name: row.contextProductName ?? null,
  }));
}

/** The start of `iso`'s UTC day, as an ISO string. */
export function utcDayStart(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

export interface RoutedClaim {
  requestId: string;
  vendorId: string;
  routedToOwnersAt: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  submitterLinkedinUrl: string | null;
  body: string;
  contextProductName: string | null;
}

export interface OwnerReviewResult {
  /** `bounded` when the per-vendor daily limit stopped the fan-out. */
  status: 'sent' | 'bounded' | 'no_owners' | 'error';
  emails: Partial<Record<EmailOutcome, number>>;
}

export interface OwnerReviewDeps {
  fetchSeatEmails?: FetchSeatEmails;
  sendEmail?: typeof sendClaimOwnerReviewEmail;
}

/** Email every unbanned owner seat of the claimed vendor. Never rejects. */
export async function emailOwnersOfRoutedClaim(
  c: EmailContext,
  db: Db,
  claim: RoutedClaim,
  deps: OwnerReviewDeps = {},
): Promise<OwnerReviewResult> {
  const send = deps.sendEmail ?? sendClaimOwnerReviewEmail;
  const emails: Partial<Record<EmailOutcome, number>> = {};
  try {
    const [today] = await db
      .select({ value: count() })
      .from(vendorRequests)
      .where(
        and(
          eq(vendorRequests.kind, 'claim'),
          eq(vendorRequests.targetType, 'vendor'),
          eq(vendorRequests.targetId, claim.vendorId),
          isNotNull(vendorRequests.routedToOwnersAt),
          gte(vendorRequests.routedToOwnersAt, utcDayStart(claim.routedToOwnersAt)),
        ),
      );
    // The count includes this claim, which committed before we ran.
    if ((today?.value ?? 0) > OWNER_REVIEW_DAILY_LIMIT) {
      log(c, 'warn', `aeci.claim.owner_review.bounded vendor=${claim.vendorId}`, claim);
      return { status: 'bounded', emails };
    }

    const owners = await loadVendorOwnerRecipients(db, c.env, claim.vendorId, deps.fetchSeatEmails);
    if (owners.length === 0) {
      log(c, 'info', `aeci.claim.owner_review.no_owner_address vendor=${claim.vendorId}`, claim);
      return { status: 'no_owners', emails };
    }
    const vendor = await db.query.vendors.findFirst({
      columns: { companyName: true, slug: true },
      where: eq(vendors.id, claim.vendorId),
    });

    // One connection at a time: sequential sends (a handful of owners).
    for (const owner of owners) {
      const outcome = await send(c, {
        to: owner.email,
        dedupeKey: ownerReviewKey(claim.requestId, owner.profileId),
        requestId: claim.requestId,
        vendorName: vendor?.companyName ?? '',
        vendorSlug: vendor?.slug ?? null,
        submitterEmail: claim.submitterEmail,
        submitterName: claim.submitterName,
        submitterRole: claim.submitterRole,
        submitterLinkedinUrl: claim.submitterLinkedinUrl,
        comments: claim.body,
        contextProductName: claim.contextProductName,
        decideBy: ownerReviewDeadline(claim.routedToOwnersAt),
      });
      emails[outcome] = (emails[outcome] ?? 0) + 1;
    }
    return { status: 'sent', emails };
  } catch (error) {
    log(
      c,
      'warn',
      `aeci.claim.owner_review.failed: ${error instanceof Error ? error.message : String(error)}`,
      claim,
    );
    return { status: 'error', emails };
  }
}

function log(
  c: EmailContext,
  level: 'info' | 'warn',
  message: string,
  claim: Pick<RoutedClaim, 'requestId' | 'vendorId'>,
): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level,
      message,
      source: 'claim-owner-routing',
      request_id: claim.requestId,
      vendor_id: claim.vendorId,
    });
  } catch {
    console.warn(`claim-owner-routing: ${message}`);
  }
}
